#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function chromeBin() {
  const names = [];
  if (process.env.CHROME_PATH) names.push(process.env.CHROME_PATH);
  names.push(
    "google-chrome-stable",
    "google-chrome",
    "chromium",
    "chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  );
  const errors = [];
  for (const name of names) {
    try {
      execFileSync(name, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      return name;
    } catch (error) {
      errors.push(name + ": " + String(error && error.message || error).split("\n")[0]);
    }
  }
  throw new Error("Chrome is required to measure scrollWidth at 390. " + errors.join("; "));
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function git(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const dates = ["2026-10-16", "2026-10-17", "2026-10-18", "2026-10-19"];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-phone-"));
const bare = path.join(tmp, "remote.git");
const seed = path.join(tmp, "seed");
const vaultA = path.join(tmp, "a");
const vaultB = path.join(tmp, "b");
fs.mkdirSync(seed, { recursive: true });
git(["init", "--bare", "-b", "main", bare], tmp);
git(["init", "-b", "main"], seed);
git(["config", "user.name", "Seed"], seed);
git(["config", "user.email", "seed@local"], seed);
fs.mkdirSync(path.join(seed, "log"), { recursive: true });
fs.writeFileSync(path.join(seed, "README.md"), "vault\n", "utf8");
git(["add", "README.md"], seed);
git(["commit", "-m", "seed"], seed);
git(["remote", "add", "origin", bare], seed);
git(["push", "-u", "origin", "HEAD"], seed);

const portA = await freePort();
const portB = await freePort();
const debugPort = await freePort();

function spawnServer(port, vault) {
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AIDANOS_HOST: "127.0.0.1",
      AIDANOS_VAULT: vault,
      AIDANOS_VAULT_GIT_URL: bare,
      AIDANOS_VAULT_GIT_DEBOUNCE_MS: "80",
      AIDANOS_VAULT_GIT_SYNC_MS: "0",
      AIDANOS_VAULT_GIT_RETRY_MS: "0",
      TZ: "UTC",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (chunk) => { log += chunk; });
  child.stderr.on("data", (chunk) => { log += chunk; });
  child.log = () => log;
  return child;
}

const childA = spawnServer(portA, vaultA);
const childB = spawnServer(portB, vaultB);
const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-chrome-"));
const chromeLog = [];
const chrome = spawn(chromeBin(), [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=" + debugPort,
  "--no-first-run",
  "--user-data-dir=" + chromeDir,
  "--window-size=390,844",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stdout.on("data", (chunk) => { chromeLog.push(String(chunk)); });
chrome.stderr.on("data", (chunk) => { chromeLog.push(String(chunk)); });

function stop() {
  chrome.kill("SIGKILL");
  childA.kill("SIGTERM");
  childB.kill("SIGTERM");
}

try {
  async function waitHealth(port, child) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {
        if ((await fetch("http://127.0.0.1:" + port + "/api/health")).ok) return;
      } catch {}
      await sleep(80);
    }
    throw new Error("health " + port + " " + child.log().slice(-400));
  }
  await waitHealth(portA, childA);
  await waitHealth(portB, childB);

  function commitFile(vault, rel, text, message) {
    const abs = path.join(vault, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text, "utf8");
    git(["add", "--", rel], vault);
    git(["commit", "-m", message], vault);
  }
  for (const date of dates) commitFile(vaultA, "log/" + date + ".md", "from the other copy\n", "A " + date);
  git(["push", "origin", "HEAD"], vaultA);
  for (const date of dates) commitFile(vaultB, "log/" + date + ".md", "from this copy\n", "B " + date);
  const trigger = await fetch("http://127.0.0.1:" + portB + "/api/day?date=2026-09-01", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: "2026-09-01", paper: "trigger\n", markdown: "trigger\n", mtime: 0 }),
  });
  assert(trigger.ok, "trigger " + trigger.status + " " + childB.log().slice(-400));
  const want = dates.map((date) => "log/" + date + ".md").sort().join(",");
  const readyAt = Date.now() + 12000;
  let sync = null;
  while (Date.now() < readyAt) {
    sync = await (await fetch("http://127.0.0.1:" + portB + "/api/sync")).json();
    const paths = (sync.conflicts || []).map((item) => item && item.path).sort().join(",");
    if (paths === want && sync.join !== true) break;
    await sleep(80);
  }
  const paths = (sync.conflicts || []).map((item) => item && item.path).sort().join(",");
  assert(paths === want, "conflicts not ready " + paths);

  let version;
  for (let i = 0; i < 200; i++) {
    try {
      version = await (await fetch("http://127.0.0.1:" + debugPort + "/json/version")).json();
      break;
    } catch {
      if (chrome.exitCode !== null) break;
      await sleep(100);
    }
  }
  assert(version, "Chrome did not open a debugger. " + chromeLog.join("").slice(-800));
  const ws = new WebSocket(version.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve);
    ws.addEventListener("error", reject);
  });
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (!msg.id || !pending.has(msg.id)) return;
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) reject(new Error(JSON.stringify(msg.error)));
    else resolve(msg.result);
  });
  function send(method, params = {}, sessionId) {
    const next = ++id;
    return new Promise((resolve, reject) => {
      pending.set(next, { resolve, reject });
      const payload = { id: next, method, params };
      if (sessionId) payload.sessionId = sessionId;
      ws.send(JSON.stringify(payload));
    });
  }
  const { targetId } = await send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });
  await send("Page.enable", {}, sessionId);
  await send("Runtime.enable", {}, sessionId);
  async function evalJs(expression) {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result && result.result.value;
  }
  async function setWidth(width, height) {
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: width < 500 ? 2 : 1,
      mobile: width < 500,
    }, sessionId);
    await sleep(200);
  }
  await setWidth(390, 844);
  await send("Page.navigate", { url: "http://127.0.0.1:" + portB + "/" }, sessionId);
  const doorAt = Date.now() + 12000;
  while (Date.now() < doorAt) {
    if (await evalJs(`document.readyState === "complete" && !!document.getElementById("door-skip")`)) break;
    await sleep(100);
  }
  await evalJs(`document.getElementById("door-skip").click()`);
  const linesAt = Date.now() + 12000;
  let last = "";
  while (Date.now() < linesAt) {
    last = await evalJs(`(() => {
      const box = document.getElementById("conflict-waiting");
      if (!box || box.hidden) return "hidden";
      const rows = box.querySelectorAll(".choice-row").length;
      const text = box.textContent || "";
      if (rows !== 3) return "rows " + rows;
      if (!text.includes("and 1 more")) return text;
      if (text.includes("and 1 more.")) return "full stop";
      return true;
    })()`);
    if (last === true) break;
    await sleep(100);
  }
  assert(last === true, "choice lines " + last);

  const measure = `(() => {
    const doc = document.documentElement;
    const days = document.getElementById("days");
    const wrap = document.getElementById("dump-wrap");
    const week = document.querySelector(".week-row");
    const sideways = [];
    for (const el of document.querySelectorAll("body *")) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      const ox = style.overflowX;
      if ((ox === "auto" || ox === "scroll") && el.scrollWidth > el.clientWidth + 1) {
        sideways.push((el.id || el.className || el.tagName) + " " + el.scrollWidth + "/" + el.clientWidth);
      }
    }
    const rows = [...document.querySelectorAll("#conflict-waiting .choice-row")].map((row, index, all) => {
      const labelEl = row.querySelector(".conflict-kicker");
      const buttonEl = row.querySelector("button");
      const label = labelEl.getBoundingClientRect();
      const button = buttonEl.getBoundingClientRect();
      const next = all[index + 1] ? all[index + 1].getBoundingClientRect() : null;
      return {
        label: labelEl.textContent,
        buttonText: buttonEl.textContent,
        aria: buttonEl.getAttribute("aria-label"),
        buttonRightOfLabel: button.left >= label.right - 1,
        sharesRow: button.top < label.bottom && button.bottom > label.top,
        gap: next ? next.top - row.getBoundingClientRect().bottom : null,
      };
    });
    return {
      scrollWidth: doc.scrollWidth,
      clientWidth: doc.clientWidth,
      daysScroll: days.scrollWidth,
      daysClient: days.clientWidth,
      wrapScroll: wrap.scrollWidth,
      wrapClient: wrap.clientWidth,
      weekScroll: week.scrollWidth,
      weekClient: week.clientWidth,
      sideways,
      rows,
    };
  })()`;

  const phone = await evalJs(measure);
  assert(phone.scrollWidth <= phone.clientWidth, "document scrollWidth " + phone.scrollWidth + " clientWidth " + phone.clientWidth);
  assert(phone.clientWidth === 390, "viewport is 390, got " + phone.clientWidth);
  assert(phone.daysScroll <= phone.daysClient, "week strip " + phone.daysScroll + "/" + phone.daysClient);
  assert(phone.wrapScroll <= phone.wrapClient, "page column " + phone.wrapScroll + "/" + phone.wrapClient);
  assert(phone.weekScroll <= phone.weekClient, "week row " + phone.weekScroll + "/" + phone.weekClient);
  assert(phone.sideways.length === 0, "sideways scrollbars " + phone.sideways.join(", "));
  assert(phone.rows.length === 3, "three choice rows");
  for (const row of phone.rows) {
    assert(row.buttonRightOfLabel && row.sharesRow, "Open is on the line at 390 " + JSON.stringify(row));
    assert(row.label.endsWith(" needs a choice"), row.label);
    assert(row.buttonText === "Open", "visible button text " + row.buttonText);
    assert(row.aria === "Open " + row.label.replace(/ needs a choice$/, ""), "screen reader label " + row.aria);
    if (row.gap !== null) assert(row.gap >= 8, "rows touch " + row.gap);
  }

  await setWidth(1280, 900);
  const desktop = await evalJs(measure);
  assert(desktop.scrollWidth <= desktop.clientWidth, "desktop document " + desktop.scrollWidth + "/" + desktop.clientWidth);
  for (const row of desktop.rows) {
    assert(row.buttonRightOfLabel && row.sharesRow, "Open is on the line at desktop " + JSON.stringify(row));
    if (row.gap !== null) assert(row.gap >= 8, "desktop rows touch " + row.gap);
  }
  console.log("phone-width-test ok", phone.scrollWidth, phone.clientWidth);
} finally {
  stop();
}
