import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { logSafe, redact } from "./redact.mjs";

// Git is a backup of the markdown. This module only commits and pushes.
// It does not pull, fetch, rebase, or force-push.

export function authenticatedGitUrl(url, token) {
  const rawUrl = String(url || "").trim();
  const rawToken = String(token || "").trim();
  if (!rawUrl || !rawToken) return rawUrl;
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.protocol !== "https:") return rawUrl;
  parsed.username = "x-access-token";
  parsed.password = rawToken;
  return parsed.href;
}

// SSH_AUTH_SOCK stays out. An SSH backup URL must not use the keys in the
// user's agent. Proxy and certificate variables are also left out; that is
// tracked in the relay README.
const GIT_ENV_KEYS = [
  "PATH",
  "HOME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GNUPGHOME",
];

// Git gets a fresh environment. A vault token sitting in this process is not copied across.
export function gitChildEnv(extra = {}) {
  const env = { GIT_TERMINAL_PROMPT: "0", GIT_EDITOR: "true" };
  for (const key of GIT_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key];
  }
  for (const [key, value] of Object.entries(extra)) {
    if (value != null && value !== "") env[key] = String(value);
  }
  return env;
}

function runGit(args, cwd, secrets, timeoutMs = 20000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: gitChildEnv(extraEnv),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (buf) => {
      out += String(buf);
    });
    child.stderr.on("data", (buf) => {
      err += String(buf);
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("git timeout"));
    }, timeoutMs);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out, err });
      else reject(new Error(redact((err || out || "git " + args[0] + " failed").trim(), secrets)));
    });
  });
}

async function ensureGitignore(vault) {
  const file = path.join(vault, ".gitignore");
  let text = "";
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    text = "";
  }
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const missing = [];
  if (!lines.includes(".aidanos/")) missing.push(".aidanos/");
  if (!lines.includes("*.recover")) missing.push("*.recover");
  if (missing.length) {
    const prefix = text.length > 0 && !text.endsWith("\n") ? text + "\n" : text;
    await fs.writeFile(file, prefix + missing.join("\n") + "\n");
  }
  await ensureRecoverExcluded(vault);
}

async function ensureRecoverExcluded(vault) {
  const gitLink = path.join(vault, ".git");
  let st;
  try {
    st = await fs.lstat(gitLink);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) return;
  let gitDir = gitLink;
  if (st.isFile()) {
    const text = await fs.readFile(gitLink, "utf8");
    const match = /^gitdir:\s*(.*)$/m.exec(text);
    if (!match) return;
    gitDir = path.resolve(vault, match[1].trim());
    let listed;
    try {
      listed = await fs.lstat(gitDir);
    } catch {
      return;
    }
    if (listed.isSymbolicLink() || !listed.isDirectory()) return;
  } else if (!st.isDirectory()) {
    return;
  }
  const info = path.join(gitDir, "info");
  const exclude = path.join(info, "exclude");
  let current = "";
  try {
    current = await fs.readFile(exclude, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") return;
  }
  if (current.split(/\r?\n/).some((line) => line.trim() === "*.recover")) return;
  await fs.mkdir(info, { recursive: true });
  const prefix = current.length > 0 && !current.endsWith("\n") ? current + "\n" : current;
  await fs.writeFile(exclude, prefix + "*.recover\n");
}

const ASKPASS = `#!/bin/sh
case "$1" in
  *[Uu]sername*) printf '%s\\n' "x-access-token" ;;
  *) printf '%s\\n' "$AIDANOS_GIT_ASKPASS_TOKEN" ;;
esac
`;

async function pushBranch(vault, url, token, branch, secrets) {
  const args = ["-c", "credential.helper=", "push", "origin", "HEAD:refs/heads/" + branch];
  if (!token || !/^https:\/\//i.test(url)) {
    await runGit(args, vault, secrets);
    return;
  }
  const askpass = path.join(os.tmpdir(), "aidanos-askpass-" + process.pid + "-" + Date.now());
  await fs.writeFile(askpass, ASKPASS, { mode: 0o700 });
  try {
    await runGit(args, vault, secrets, 20000, {
      GIT_ASKPASS: askpass,
      GIT_TERMINAL_PROMPT: "0",
      AIDANOS_GIT_ASKPASS_TOKEN: token,
    });
  } finally {
    await fs.rm(askpass, { force: true });
  }
}

export async function backupOnce({ vault, gitUrl, gitToken, secrets, env = process.env }) {
  const url = String(gitUrl || "").trim();
  if (!url) return { skipped: true, committed: false, pushed: false };
  const token = String(gitToken || "").trim();
  const hidden = secrets || [token, url];
  await fs.mkdir(vault, { recursive: true });
  await ensureGitignore(vault);
  const gitDir = path.join(vault, ".git");
  try {
    await fs.stat(gitDir);
  } catch {
    await runGit(["init", "-b", "main"], vault, hidden);
  }
  await ensureRecoverExcluded(vault);
  const name = env.AIDANOS_RELAY_GIT_NAME || "AidanOS";
  const email = env.AIDANOS_RELAY_GIT_EMAIL || "aidanos@local";
  await runGit(["config", "user.name", name], vault, hidden);
  await runGit(["config", "user.email", email], vault, hidden);
  // The remote URL stays clean. The token is only in the push process environment.
  try {
    await runGit(["remote", "set-url", "origin", url], vault, hidden);
  } catch {
    await runGit(["remote", "add", "origin", url], vault, hidden);
  }
  await runGit(["add", "-A", "--", "."], vault, hidden);
  const status = await runGit(["status", "--porcelain"], vault, hidden);
  if (!status.out.trim()) return { skipped: false, committed: false, pushed: false };
  await runGit(["commit", "-m", "Backup notes"], vault, hidden);
  const branch = ((await runGit(["branch", "--show-current"], vault, hidden)).out || "main").trim() || "main";
  try {
    await pushBranch(vault, url, token, branch, hidden);
  } catch (error) {
    logSafe(hidden, "git backup push failed:", error instanceof Error ? error.message : error);
    return { skipped: false, committed: true, pushed: false };
  }
  return { skipped: false, committed: true, pushed: true };
}
