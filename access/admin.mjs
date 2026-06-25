// kofem-access admin CLI — manual approval for the closed beta.
//
//   docker compose exec kofem-access node admin.mjs requests
//   docker compose exec kofem-access node admin.mjs grant alice@example.com
//   docker compose exec kofem-access node admin.mjs revoke alice@example.com
//   docker compose exec kofem-access node admin.mjs list
//
// `grant` prints the plaintext code ONCE — only its sha256 is stored, so email
// it to the tester before closing the terminal. `revoke` matches by email or by
// the code itself.

import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DATA_DIR = process.env.KOFEM_DATA_DIR || "/data";
const CODES_FILE = join(DATA_DIR, "codes.json");
const REQUESTS_FILE = join(DATA_DIR, "requests.jsonl");

const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

function loadCodes() {
  if (!existsSync(CODES_FILE)) return { codes: [] };
  const parsed = JSON.parse(readFileSync(CODES_FILE, "utf8"));
  if (!Array.isArray(parsed.codes)) parsed.codes = [];
  return parsed;
}

function saveCodes(data) {
  writeFileSync(CODES_FILE, JSON.stringify(data, null, 2) + "\n");
}

// Crockford-ish base32 (no I/L/O/U) — 16 random bytes = 128 bits of entropy,
// grouped for readability: KOFEM-XXXX-XXXX-XXXX-XXXX-XXXX...
function mintCode() {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let s = "";
  for (const b of randomBytes(20)) s += alphabet[b & 31];
  const groups = s.slice(0, 20).match(/.{4}/g).join("-");
  return `KOFEM-${groups}`;
}

function grant(email) {
  if (!email) fail("usage: grant <email>");
  const data = loadCodes();
  const code = mintCode();
  data.codes.push({
    hash: sha256hex(code),
    email: email.toLowerCase(),
    createdAt: new Date().toISOString(),
    revoked: false,
  });
  saveCodes(data);
  console.log(`Granted access to ${email}`);
  console.log("");
  console.log(`  Access code: ${code}`);
  console.log("");
  console.log(
    "Send this code to the tester (it is shown only once). They enter",
  );
  console.log("it at  https://<your-domain>/beta/  to unlock the app.");
}

function revoke(arg) {
  if (!arg) fail("usage: revoke <email|code>");
  const data = loadCodes();
  const hash = sha256hex(arg);
  const email = arg.toLowerCase();
  let n = 0;
  for (const c of data.codes) {
    if (!c.revoked && (c.email === email || c.hash === hash)) {
      c.revoked = true;
      c.revokedAt = new Date().toISOString();
      n++;
    }
  }
  saveCodes(data);
  console.log(`Revoked ${n} code(s) matching "${arg}".`);
}

function list() {
  const active = loadCodes().codes.filter((c) => !c.revoked);
  if (!active.length) return console.log("No active codes.");
  console.log(
    "Active beta codes (the code itself is not stored — only its hash):",
  );
  for (const c of active) console.log(`  ${c.email}\t${c.createdAt}`);
}

function requests() {
  if (!existsSync(REQUESTS_FILE)) return console.log("No requests yet.");
  const granted = new Set(loadCodes().codes.map((c) => c.email));
  const lines = readFileSync(REQUESTS_FILE, "utf8").split("\n").filter(Boolean);
  if (!lines.length) return console.log("No requests yet.");
  console.log("Access requests:");
  for (const line of lines) {
    const { email, ts } = JSON.parse(line);
    console.log(
      `  ${granted.has(email) ? "[granted]" : "[pending]"} ${email}\t${ts}`,
    );
  }
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [cmd, arg] = process.argv.slice(2);
switch (cmd) {
  case "grant":
    grant(arg);
    break;
  case "revoke":
    revoke(arg);
    break;
  case "list":
    list();
    break;
  case "requests":
    requests();
    break;
  default:
    fail("commands: requests | grant <email> | revoke <email|code> | list");
}
