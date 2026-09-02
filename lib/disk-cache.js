// Simple disk-backed cache for theater lists that survive Node process
// restarts within the same container (e.g. Render keeping the filesystem
// alive across sleep/wake cycles). Falls back gracefully if the cache
// directory can't be written (read-only filesystem, permissions, etc.).
//
// On Render free tier the filesystem is ephemeral across deployments, but
// may persist across sleep/wake cycles -- even a partial hit eliminates the
// cold-start proxy call for Regal (the most expensive fetch).

const fs = require("fs");
const path = require("path");
const fetch = require("node-fetch");

const CACHE_DIR = path.join(__dirname, "..", "cache");

// ---- Optional shared tier: Upstash Redis over HTTPS -------------------------
//
// The local file cache dies with the container. On Render that means every
// deploy throws away theater lists, geocodes, drive times and the day's
// already-fetched showtimes, and the next search re-earns all of it.
//
// Upstash is a good fit here specifically because it is HTTP: no connection
// pool, no TCP keepalive, nothing to manage across Render's sleep/wake. Set
// UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to enable; with them
// unset every function below behaves exactly as it did before.
//
// Reads go local-first (sync, instant) and only ask Redis on a miss, so the
// shared tier costs a round trip once per key per container, not per search.
// Writes go to both, but the Redis half is fire-and-forget -- a cache write
// must never add latency to a search.
const REDIS_TIMEOUT_MS = 2500;
// Upstash's free tier caps a request at 1MB. Nothing here should approach that;
// if something does, it stays local rather than failing the write.
const MAX_REDIS_BYTES = 400_000;
const REDIS_MAX_TTL_SEC = 90 * 24 * 60 * 60;

const warned = new Set();
function warnOnce(key, message) {
  if (warned.has(key)) return;
  warned.add(key);
  console.error(message);
}

function redisConfigured() {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

function redisKey(name) {
  return `showtime:${name}`;
}

async function redisCommand(args) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REDIS_TIMEOUT_MS);
  try {
    const res = await fetch(process.env.UPSTASH_REDIS_REST_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`upstash HTTP ${res.status}`);
    const json = await res.json();
    if (json && json.error) throw new Error(`upstash: ${json.error}`);
    return json ? json.result : null;
  } finally {
    clearTimeout(timer);
  }
}

function ensureCacheDir() {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

function readDiskCache(name, ttlMs) {
  try {
    const file = path.join(CACHE_DIR, `${name}.json`);
    if (!fs.existsSync(file)) return null;
    const { fetchedAt, data } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Date.now() - fetchedAt > ttlMs) return null;
    return data;
  } catch {
    return null;
  }
}

// fetchedAt is overridable so a value promoted from the shared tier keeps its
// ORIGINAL age. Stamping it with now() would let a stale entry live forever by
// hopping between containers, each one resetting its clock.
function writeDiskCache(name, data, fetchedAt = Date.now()) {
  try {
    if (!ensureCacheDir()) return;
    const file = path.join(CACHE_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt, data }));
  } catch {
    // Non-fatal -- memory cache still works
  }
}

/**
 * Read through local file -> shared Redis. Async because of the Redis leg;
 * a local hit still resolves without any network work.
 */
async function readCache(name, ttlMs) {
  const local = readDiskCache(name, ttlMs);
  if (local !== null) return local;
  if (!redisConfigured()) return null;
  try {
    const raw = await redisCommand(["GET", redisKey(name)]);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || parsed.fetchedAt == null) return null;
    if (Date.now() - parsed.fetchedAt > ttlMs) return null;
    // Promote into the local file so the rest of this container's life is
    // sync and free -- Redis is asked once per key per container, not per call.
    writeDiskCache(name, parsed.data, parsed.fetchedAt);
    return parsed.data;
  } catch (err) {
    warnOnce(`read:${err.message}`, `Shared cache: read failed (${err.message}) -- falling back to local only.`);
    return null;
  }
}

/**
 * Write to the local file (synchronously, as before) and to Redis
 * (fire-and-forget). Deliberately NOT awaited by callers: persisting a cache
 * entry must never sit on a search's critical path.
 */
function writeCache(name, data, ttlMs) {
  writeDiskCache(name, data);
  if (!redisConfigured()) return;
  let payload;
  try {
    payload = JSON.stringify({ fetchedAt: Date.now(), data });
  } catch {
    return; // not serialisable -- local copy already written
  }
  if (payload.length > MAX_REDIS_BYTES) {
    warnOnce(`size:${name}`, `Shared cache: "${name}" is ${payload.length} bytes, above the ${MAX_REDIS_BYTES} limit -- keeping it local only.`);
    return;
  }
  const ttlSec = Math.min(REDIS_MAX_TTL_SEC, Math.max(60, Math.ceil((ttlMs || 0) / 1000)));
  redisCommand(["SET", redisKey(name), payload, "EX", ttlSec]).catch((err) => {
    warnOnce(`write:${err.message}`, `Shared cache: write failed (${err.message}) -- local cache still works.`);
  });
}

module.exports = { readDiskCache, writeDiskCache, readCache, writeCache, redisConfigured };
