#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
const docker = fs.readFileSync(path.join(root, "Dockerfile"), "utf8");
const dockerignore = fs.readFileSync(path.join(root, ".dockerignore"), "utf8");
const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
function check(name, run) {
  try {
    const out = run();
    if (out && typeof out.then === "function") {
      return out.then(() => {
        results.push({ name, ok: true });
        console.log("pass  " + name);
      }).catch((err) => {
        results.push({ name, ok: false, error: err.message });
        console.log("FAIL  " + name + "  " + err.message);
      });
    }
    results.push({ name, ok: true });
    console.log("pass  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log("FAIL  " + name + "  " + err.message);
  }
}

check("source still defaults to loopback and honors Cloud Run host/port", () => {
  assert(/process\.env\.AIDANOS_HOST \|\| "127\.0\.0\.1"/.test(serverSrc), "HOST default");
  assert(/process\.env\.PORT/.test(serverSrc) && /3847/.test(serverSrc), "PORT default");
  assert(/safeJoin/.test(serverSrc) && /realpath/.test(serverSrc), "vault realpath");
  assert(/MAX_BODY/.test(serverSrc), "body cap");
  assert(/PUBLIC_FILES/.test(serverSrc), "static allowlist");
  assert(/X-Content-Type-Options/.test(serverSrc), "nosniff");
});

check("Dockerfile does not run as root and still binds 0.0.0.0 for Cloud Run", () => {
  assert(/USER node/.test(docker), "non-root user");
  assert(/AIDANOS_HOST=0\.0\.0\.0/.test(docker), "Cloud Run host");
  assert(/ENV PORT=8080/.test(docker), "Cloud Run port");
  assert(!/COPY \. \./.test(docker), "no broad COPY");
  assert(/apt-get install[^\n]*git/.test(docker), "git in image for vault clone");
  assert(/COPY vault \.\/vault/.test(docker), "image ships bundled sample vault");
});

check("git vault sync is env-gated and does not invent a second write ABI", () => {
  assert(/AIDANOS_VAULT_GIT_URL/.test(serverSrc), "git url env");
  assert(/AIDANOS_VAULT_GIT_TOKEN/.test(serverSrc), "git token env");
  assert(/GITHUB_TOKEN/.test(serverSrc), "GITHUB_TOKEN fallback");
  assert(/authenticatedGitUrl/.test(serverSrc), "https token url shaping");
  assert(/x-access-token/.test(serverSrc), "github userinfo username");
  assert(!/http\.extraHeader/.test(serverSrc), "do not use extraHeader bearer");
  assert(!/Authorization: Bearer/.test(serverSrc), "do not send bearer extraHeader");
  assert(/scheduleVaultSync/.test(serverSrc), "commit after write");
  assert(/error:\s*"disk newer"/.test(serverSrc), "409 still disk newer");
  assert(/seedBundledVault/.test(serverSrc), "seed bundled sample when clone/pull cannot populate");
  assert(/BUNDLED_VAULT/.test(serverSrc) || /path\.join\(__dirname,\s*"vault"\)/.test(serverSrc), "bundled vault beside server");
});

check("dockerignore keeps tests and git out of a future broad COPY", () => {
  assert(/^\.git$/m.test(dockerignore) || dockerignore.includes(".git"), ".git ignored");
  assert(dockerignore.includes("*-test.mjs"), "tests ignored");
});

check("npm test only names files that exist", () => {
  const script = pkg.scripts.test;
  const files = [...script.matchAll(/node\s+(\S+)/g)].map((m) => m[1]);
  assert(files.length > 0, "has tests");
  for (const file of files) {
    assert(fs.existsSync(path.join(root, file)), "missing " + file);
  }
});

async function waitHealth(base, child) {
  const deadline = Date.now() + 8000;
  let last = "";
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error("server exited " + child.exitCode + " " + last);
    }
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) return res;
    } catch (e) {
      last = String(e.message || e);
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  throw new Error("health timeout " + last);
}

