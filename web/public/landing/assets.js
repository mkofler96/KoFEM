// The generator gzips the .bin assets itself, so they arrive compressed from any
// static host. A server that adds Content-Encoding hands over the plain bytes.
export async function fetchJson(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${url} returned HTTP ${response.status}`);
  return response.json();
}

export async function fetchBinary(url) {
  const response = await fetch(url);
  if (!response.ok) throw Error(`${url} returned HTTP ${response.status}`);
  const bytes = await response.arrayBuffer();
  const header = new Uint8Array(bytes, 0, 2);
  if (header[0] !== 0x1f || header[1] !== 0x8b) return bytes;
  return new Response(
    new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip")),
  ).arrayBuffer();
}

const arrayTypes = { Float32Array, Uint32Array, Uint16Array, Int16Array };

// Quantized arrays carry the scale that maps them back to floats.
export function typedArray(buffer, info) {
  const Type = arrayTypes[info.type];
  if (!Type) throw Error(`Unsupported binary layout type ${info.type}`);
  const array = new Type(buffer, info.offset, info.length);
  return info.scale === undefined
    ? array
    : Float32Array.from(array, (value) => value * info.scale);
}
