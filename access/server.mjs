// kofem-access — tiny zero-dependency service for the closed beta.
//
// Two jobs:
//   1. Capture "Request access" submissions from the landing page to disk.
//   2. Back the password gate on /app/ (login + the nginx auth_request check).
//
// The gate accepts a master password (env KOFEM_BETA_MASTER, never written to
// disk) OR any non-revoked individual code (codes.json, managed by admin.mjs).
// The cookie value IS the code: it is re-validated on every request, so a
// revoke takes effect immediately. Same exposure model as HTTP Basic Auth, but
// with a single-field styled gate page and no username.

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  appendFileSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
} from "node:fs";
import { join } from "node:path";

const PORT = Number(process.env.PORT || 8080);
const DATA_DIR = process.env.KOFEM_DATA_DIR || "/data";
const MASTER = process.env.KOFEM_BETA_MASTER || "";
const COOKIE = "kofem_beta";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
const REQUESTS_FILE = join(DATA_DIR, "requests.jsonl");
const CODES_FILE = join(DATA_DIR, "codes.json");
const MAX_BODY = 4096;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// --- storage -------------------------------------------------------------

function ensureStorage() {
  mkdirSync(DATA_DIR, { recursive: true });
  if (!existsSync(CODES_FILE)) writeFileSync(CODES_FILE, '{"codes":[]}\n');
  if (!existsSync(REQUESTS_FILE)) writeFileSync(REQUESTS_FILE, "");
}

// codes.json is small and edited out-of-band by admin.mjs; cache it and reload
// only when the file's mtime changes so grants/revokes apply without a restart.
let codesCache = { mtimeMs: -1, codes: [] };
function loadCodes() {
  try {
    const { mtimeMs } = statSync(CODES_FILE);
    if (mtimeMs !== codesCache.mtimeMs) {
      const parsed = JSON.parse(readFileSync(CODES_FILE, "utf8"));
      codesCache = {
        mtimeMs,
        codes: Array.isArray(parsed.codes) ? parsed.codes : [],
      };
    }
  } catch (err) {
    console.error(`[access] failed to read ${CODES_FILE}: ${err.message}`);
    codesCache = { mtimeMs: -1, codes: [] };
  }
  return codesCache.codes;
}

const sha256 = (s) => createHash("sha256").update(String(s)).digest();
const sha256hex = (s) => createHash("sha256").update(String(s)).digest("hex");

function safeEqual(a, b) {
  // Compare fixed-length digests so length never leaks and timing is constant.
  return timingSafeEqual(sha256(a), sha256(b));
}

function isValidCode(code) {
  if (!code) return false;
  if (MASTER && safeEqual(code, MASTER)) return true;
  const hash = sha256hex(code);
  return loadCodes().some((c) => !c.revoked && c.hash === hash);
}

// --- http helpers --------------------------------------------------------

function getIp(req) {
  return (
    req.headers["cf-connecting-ip"] ||
    String(req.headers["x-forwarded-for"] || "")
      .split(",")[0]
      .trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1)
      out[part.slice(0, i).trim()] = decodeURIComponent(
        part.slice(i + 1).trim(),
      );
  }
  return out;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseFields(body, contentType = "") {
  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(body || "{}");
    } catch {
      return {};
    }
  }
  return Object.fromEntries(new URLSearchParams(body));
}

function json(res, status, obj, extraHeaders = {}) {
  const payload = JSON.stringify(obj);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

// Sliding-window per-IP rate limiter, one bucket per name.
const buckets = new Map();
function rateLimited(name, ip, max, windowMs) {
  const key = `${name}:${ip}`;
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length > max;
}

// --- routes --------------------------------------------------------------

async function handleRequestAccess(req, res) {
  const ip = getIp(req);
  if (rateLimited("request", ip, 5, 10 * 60 * 1000))
    return json(res, 429, { ok: false, error: "rate_limited" });

  const fields = parseFields(await readBody(req), req.headers["content-type"]);
  // Honeypot: bots fill hidden fields. Pretend success, store nothing.
  if (fields.website || fields.company) return json(res, 200, { ok: true });

  const email = String(fields.email || "")
    .trim()
    .toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254)
    return json(res, 400, { ok: false, error: "invalid_email" });

  const seen = readFileSync(REQUESTS_FILE, "utf8");
  if (!seen.includes(`"${email}"`)) {
    appendFileSync(
      REQUESTS_FILE,
      JSON.stringify({ email, ts: new Date().toISOString() }) + "\n",
    );
  }
  return json(res, 200, { ok: true });
}

async function handleLogin(req, res) {
  const ip = getIp(req);
  if (rateLimited("login", ip, 10, 10 * 60 * 1000))
    return json(res, 429, { ok: false, error: "rate_limited" });

  const fields = parseFields(await readBody(req), req.headers["content-type"]);
  const code = String(fields.code || "").trim();
  if (!isValidCode(code))
    return json(res, 401, { ok: false, error: "invalid_code" });

  const cookie = `${COOKIE}=${encodeURIComponent(code)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`;
  return json(res, 200, { ok: true }, { "set-cookie": cookie });
}

function handleVerify(req, res) {
  if (isValidCode(parseCookies(req)[COOKIE])) {
    res.writeHead(204);
    res.end();
  } else {
    res.writeHead(401);
    res.end();
  }
}

function handleLogout(req, res) {
  res.writeHead(204, {
    "set-cookie": `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
  });
  res.end();
}

// --- server --------------------------------------------------------------

ensureStorage();
if (!MASTER) {
  console.warn(
    "[access] KOFEM_BETA_MASTER is not set — master login disabled; only individual codes will work",
  );
}

const server = createServer(async (req, res) => {
  const { method } = req;
  const path = req.url.split("?")[0];
  try {
    if (method === "GET" && path === "/healthz")
      return json(res, 200, { ok: true });
    if (method === "POST" && path === "/api/request-access")
      return await handleRequestAccess(req, res);
    if (method === "POST" && path === "/api/beta/login")
      return await handleLogin(req, res);
    if (method === "GET" && path === "/api/beta/verify")
      return handleVerify(req, res);
    if (method === "POST" && path === "/api/beta/logout")
      return handleLogout(req, res);
    return json(res, 404, { ok: false, error: "not_found" });
  } catch (err) {
    const status = err.message === "body too large" ? 413 : 500;
    return json(res, status, { ok: false, error: err.message });
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[access] listening on :${PORT}, data dir ${DATA_DIR}`);
});