async function liveVaultAbi() {
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-abi-"));
  const outside = path.join(os.tmpdir(), "aidanos-abi-secret-" + process.pid + ".md");
  fs.mkdirSync(path.join(vault, "maps"), { recursive: true });
  fs.mkdirSync(path.join(vault, "log"), { recursive: true });
  fs.mkdirSync(path.join(vault, "aidanos"), { recursive: true });
  fs.writeFileSync(path.join(vault, "maps", "safe.md"), "inside the vault\n", "utf8");
  fs.writeFileSync(outside, "SECRET_OUTSIDE\n", "utf8");
  fs.symlinkSync(outside, path.join(vault, "maps", "leak.md"));

  const port = 19000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AIDANOS_HOST: "127.0.0.1",
      AIDANOS_VAULT: vault,
      AIDANOS_VAULT_GIT_URL: "",
      AIDANOS_VAULT_GIT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let errOut = "";
  child.stderr.on("data", (buf) => { errOut += String(buf); });
  child.stdout.on("data", (buf) => { errOut += String(buf); });
  const base = "http://127.0.0.1:" + port;
  const step = async (name, fn) => {
    try {
      return await fn();
    } catch (e) {
      throw new Error(name + ": " + (e && e.message || e) + (errOut ? " :: " + errOut.slice(-400) : ""));
    }
  };
  try {
    const healthRes = await step("health", () => waitHealth(base, child));
    const health = await healthRes.json();
    assert(health.ok === true, "health ok");
    assert(!Object.prototype.hasOwnProperty.call(health, "vault"), "health must not name the vault path");
    assert(!JSON.stringify(health).includes(vault), "health body must not leak the vault path");
    assert(health.git && health.git.enabled === false, "git off when env unset");
    assert(healthRes.headers.get("x-content-type-options") === "nosniff", "nosniff");
    assert(healthRes.headers.get("x-frame-options") === "DENY", "frame deny");

    const okFile = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/safe.md"));
    assert(okFile.ok, "read a vault markdown file");
    const okBody = await okFile.json();
    assert(okBody.markdown.includes("inside the vault"), "vault read");

    const escapes = [
      "../../etc/passwd",
      "%2e%2e/%2e%2e/etc/passwd",
      "..\\..\\etc\\passwd",
    ];
    for (const rel of escapes) {
      const res = await fetch(base + "/api/file?path=" + rel);
      assert(res.status === 400, "traversal " + rel + " got " + res.status);
      const body = await res.text();
      assert(!body.includes("SECRET_OUTSIDE"), "traversal must not read outside");
    }
    const abs = await fetch(base + "/api/file?path=" + encodeURIComponent("/etc/passwd"));
    assert(abs.status === 400 || abs.status === 404, "absolute path got " + abs.status);

    const leak = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/leak.md"));
    assert(leak.status === 400, "symlink out of vault got " + leak.status);
    const leakBody = await leak.text();
    assert(!leakBody.includes("SECRET_OUTSIDE"), "symlink must not leak outside file");

    const putLeak = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/leak.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "overwrite\n", mtime: 0 }),
    });
    assert(putLeak.status === 400, "symlink write got " + putLeak.status);
    assert(fs.readFileSync(outside, "utf8") === "SECRET_OUTSIDE\n", "outside file left alone");

    const tree = await fetch(base + "/api/tree?dir=" + encodeURIComponent(".."));
    assert(tree.status === 400, "tree .. got " + tree.status);

    const kernel = await fetch(base + "/api/file?path=" + encodeURIComponent("aidanos/skin.css"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "x { }", mtime: 0 }),
    });
    assert(kernel.status === 400, "kernel write blocked");

    const csrf = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/safe.md"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "https://evil.example",
      },
      body: JSON.stringify({ markdown: "pwned\n", mtime: 0 }),
    });
    assert(csrf.status === 403, "cross-site write got " + csrf.status);
    assert(fs.readFileSync(path.join(vault, "maps", "safe.md"), "utf8") === "inside the vault\n", "csrf left the file");

    const sameOrigin = await fetch(base + "/api/file?path=" + encodeURIComponent("maps/safe.md"), {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Origin: "http://127.0.0.1:" + port,
      },
      body: JSON.stringify({ markdown: "still inside\n" }),
    });
    assert(sameOrigin.ok, "same-origin write " + sameOrigin.status);
    assert(fs.readFileSync(path.join(vault, "maps", "safe.md"), "utf8") === "still inside\n", "same-origin saved");

    const dayDate = "2026-09-06";
    const firstDay = await fetch(base + "/api/day?date=" + dayDate, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ date: dayDate, markdown: "one\n", paper: "one\n" }),
    });
    assert(firstDay.ok, "create day " + firstDay.status);
    const firstDayBody = await firstDay.json();
    assert(typeof firstDayBody.mtime === "number", "day put mtime");
    const logPath = path.join(vault, "log", dayDate + ".md");
    fs.writeFileSync(logPath, "two\n", "utf8");
    const daySt = fs.statSync(logPath);
    fs.utimesSync(logPath, daySt.atime, new Date(daySt.mtimeMs + 25));
    const dayConflict = await fetch(base + "/api/day?date=" + dayDate, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        date: dayDate,
        markdown: "three\n",
        paper: "three\n",
        mtime: firstDayBody.mtime,
      }),
    });
    assert(dayConflict.status === 409, "stale day put got " + dayConflict.status);
    const dayConflictBody = await dayConflict.json();
    assert(dayConflictBody.error === "disk newer", "day 409 error");
    assert(dayConflictBody.date === dayDate, "day 409 date");
    assert(dayConflictBody.markdown === "two\n", "day 409 returns disk markdown");
    assert(typeof dayConflictBody.mtime === "number" && dayConflictBody.mtime > firstDayBody.mtime, "day 409 mtime");
    assert(fs.readFileSync(logPath, "utf8") === "two\n", "409 must not overwrite the day");

    const fileRel = "maps/safe.md";
    const firstFile = await fetch(base + "/api/file?path=" + encodeURIComponent(fileRel));
    const firstFileBody = await firstFile.json();
    fs.writeFileSync(path.join(vault, "maps", "safe.md"), "theirs on disk\n", "utf8");
    const fileSt = fs.statSync(path.join(vault, "maps", "safe.md"));
    fs.utimesSync(path.join(vault, "maps", "safe.md"), fileSt.atime, new Date(fileSt.mtimeMs + 25));
    const fileConflict = await fetch(base + "/api/file?path=" + encodeURIComponent(fileRel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        path: fileRel,
        markdown: "mine\n",
        paper: "mine\n",
        mtime: firstFileBody.mtime,
      }),
    });
    assert(fileConflict.status === 409, "stale file put got " + fileConflict.status);
    const fileConflictBody = await fileConflict.json();
    assert(fileConflictBody.error === "disk newer", "file 409 error");
    assert(fileConflictBody.path === fileRel, "file 409 path");
    assert(fileConflictBody.markdown === "theirs on disk\n", "file 409 returns disk markdown");
    assert(typeof fileConflictBody.mtime === "number", "file 409 mtime");
    assert(fs.readFileSync(path.join(vault, "maps", "safe.md"), "utf8") === "theirs on disk\n", "409 must not overwrite the file");

    const huge = await fetch(base + "/api/day?date=2026-09-06", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "x".repeat(1_000_001),
    });
    assert(huge.status === 413, "oversize body got " + huge.status);

    const blocked = ["/server.mjs", "/package.json", "/DESIGN.md", "/start.sh", "/.git/config", "/vault/maps/safe.md"];
    for (const p of blocked) {
      const res = await fetch(base + p);
      assert(res.status === 404 || res.status === 400, "static " + p + " got " + res.status);
      const text = await res.text();
      assert(!text.includes("safeJoin"), "must not serve server source via " + p);
      assert(!text.includes("SECRET_OUTSIDE"), "must not serve vault via static " + p);
    }

    const index = await fetch(base + "/");
    assert(index.ok, "app still serves");
    const indexText = await index.text();
    assert(indexText.includes("What do you want to do today?"), "Door still there");

    const app = await fetch(base + "/app.js");
    assert(app.ok, "app.js still serves");
  } finally {
    try { child.kill("SIGTERM"); } catch {}
    const deadline = Date.now() + 2000;
    while (child.exitCode == null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 40));
    }
    try { child.kill("SIGKILL"); } catch {}
    try { fs.rmSync(vault, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { force: true }); } catch {}
  }
}

await check("vault ABI blocks escape, source leak, CSRF, and oversize writes", liveVaultAbi);

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("vault-abi-test ok  (" + results.length + " passed)");
