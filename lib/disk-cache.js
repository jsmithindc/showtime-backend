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

const CACHE_DIR = path.join(__dirname, "..", "cache");

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

function writeDiskCache(name, data) {
  try {
    if (!ensureCacheDir()) return;
    const file = path.join(CACHE_DIR, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ fetchedAt: Date.now(), data }));
  } catch {
    // Non-fatal -- memory cache still works
  }
}

module.exports = { readDiskCache, writeDiskCache };
