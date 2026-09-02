const { execFileSync } = require("child_process");
const path = require("path");

// CalVer: the version IS the date the deployed code was committed, e.g.
// "2026.09.02". Chosen over semver because nothing depends on this app, so
// there is no compatibility contract for a major/minor/patch split to
// communicate -- the only questions a version answers here are "what is running"
// and "how old is it", and a date answers both directly.
//
// Resolved ONCE at boot, never hand-edited. The old hand-typed badge went stale
// silently whenever a bump was forgotten, which defeats the only purpose it
// had; that risk is worst on a project that ships rarely, since nobody notices
// a number that has not moved.
//
// Resolution order, first hit wins:
//   1. APP_VERSION            -- explicit override, for hosts with no git
//   2. git commit date        -- the real answer wherever a checkout exists
//   3. package.json version   -- last-resort constant

let cached = null;

function fromGit() {
  try {
    const repoRoot = path.join(__dirname, "..");
    const date = execFileSync(
      "git",
      ["log", "-1", "--format=%cd", "--date=format:%Y.%m.%d"],
      { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 3000 }
    ).trim();
    return /^\d{4}\.\d{2}\.\d{2}$/.test(date) ? date : null;
  } catch {
    return null; // no git binary, or no checkout (a plain image build)
  }
}

function shortCommit() {
  // Render exposes the deployed SHA; fall back to asking git directly.
  const fromEnv = process.env.RENDER_GIT_COMMIT || process.env.SOURCE_VERSION;
  if (fromEnv) return String(fromEnv).slice(0, 7);
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: path.join(__dirname, ".."),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 3000,
    }).trim() || null;
  } catch {
    return null;
  }
}

function getVersion() {
  if (cached) return cached;
  const version =
    process.env.APP_VERSION ||
    fromGit() ||
    (() => {
      try { return require("../package.json").version; } catch { return "unknown"; }
    })();
  cached = { version, commit: shortCommit() };
  return cached;
}

module.exports = { getVersion };
