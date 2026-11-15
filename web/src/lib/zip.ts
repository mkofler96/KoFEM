// SPDX-FileCopyrightText: 2026 Michael Kofler
// SPDX-License-Identifier: AGPL-3.0-or-later

// A minimal ZIP writer and reader for problem reports (lib/bugReport.ts). It
// covers what a report needs and no more: a handful of files, each under
// 4 GiB, compressed with raw DEFLATE through the browser's CompressionStream.
// The reader accepts stored and deflated entries and checks every CRC; it
// refuses encryption, ZIP64 and archives spanning several disks.

export interface ZipEntry {
  readonly name: string;
  readonly data: Uint8Array;
}

const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const LOCAL_HEADER = 30;
const CENTRAL_HEADER = 46;
const END_RECORD = 22;
const STORED = 0;
const DEFLATED = 8;
// General purpose flag bit 11: the file name is UTF-8.
const UTF8_FLAG = 0x0800;
const ENCRYPTED_FLAG = 0x0001;
const VERSION = 20;
const MAX_U32 = 0xffffffff;
const MAX_U16 = 0xffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[n] = value >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

async function transform(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  // A copy into a fresh ArrayBuffer: the Blob constructor takes no view on a
  // SharedArrayBuffer.
  const piped = new Blob([new Uint8Array(data)]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(piped).arrayBuffer());
}

// DOS date and time, local time, two-second resolution.
function dosDateTime(date: Date): { time: number; date: number } {
  const year = Math.min(Math.max(date.getFullYear(), 1980), 2107);
  return {
    time:
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Pack the entries into a ZIP archive. Each entry is deflated when that makes
 * it smaller and stored otherwise.
 */
export async function createZip(
  entries: readonly ZipEntry[],
  modified: Date,
): Promise<Uint8Array> {
  if (typeof CompressionStream === "undefined")
    throw new Error(
      "this browser cannot create ZIP files (it has no CompressionStream) — update it, or use a current Chrome, Edge, Firefox or Safari",
    );
  const encoder = new TextEncoder();
  const stamp = dosDateTime(modified);
  const names = new Set<string>();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    if (
      entry.name === "" ||
      entry.name.startsWith("/") ||
      names.has(entry.name)
    )
      throw new Error(
        `createZip: "${entry.name}" is not a usable entry name (empty, absolute or repeated)`,
      );
    names.add(entry.name);
    const name = encoder.encode(entry.name);
    if (name.length > MAX_U16)
      throw new Error(`createZip: the entry name "${entry.name}" is too long`);
    const crc = crc32(entry.data);
    const deflated = await transform(
      entry.data,
      new CompressionStream("deflate-raw"),
    );
    const useDeflate = deflated.length < entry.data.length;
    const body = useDeflate ? deflated : entry.data;
    if (entry.data.length > MAX_U32 || offset > MAX_U32)
      throw new Error(
        `createZip: "${entry.name}" does not fit a ZIP without ZIP64 (over 4 GiB)`,
      );

    const local = new Uint8Array(LOCAL_HEADER + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, LOCAL_SIG, true);
    lv.setUint16(4, VERSION, true);
    lv.setUint16(6, UTF8_FLAG, true);
    lv.setUint16(8, useDeflate ? DEFLATED : STORED, true);
    lv.setUint16(10, stamp.time, true);
    lv.setUint16(12, stamp.date, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, body.length, true);
    lv.setUint32(22, entry.data.length, true);
    lv.setUint16(26, name.length, true);
    lv.setUint16(28, 0, true);
    local.set(name, LOCAL_HEADER);

    const record = new Uint8Array(CENTRAL_HEADER + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, CENTRAL_SIG, true);
    cv.setUint16(4, VERSION, true);
    cv.setUint16(6, VERSION, true);
    cv.setUint16(8, UTF8_FLAG, true);
    cv.setUint16(10, useDeflate ? DEFLATED : STORED, true);
    cv.setUint16(12, stamp.time, true);
    cv.setUint16(14, stamp.date, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, body.length, true);
    cv.setUint32(24, entry.data.length, true);
    cv.setUint16(28, name.length, true);
    // Extra field, comment, disk number, internal and external attributes: 0.
    cv.setUint32(42, offset, true);
    record.set(name, CENTRAL_HEADER);

    parts.push(local, body);
    central.push(record);
    offset += local.length + body.length;
  }
  if (entries.length > MAX_U16)
    throw new Error("createZip: too many entries for a ZIP without ZIP64");

  const centralSize = central.reduce((n, r) => n + r.length, 0);
  const end = new Uint8Array(END_RECORD);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, END_SIG, true);
  ev.setUint16(8, entries.length, true);
  ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);

  const out = new Uint8Array(offset + centralSize + END_RECORD);
  let at = 0;
  for (const part of [...parts, ...central, end]) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** True when the bytes start like a ZIP archive (a local file header). */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) ===
      LOCAL_SIG
  );
}

