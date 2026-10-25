#!/usr/bin/env node
// Opens every listed screen against the sample notes and saves a picture
// at each listed width. A missing picture, a missing browser, or a state
// that does not appear is a failed run. This script never treats that as
// an empty success.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, "fixtures", "sample-notes");
const shotDir = path.join(fixture, "screenshots");
const artifactDir = "/opt/cursor/artifacts/sample-screens";
const SHOWCASE = "2026-03-14";
const LATCH = "north window latch";
const PLAN_LINE = "Keep the lantern lit";
const PROJECT_LINE = "Glass Orchard";
const MAP_LINE = "pack a crate";
const CAPTURE_LINE = "spare hook";

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function chromeBin() {
  const names = [];
  if (process.env.CHROME_PATH) names.push(process.env.CHROME_PATH);
  names.push("google-chrome-stable", "google-chrome", "chromium", "chromium-browser");
  const errors = [];
  for (const name of names) {
    try {
      execFileSync(name, ["--version"], { stdio: ["ignore", "pipe", "pipe"] });
      return name;
    } catch (error) {
      errors.push(name + ": " + String(error && error.message || error).split("\n")[0]);
    }
  }
  throw new Error("Chrome is required for the screenshot run. " + errors.join("; "));
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

function writeReport(report) {
  fs.mkdirSync(shotDir, { recursive: true });
  fs.writeFileSync(path.join(shotDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
}

const screens = JSON.parse(fs.readFileSync(path.join(fixture, "screens.json"), "utf8"));
assert(Array.isArray(screens.widths) && screens.widths.includes(1280) && screens.widths.includes(390), "screens.json widths");
assert(Array.isArray(screens.states) && screens.states.length > 0, "screens.json states");

const bin = chromeBin();
const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sample-"));
fs.cpSync(path.join(fixture, "vault"), vault, { recursive: true });
const port = await freePort();
const debugPort = await freePort();
const childEnv = { ...process.env };
delete childEnv.AIDANOS_VAULT_GIT_TOKEN;
delete childEnv.GITHUB_TOKEN;
delete childEnv.GH_TOKEN;
childEnv.AIDANOS_VAULT_GIT_URL = "";
childEnv.AIDANOS_HOST = "127.0.0.1";
childEnv.AIDANOS_VAULT = vault;
childEnv.PORT = String(port);
childEnv.TZ = "UTC";

const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: childEnv,
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (chunk) => { serverLog += chunk; });
child.stderr.on("data", (chunk) => { serverLog += chunk; });

const chromeDir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sample-chrome-"));
const chromeLog = [];
const chrome = spawn(bin, [
  "--headless=new",
  "--disable-gpu",
  "--no-sandbox",
  "--disable-dev-shm-usage",
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=" + debugPort,
  "--no-first-run",
  "--user-data-dir=" + chromeDir,
  "--window-size=1280,900",
  "about:blank",
], { stdio: ["ignore", "pipe", "pipe"] });
chrome.stdout.on("data", (chunk) => { chromeLog.push(String(chunk)); });
chrome.stderr.on("data", (chunk) => { chromeLog.push(String(chunk)); });

const shots = [];
let failed = null;

function stop() {
  try { chrome.kill("SIGKILL"); } catch (err) {}
  try { child.kill("SIGTERM"); } catch (err) {}
}

try {
  const healthAt = Date.now() + 15000;
  let healthy = false;
  while (Date.now() < healthAt) {
    if (child.exitCode != null) break;
    try {
      if ((await fetch("http://127.0.0.1:" + port + "/api/health")).ok) {
        healthy = true;
        break;
      }
    } catch (err) {}
    await sleep(80);
  }
  assert(healthy, "server did not start. " + serverLog.slice(-500));

  let version;
  for (let i = 0; i < 200; i++) {
    try {
      version = await (await fetch("http://127.0.0.1:" + debugPort + "/json/version")).json();
      break;
    } catch (err) {
      if (chrome.exitCode !== null) break;
      await sleep(100);
    }
  }
  assert(version && version.webSocketDebuggerUrl, "Chrome did not open a debugger. " + chromeLog.join("").slice(-800));

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
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    }, sessionId);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result ? result.result.value : undefined;
  }

  async function waitFor(read, ms, label) {
    const deadline = Date.now() + ms;
    let last;
    while (Date.now() < deadline) {
      last = await read();
      if (last === true) return;
      await sleep(80);
    }
    throw new Error(label + ": " + JSON.stringify(last).slice(0, 400));
  }

  async function setWidth(width) {
    const height = width < 500 ? 844 : 900;
    await send("Emulation.setDeviceMetricsOverride", {
      width,
      height,
      deviceScaleFactor: 1,
      mobile: width < 500,
    }, sessionId);
    await sleep(250);
    const got = await evalJs("document.documentElement.clientWidth");
    assert(got === width, "viewport is " + got + ", want " + width);
  }

  async function pageText() {
    return evalJs(`(document.getElementById("paper") && document.getElementById("paper").innerText) || ""`);
  }

  async function onLatchDay() {
    const text = await pageText();
    const cls = await evalJs(`document.body.className`);
    return typeof text === "string"
      && text.includes(LATCH)
      && typeof cls === "string"
      && cls.includes("view-today")
      && !cls.includes("doc-plan")
      && !cls.includes("doc-capture")
      && !cls.includes("doc-map")
      && !cls.includes("has-conflict");
  }

  async function openAsk(query) {
    await evalJs(`document.getElementById("ask-close").click()`);
    await evalJs(`document.getElementById("ask-open").click()`);
    await evalJs(`(() => {
      const q = document.getElementById("ask-q");
      q.focus();
      q.value = ${JSON.stringify(query)};
      q.dispatchEvent(new Event("input", { bubbles: true }));
      return true;
    })()`);
    await waitFor(async () => {
      const found = await evalJs(`(() => {
        const hits = document.getElementById("ask-hits");
        const buttons = hits ? [...hits.querySelectorAll("button")] : [];
        return buttons.some((button) => (button.textContent || "").toLowerCase().includes(${JSON.stringify(query.toLowerCase())}));
      })()`);
      if (found === true) return true;
      return await evalJs(`(document.getElementById("ask-hits") && document.getElementById("ask-hits").innerText) || ""`);
    }, 8000, "ask " + query);
  }

  async function clickHit(query) {
    const clicked = await evalJs(`(() => {
      const hits = document.getElementById("ask-hits");
      const button = [...hits.querySelectorAll("button")].find((item) => (item.textContent || "").toLowerCase().includes(${JSON.stringify(query.toLowerCase())}));
      if (!button) return "no hit";
      button.click();
      return true;
    })()`);
    assert(clicked === true, "click " + query + " " + clicked);
  }

  async function prepareDoor() {
    const ready = await evalJs(`document.body.classList.contains("view-door") && document.getElementById("view-door") && !document.getElementById("view-door").hidden && document.getElementById("door-proposals").hidden`);
    if (ready === true) return;
    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/" }, sessionId);
    await waitFor(async () => {
      const ok = await evalJs(`document.readyState === "complete" && !!document.getElementById("door-input") && document.body.classList.contains("view-door")`);
      return ok === true ? true : ok;
    }, 12000, "door");
  }

  async function prepareProposals() {
    const ready = await evalJs(`!document.getElementById("door-proposals").hidden && (document.getElementById("door-proposals").textContent || "").includes("Mend the north window")`);
    if (ready === true) return;
    await prepareDoor();
    await evalJs(`(() => {
      const input = document.getElementById("door-input");
      input.value = "Mend the north window and sweep the stone steps";
      document.getElementById("door-form").requestSubmit();
      return true;
    })()`);
    await waitFor(async () => {
      const text = await evalJs(`document.getElementById("door-proposals").hidden ? "" : (document.getElementById("door-proposals").textContent || "")`);
      if (typeof text === "string" && text.includes("Mend the north window") && text.includes("sweep the stone steps")) return true;
      return text;
    }, 8000, "door proposals");
  }

  async function showToday() {
    const plain = await evalJs(`document.body.classList.contains("view-today") && !document.body.classList.contains("doc-note") && !document.getElementById("view-today").hidden`);
    if (plain === true) return;
    await evalJs(`document.querySelector("a[href='#today']").click()`);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("view-today") && !document.body.classList.contains("doc-note") && !document.getElementById("view-today").hidden`);
      return ok === true ? true : await evalJs("document.body.className");
    }, 8000, "today view");
  }

  async function prepareToday() {
    if (await onLatchDay()) return;
    await showToday();
    await openAsk(LATCH);
    await clickHit(LATCH);
    await waitFor(async () => {
      if (await onLatchDay()) return true;
      return await pageText();
    }, 8000, "showcase day");
  }

  async function expandRail() {
    await prepareToday();
    const collapsed = await evalJs(`document.querySelector(".today-room").classList.contains("rail-collapsed")`);
    if (collapsed === true) {
      await evalJs(`document.getElementById("toggle-rail").click()`);
    }
    await waitFor(async () => {
      const ok = await evalJs(`(() => {
        const room = document.querySelector(".today-room");
        const rail = document.querySelector(".today-rail");
        const blocks = document.querySelectorAll("#timeline .block").length;
        if (!room || room.classList.contains("rail-collapsed")) return "collapsed";
        if (!rail || getComputedStyle(rail).display === "none") return "hidden rail";
        if (!blocks) return "no blocks";
        return true;
      })()`);
      return ok === true ? true : ok;
    }, 4000, "timeline");
  }

  async function prepareMonth() {
    await expandRail();
    const open = await evalJs(`(() => {
      const grid = document.getElementById("month-grid");
      return !!(grid && !grid.hidden && /March/.test(grid.textContent || "") && /2026/.test(grid.textContent || ""));
    })()`);
    if (open === true) {
      await evalJs(`document.getElementById("month-grid").scrollIntoView({ block: "center" })`);
      return;
    }
    await evalJs(`document.getElementById("toggle-month").click()`);
    await waitFor(async () => {
      const text = await evalJs(`(() => {
        const grid = document.getElementById("month-grid");
        if (!grid || grid.hidden) return "hidden";
        return grid.textContent || "";
      })()`);
      if (typeof text === "string" && /March/.test(text) && /2026/.test(text)) return true;
      return text;
    }, 8000, "month");
    await evalJs(`document.getElementById("month-grid").scrollIntoView({ block: "center" })`);
  }

  async function preparePlan() {
    const ready = await evalJs(`document.body.classList.contains("doc-plan") && ((document.getElementById("paper") && document.getElementById("paper").innerText) || "").includes(${JSON.stringify(PLAN_LINE)})`);
    if (ready === true) return;
    await evalJs(`document.querySelector("a[href='#plan']").click()`);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("doc-plan")`);
      const text = await pageText();
      if (ok === true && typeof text === "string" && text.includes(PLAN_LINE)) return true;
      return String(ok) + " " + text.slice(0, 120);
    }, 8000, "plan");
  }

  async function prepareCapture() {
    const ready = await evalJs(`document.body.classList.contains("doc-capture") && ((document.getElementById("paper") && document.getElementById("paper").innerText) || "").includes(${JSON.stringify(CAPTURE_LINE)})`);
    if (ready === true) return;
    await evalJs(`location.hash = "capture"`);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("doc-capture")`);
      const text = await pageText();
      if (ok === true && typeof text === "string" && text.includes(CAPTURE_LINE)) return true;
      return String(ok) + " " + text.slice(0, 120);
    }, 8000, "capture");
  }

  async function prepareAsk() {
    const ready = await evalJs(`(() => {
      const modal = document.getElementById("ask-modal");
      if (!modal || modal.hidden || modal.classList.contains("hidden")) return false;
      return [...modal.querySelectorAll("button")].some((button) => /glass orchard/i.test(button.textContent || ""));
    })()`);
    if (ready === true) return;
    await showToday();
    await openAsk("glass orchard");
  }

  async function prepareProject() {
    const ready = await evalJs(`document.body.classList.contains("doc-note") && !document.body.classList.contains("doc-map") && !document.body.classList.contains("doc-capture") && ((document.getElementById("paper") && document.getElementById("paper").innerText) || "").includes(${JSON.stringify(PROJECT_LINE)}) && document.getElementById("ask-modal").hidden`);
    if (ready === true) return;
    await showToday();
    await openAsk("Label the blue pane");
    await clickHit("glass-orchard");
    await waitFor(async () => {
      const text = await pageText();
      const closed = await evalJs(`document.getElementById("ask-modal").hidden === true`);
      if (closed === true && typeof text === "string" && text.includes(PROJECT_LINE)) return true;
      return text.slice(0, 160);
    }, 8000, "project");
  }

  async function prepareMap() {
    const ready = await evalJs(`document.body.classList.contains("doc-map") && !document.body.classList.contains("doc-stage") && document.querySelectorAll(".map-stage").length > 0 && document.getElementById("stage-sheet").hidden`);
    if (ready === true) return;
    await showToday();
    await openAsk(MAP_LINE);
    await clickHit("pack-a-crate");
    await waitFor(async () => {
      const count = await evalJs(`document.body.classList.contains("doc-map") ? document.querySelectorAll(".map-stage").length : 0`);
      if (typeof count === "number" && count > 0) return true;
      return await pageText();
    }, 8000, "map");
  }

  async function prepareStage() {
    const ready = await evalJs(`document.body.classList.contains("doc-stage") && !document.getElementById("stage-sheet").hidden`);
    if (ready === true) {
      await evalJs(`document.getElementById("stage-sheet").scrollIntoView({ block: "center" })`);
      return;
    }
    await prepareMap();
    await evalJs(`document.querySelector(".map-stage").click()`);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("doc-stage") && !document.getElementById("stage-sheet").hidden`);
      return ok === true ? true : await evalJs("document.body.className");
    }, 8000, "stage");
    await evalJs(`document.getElementById("stage-sheet").scrollIntoView({ block: "center" })`);
  }

  async function prepareConflict() {
    const ready = await evalJs(`document.body.classList.contains("has-conflict") && !document.body.classList.contains("conflict-edit") && !document.getElementById("conflict-sheet").hidden`);
    if (ready === true) {
      await evalJs(`document.getElementById("conflict-sheet").scrollIntoView({ block: "center" })`);
      return;
    }
    await prepareToday();
    await evalJs(`(() => {
      const line = [...document.querySelectorAll("#paper .md-line")].find((el) => (el.innerText || "").includes("reading room stays open"));
      if (line) line.scrollIntoView({ block: "center" });
      return true;
    })()`);
    const point = await evalJs(`(() => {
      const line = [...document.querySelectorAll("#paper .md-line")].find((el) => (el.innerText || "").includes("reading room stays open"));
      if (!line) return null;
      const body = line.querySelector(".md-body") || line;
      const rect = body.getBoundingClientRect();
      return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
    })()`);
    assert(point && point.x > 0, "showcase line is not on screen");
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1,
    }, sessionId);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1,
    }, sessionId);
    await waitFor(async () => {
      const ok = await evalJs(`!![...document.querySelectorAll("#paper .md-line.is-source")].find((el) => (el.innerText || "").includes("reading room stays open"))`);
      return ok === true ? true : "line not editing";
    }, 4000, "edit the day line");
    await send("Input.insertText", { text: " extra" }, sessionId);
    fs.writeFileSync(
      path.join(vault, "log", SHOWCASE + ".md"),
      "# Harbor Lantern\n\nThe other copy moved the chairs.\n",
      "utf8",
    );
    const ahead = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(vault, "log", SHOWCASE + ".md"), ahead, ahead);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("has-conflict") && !document.getElementById("conflict-sheet").hidden`);
      if (ok === true) return true;
      return await evalJs(`(document.getElementById("status") && document.getElementById("status").textContent) || document.body.className`);
    }, 5000, "conflict");
    await evalJs(`document.getElementById("conflict-sheet").scrollIntoView({ block: "center" })`);
  }

  function restoreShowcase() {
    fs.copyFileSync(
      path.join(fixture, "vault", "log", SHOWCASE + ".md"),
      path.join(vault, "log", SHOWCASE + ".md"),
    );
  }

  async function reloadSample() {
    restoreShowcase();
    const stamp = Date.now();
    await evalJs(`window.__aidanReload = ${stamp}`);
    await send("Page.navigate", { url: "http://127.0.0.1:" + port + "/?fresh=" + stamp }, sessionId);
    await waitFor(async () => {
      const ok = await evalJs(`document.readyState === "complete" && !!document.getElementById("door-input") && window.__aidanReload !== ${stamp} && document.body.classList.contains("view-door") && !document.body.classList.contains("has-conflict")`);
      return ok === true ? true : ok;
    }, 12000, "reload");
    await evalJs(`localStorage.clear(); sessionStorage.clear();`);
  }

  async function noSidewaysScroll() {
    const ok = await evalJs(`document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1`);
    assert(ok === true, "the page scrolls sideways");
  }

  async function prepareEditorNormal() {
    await reloadSample();
    await prepareToday();
    await evalJs(`showEditorState("normal")`);
    const shaped = await evalJs(`(() => {
      const paper = document.getElementById("paper");
      const headings = paper.querySelectorAll(".md-line.h1, .md-line.h2, .md-line.h3").length;
      const boxes = paper.querySelectorAll(".md-box").length;
      const hanging = paper.querySelectorAll(".md-line.nest").length;
      return headings > 0 && boxes > 0 && hanging > 0;
    })()`);
    assert(shaped === true, "the note is not formatted");
    const width = await evalJs(`document.documentElement.clientWidth`);
    if (width === 390) {
      await evalJs(`(() => {
        document.getElementById("paper").focus();
        const bar = document.getElementById("fmt-bar");
        bar.classList.remove("hidden");
        bar.removeAttribute("hidden");
        return [...bar.querySelectorAll("[data-fmt]")].map((button) => button.getAttribute("data-fmt")).join(",");
      })()`);
      const order = await evalJs(`[...document.querySelectorAll("#fmt-bar [data-fmt]")].map((button) => button.getAttribute("data-fmt")).join(",")`);
      assert(order === "task,heading,list,indent,outdent,undo,find,hide", "format bar order " + order);
    } else {
      await evalJs(`(() => {
        const bar = document.getElementById("fmt-bar");
        bar.setAttribute("hidden", "");
        return bar.hidden;
      })()`);
      const hidden = await evalJs(`document.getElementById("fmt-bar").hidden === true`);
      assert(hidden === true, "the Mac shows the formatting bar");
    }
    const saved = await evalJs(`document.getElementById("status").textContent`);
    assert(saved === "Saved", "save word is " + saved);
    await noSidewaysScroll();
  }

  async function prepareEditorEmpty() {
    await reloadSample();
    await showToday();
    await evalJs(`openDay("2026-03-13")`);
    await waitFor(async () => {
      const ok = await evalJs(`document.getElementById("paper").classList.contains("is-empty") && (document.getElementById("paper-title").textContent || "").length > 0`);
      return ok === true ? true : await evalJs(`document.getElementById("paper").className + " " + document.getElementById("paper-title").textContent`);
    }, 8000, "empty day");
    await evalJs(`showEditorState("empty")`);
    const placeholder = await evalJs(`document.getElementById("paper").getAttribute("data-placeholder")`);
    assert(placeholder === "Write.", "empty day does not say Write.");
    const spinner = await evalJs(`document.querySelector(".spinner, [aria-busy='true']")`);
    assert(!spinner, "empty day shows a spinner");
    await noSidewaysScroll();
  }

  async function prepareEditorFirst() {
    await reloadSample();
    await prepareToday();
    await evalJs(`showEditorState("first")`);
    const text = await evalJs(`document.body.innerText || ""`);
    assert(typeof text === "string" && text.includes(LATCH), "first open is not today's note");
    assert(!/still being read|older notes are|reading your notes/i.test(text), "first open mentions the background read");
    const spinner = await evalJs(`!!document.querySelector(".spinner, [aria-busy='true']")`);
    assert(spinner === false, "first open shows a spinner");
    await noSidewaysScroll();
  }

  async function prepareEditorLoading() {
    await reloadSample();
    await prepareToday();
    await evalJs(`showEditorState("loading")`);
    const ready = await evalJs(`(() => {
      const paper = document.getElementById("paper");
      const text = paper ? paper.innerText : "";
      return text.includes(${JSON.stringify(LATCH)}) && !document.querySelector(".spinner, [aria-busy='true']");
    })()`);
    assert(ready === true, "loading hid the note or showed a spinner");
    await noSidewaysScroll();
  }

  async function prepareEditorError() {
    await reloadSample();
    await prepareToday();
    await evalJs(`showEditorState("error")`);
    const status = await evalJs(`document.getElementById("status").textContent`);
    const note = await evalJs(`(() => {
      const line = document.getElementById("editor-note");
      return line && !line.hidden ? line.textContent : "";
    })()`);
    assert(status === "Unsaved", "save word is " + status);
    assert(note === "This change is kept on this device.", "quiet line is " + note);
    const red = await evalJs(`(() => {
      const line = getComputedStyle(document.getElementById("editor-note")).color;
      const word = getComputedStyle(document.getElementById("status")).color;
      return /rgb\\(\\s*18[0-9]|rgb\\(\\s*2[0-4][0-9]/.test(line + " " + word);
    })()`);
    assert(red === false, "the error is drawn in red");
    await noSidewaysScroll();
  }

  async function prepareConflictEdit() {
    const ready = await evalJs(`document.body.classList.contains("conflict-edit") && document.getElementById("conflict-sheet").classList.contains("is-edit")`);
    if (ready === true) {
      await evalJs(`document.getElementById("conflict-sheet").scrollIntoView({ block: "center" })`);
      return;
    }
    await prepareConflict();
    await evalJs(`document.getElementById("conflict-edit").click()`);
    await waitFor(async () => {
      const ok = await evalJs(`document.body.classList.contains("conflict-edit")`);
      return ok === true ? true : await evalJs("document.body.className");
    }, 4000, "conflict edit");
    await evalJs(`document.getElementById("conflict-sheet").scrollIntoView({ block: "center" })`);
  }

  const openers = {
    door: prepareDoor,
    "door-proposals": prepareProposals,
    today: prepareToday,
    timeline: expandRail,
    month: prepareMonth,
    plan: preparePlan,
    capture: prepareCapture,
    ask: prepareAsk,
    project: prepareProject,
    map: prepareMap,
    stage: prepareStage,
    conflict: prepareConflict,
    "conflict-edit": prepareConflictEdit,
    "editor-normal": prepareEditorNormal,
    "editor-empty": prepareEditorEmpty,
    "editor-first": prepareEditorFirst,
    "editor-loading": prepareEditorLoading,
    "editor-error": prepareEditorError,
  };

  for (const state of screens.states) {
    assert(typeof openers[state] === "function", "no opener for listed screen " + state);
  }
  for (const state of Object.keys(openers)) {
    assert(screens.states.includes(state), "opener is not listed: " + state);
  }

  fs.mkdirSync(shotDir, { recursive: true });
  for (const state of screens.states) {
    for (const width of screens.widths) {
      await setWidth(width);
      await openers[state]();
      await sleep(150);
      const shot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
      assert(shot && shot.data, "screenshot returned no data for " + state + " " + width);
      const buf = Buffer.from(shot.data, "base64");
      assert(buf.length > 4000, state + " " + width + " picture is " + buf.length + " bytes");
      assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, state + " " + width + " is not a png");
      const name = state + "-" + width + ".png";
      fs.writeFileSync(path.join(shotDir, name), buf);
      shots.push(name);
      console.log("shot  " + name + "  " + buf.length);
    }
  }

  const expected = screens.states.length * screens.widths.length;
  assert(shots.length === expected, "saved " + shots.length + " pictures, listed " + expected);
  for (const name of shots) {
    const abs = path.join(shotDir, name);
    assert(fs.existsSync(abs) && fs.statSync(abs).size > 4000, "missing picture " + name);
  }
  try {
    fs.mkdirSync(artifactDir, { recursive: true });
    for (const name of shots) fs.copyFileSync(path.join(shotDir, name), path.join(artifactDir, name));
  } catch (err) {
    console.log("artifact copy skipped: " + (err && err.message || err));
  }
  writeReport({ ok: true, shots });
  console.log("sample-screens-test ok  (" + shots.length + " pictures)");
} catch (err) {
  failed = err;
  console.log("FAIL  sample screens  " + (err && err.message || err));
  if (serverLog) console.log(serverLog.slice(-500));
  writeReport({ ok: false, error: String(err && err.message || err), shots });
  process.exitCode = 1;
} finally {
  stop();
  const stopAt = Date.now() + 2000;
  while (child.exitCode == null && Date.now() < stopAt) await sleep(40);
  try { child.kill("SIGKILL"); } catch (err) {}
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch (err) {}
  try { fs.rmSync(chromeDir, { recursive: true, force: true }); } catch (err) {}
}
if (failed) process.exit(1);
