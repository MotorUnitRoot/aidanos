import { spawn } from "node:child_process";
import fs from "node:fs/promises";
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

function runGit(args, cwd, secrets, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
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

export async function backupOnce({ vault, gitUrl, gitToken, secrets }) {
  const url = String(gitUrl || "").trim();
  if (!url) return { skipped: true, committed: false, pushed: false };
  const token = String(gitToken || "").trim();
  const hidden = secrets || [token, url, authenticatedGitUrl(url, token)];
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
  const remote = authenticatedGitUrl(url, token);
  try {
    await runGit(["remote", "set-url", "origin", remote], vault, hidden);
  } catch {
    await runGit(["remote", "add", "origin", remote], vault, hidden);
  }
  await runGit(["add", "-A", "--", "."], vault, hidden);
  const status = await runGit(["status", "--porcelain"], vault, hidden);
  if (!status.out.trim()) return { skipped: false, committed: false, pushed: false };
  await runGit(["commit", "-m", "Backup notes"], vault, hidden);
  const branch = ((await runGit(["branch", "--show-current"], vault, hidden)).out || "main").trim() || "main";
  try {
    await runGit(["push", "origin", "HEAD:refs/heads/" + branch], vault, hidden);
  } catch (error) {
    logSafe(hidden, "git backup push failed:", error instanceof Error ? error.message : error);
    return { skipped: false, committed: true, pushed: false };
  }
  return { skipped: false, committed: true, pushed: true };
}