/** Unpack a ZIP archive into its entries, in central-directory order. */
export async function readZip(bytes: Uint8Array): Promise<ZipEntry[]> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record sits at the end, followed only by a comment of at most
  // 64 KiB.
  let endAt = -1;
  const lowest = Math.max(0, bytes.length - END_RECORD - MAX_U16);
  for (let i = bytes.length - END_RECORD; i >= lowest; i--)
    if (view.getUint32(i, true) === END_SIG) {
      endAt = i;
      break;
    }
  if (endAt < 0) throw new Error("not a ZIP archive (no end record)");
  if (
    view.getUint16(endAt + 4, true) !== 0 ||
    view.getUint16(endAt + 6, true) !== 0
  )
    throw new Error("multi-disk ZIP archives are not supported");
  const count = view.getUint16(endAt + 10, true);
  const centralSize = view.getUint32(endAt + 12, true);
  const centralAt = view.getUint32(endAt + 16, true);
  if (centralAt === MAX_U32 || count === MAX_U16)
    throw new Error("ZIP64 archives are not supported");
  if (centralAt + centralSize > endAt)
    throw new Error("the ZIP central directory lies outside the file");

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: ZipEntry[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (at + CENTRAL_HEADER > endAt || view.getUint32(at, true) !== CENTRAL_SIG)
      throw new Error(`ZIP entry ${i + 1}: broken central directory record`);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = decoder.decode(
      bytes.subarray(at + CENTRAL_HEADER, at + CENTRAL_HEADER + nameLength),
    );
    at += CENTRAL_HEADER + nameLength + extraLength + commentLength;

    if (flags & ENCRYPTED_FLAG)
      throw new Error(`ZIP entry "${name}" is encrypted`);
    if (method !== STORED && method !== DEFLATED)
      throw new Error(
        `ZIP entry "${name}" uses compression method ${method}; only stored and deflated entries are supported`,
      );
    if (
      localAt + LOCAL_HEADER > centralAt ||
      view.getUint32(localAt, true) !== LOCAL_SIG
    )
      throw new Error(`ZIP entry "${name}": broken local header`);
    const dataAt =
      localAt +
      LOCAL_HEADER +
      view.getUint16(localAt + 26, true) +
      view.getUint16(localAt + 28, true);
    if (dataAt + compressedSize > centralAt)
      throw new Error(`ZIP entry "${name}" runs past the end of the data`);
    const raw = bytes.subarray(dataAt, dataAt + compressedSize);
    if (method === DEFLATED && typeof DecompressionStream === "undefined")
      throw new Error(
        "this browser cannot read compressed ZIP files (it has no DecompressionStream) — update it",
      );
    const data =
      method === STORED
        ? raw.slice()
        : await transform(raw, new DecompressionStream("deflate-raw"));
    if (data.length !== size)
      throw new Error(
        `ZIP entry "${name}" unpacks to ${data.length} bytes, not the ${size} recorded`,
      );
    if (crc32(data) !== crc)
      throw new Error(`ZIP entry "${name}" is damaged (checksum mismatch)`);
    entries.push({ name, data });
  }
  return entries;
}
