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

function runGit(args, cwd, secrets, timeoutMs = 20000, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        ...extraEnv,
      },
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
  if (lines.includes(".aidanos/")) return;
  const prefix = text.length > 0 && !text.endsWith("\n") ? text + "\n" : text;
  await fs.writeFile(file, prefix + ".aidanos/\n");
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

export async function backupOnce({ vault, gitUrl, gitToken, secrets }) {
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
  const name = process.env.AIDANOS_VAULT_GIT_NAME || "AidanOS";
  const email = process.env.AIDANOS_VAULT_GIT_EMAIL || "aidanos@local";
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
