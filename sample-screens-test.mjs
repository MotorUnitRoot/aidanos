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
    // Submit runs the search now. An input event would clear the list again
    // 140ms later. The click waits until this submit has finished rendering.
    await evalJs(`(() => {
      const q = document.getElementById("ask-q");
      q.focus();
      q.value = ${JSON.stringify(query)};
      document.getElementById("ask-form").requestSubmit();
      return true;
    })()`);
    await waitFor(async () => {
      const state = await evalJs(`(() => {
        const q = document.getElementById("ask-q");
        const hits = document.getElementById("ask-hits");
        if (!q || !hits || q.value !== ${JSON.stringify(query)}) return "query";
        if (hits.querySelector(".ask-finding")) return "finding";
        const ready = [...hits.querySelectorAll("button")].some((button) => (button.textContent || "").toLowerCase().includes(${JSON.stringify(query.toLowerCase())}));
        return ready ? true : "no hit";
      })()`);
      if (state === true) return true;
      return state;
    }, 8000, "ask " + query);
  }

  async function clickHit(query) {
    const clicked = await evalJs(`(() => {
      const hits = document.getElementById("ask-hits");
      const button = hits ? [...hits.querySelectorAll("button")].find((item) => (item.textContent || "").toLowerCase().includes(${JSON.stringify(query.toLowerCase())})) : null;
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
    await evalJs(`(() => {
      const paper = document.getElementById("paper");
      if (paper && paper.contains(document.activeElement) && paper.blur) paper.blur();
      const active = document.activeElement;
      if (active && active !== document.body && active !== document.documentElement && active.blur) active.blur();
      window.dispatchEvent(new Event("resize"));
      return true;
    })()`);
    await waitFor(async () => {
      const ok = await evalJs(`(() => {
        const bar = document.getElementById("format-bar");
        const rail = document.querySelector(".today-rail");
        if (!bar || !rail) return "missing";
        const hidden = bar.hidden || getComputedStyle(bar).display === "none";
        const barBox = bar.getBoundingClientRect();
        const railBox = rail.getBoundingClientRect();
        const overlaps = !hidden && barBox.height > 0 && barBox.bottom > railBox.top + 1 && barBox.top < railBox.bottom - 1 && barBox.right > railBox.left + 1 && barBox.left < railBox.right - 1;
        if (!hidden) return "bar visible";
        if (overlaps) return "bar covers the timeline";
        return true;
      })()`);
      return ok === true ? true : ok;
    }, 2000, "timeline format bar");
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
    await showToday();
    // A flash left by the today step is not this step's. Wait it out, then
    // open the latch hit so this step sees its own flash. The step does not
    // depend on running after stage.
    await waitFor(async () => {
      const flashing = await evalJs(`!!document.querySelector("#paper .is-flash")`);
      return flashing === false ? true : "flashing";
    }, 2000, "latch flash idle");
    await openAsk(LATCH);
    await clickHit(LATCH);
    // The latch hit flashes its line after the day text is already visible.
    // That flash repaints the paper and scrolls. One click, after the flash
    // class is gone and this line is still under the pointer.
    let sawFlash = false;
    let placed = false;
    let stillTop = null;
    let point = null;
    await waitFor(async () => {
      const snap = await evalJs(`(() => {
        const ask = document.getElementById("ask-modal");
        if (ask && !ask.hidden) return { state: "ask open" };
        const flashing = !!document.querySelector("#paper .is-flash");
        const line = [...document.querySelectorAll("#paper .md-line")].find((el) => (el.innerText || "").includes("reading room stays open"));
        if (!line) return { state: flashing ? "flashing" : "no line" };
        if (flashing) return { state: "flashing" };
        const body = line.querySelector(".md-body") || line;
        const rect = body.getBoundingClientRect();
        if (rect.width < 8 || rect.height < 8) return { state: "no box" };
        const x = rect.left + Math.min(24, Math.max(0, rect.width / 2));
        const y = rect.top + rect.height / 2;
        const hit = document.elementFromPoint(x, y);
        const onLine = !!(hit && (hit === line || line.contains(hit)));
        return { state: onLine ? "ready" : "covered", top: rect.top, x: x, y: y };
      })()`);
      if (!snap) return "missing";
      if (snap.state === "flashing") {
        sawFlash = true;
        placed = false;
        stillTop = null;
        point = null;
        return "flashing";
      }
      if (!sawFlash) return "waiting for the latch flash";
      if (!placed) {
        await evalJs(`(() => {
          const line = [...document.querySelectorAll("#paper .md-line")].find((el) => (el.innerText || "").includes("reading room stays open"));
          if (line) line.scrollIntoView({ block: "center", behavior: "auto" });
          return true;
        })()`);
        placed = true;
        stillTop = null;
        return "placing";
      }
      if (snap.state !== "ready") {
        stillTop = null;
        point = null;
        return snap.state;
      }
      if (stillTop == null || Math.abs(snap.top - stillTop) > 0.5) {
        stillTop = snap.top;
        point = null;
        return "moving";
      }
      point = { x: snap.x, y: snap.y };
      return true;
    }, 8000, "edit the day line");
    assert(point && point.x > 0 && point.y > 0, "showcase line is not on screen");
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved", x: point.x, y: point.y, button: "none",
    }, sessionId);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: point.x, y: point.y, button: "left", buttons: 1, clickCount: 1,
    }, sessionId);
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: point.x, y: point.y, button: "left", buttons: 0, clickCount: 1,
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

  let openedEdge = null;

  async function paperEdge() {
    return evalJs(`(() => {
      const title = document.getElementById("paper-title").getBoundingClientRect();
      const paper = document.getElementById("paper").getBoundingClientRect();
      const head = document.querySelector(".paper-head").getBoundingClientRect();
      return { title: title.left, paper: paper.left, head: head.left };
    })()`);
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
    const chairs = await evalJs(`(() => {
      const line = [...document.querySelectorAll("#paper .md-line")].find((el) => (el.innerText || "").includes("extra chairs"));
      const heading = document.querySelector("#paper .md-line.h1 .md-body");
      if (!line || line.classList.contains("done") || !heading) return "missing";
      const body = line.querySelector(".md-body");
      return getComputedStyle(body).color === getComputedStyle(heading).color;
    })()`);
    assert(chairs === true, "the open chairs line is dimmed");
    const monthOnce = await evalJs(`(() => {
      const label = document.getElementById("week-month");
      const text = label ? label.textContent : "";
      const shown = !!(label && getComputedStyle(label).display !== "none" && /[A-Za-z]+ \\d{4}/.test(text));
      const repeated = [...document.querySelectorAll(".day-card .moy")].filter((el) => getComputedStyle(el).display !== "none").length;
      return shown && repeated === 0;
    })()`);
    assert(monthOnce === true, "the week repeats the month on each tile");
    if (width === 390) {
      await evalJs(`(() => {
        document.getElementById("paper").focus();
        window.dispatchEvent(new Event("resize"));
        return true;
      })()`);
      const order = await evalJs(`[...document.querySelectorAll("#format-bar [data-fmt]")].map((button) => button.getAttribute("data-fmt")).join(",")`);
      assert(order === "task,heading,list,indent,outdent,undo,find,hide", "format bar order " + order);
      const icons = await evalJs(`[...document.querySelectorAll("#format-bar svg")].map((svg) => svg.innerHTML).join(" ")`);
      assert(icons.includes("M5.5 5v14") && icons.includes("M4 7h2") && icons.includes("9.6 12") && icons.includes("14.4 12") && icons.includes("M4.3 5.15h2.15"), "format icons drifted");
      const flush = await evalJs(`(() => {
        const bar = document.getElementById("format-bar").getBoundingClientRect();
        const ask = document.getElementById("ask-open").getBoundingClientRect();
        return Math.abs(ask.top - bar.bottom);
      })()`);
      assert(typeof flush === "number" && flush <= 2, "the bar is not flush on the find line (" + flush + ")");
      const clear = await evalJs(`(() => {
        const wrap = document.querySelector(".paper-wrap");
        wrap.scrollTop = wrap.scrollHeight;
        const last = [...document.querySelectorAll("#paper .md-line")].pop();
        const barTop = document.getElementById("format-bar").getBoundingClientRect().top;
        if (!last) return "no line";
        return last.getBoundingClientRect().bottom <= barTop + 1;
      })()`);
      assert(clear === true, "note text sits under the bar");
      await evalJs(`document.querySelector(".paper-wrap").scrollTop = 0`);
    } else {
      await evalJs(`(() => {
        const bar = document.getElementById("format-bar");
        bar.setAttribute("hidden", "");
        return bar.hidden;
      })()`);
      const hidden = await evalJs(`document.getElementById("format-bar").hidden === true`);
      assert(hidden === true, "the Mac shows the formatting bar");
      openedEdge = await paperEdge();
      assert(openedEdge && Math.abs(openedEdge.title - openedEdge.paper) <= 1, "the open title and the note do not share a left edge");
      const labels = await evalJs(`[...document.querySelectorAll("#timeline .block")].map((block) => block.textContent + (block.classList.contains("done") ? "|done" : "|open")).join(" || ")`);
      assert(typeof labels === "string" && labels.includes("Set out the extra chairs|open"), "chairs block: " + labels);
      assert(labels.includes("Sweep the stone steps|done"), "sweep block: " + labels);
      assert(labels.includes("Meet @Nim at 2026-03-20. The morning check is June 2, 8:15am.|open"), "meeting block: " + labels);
      assert(!labels.includes("- [ ]") && !labels.includes("@16:45") && !labels.includes("T08:15"), "timeline marks: " + labels);
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
    assert(!/still being read|older notes are|reading your notes|Opening\u2026/i.test(text), "first open mentions the background read");
    const spinner = await evalJs(`!!document.querySelector(".spinner, [aria-busy='true']")`);
    assert(spinner === false, "first open shows a spinner");
    await noSidewaysScroll();
  }

  async function prepareEditorLoading() {
    await reloadSample();
    await prepareToday();
    const started = await evalJs(`(() => {
      const start = performance.now();
      showEditorState("loading");
      const paper = document.getElementById("paper");
      const note = document.getElementById("editor-note");
      const quiet = !!paper && !!note && note.hidden === true && !(paper.innerText || "").trim() && note.textContent !== "Opening\u2026";
      return { start, quiet };
    })()`);
    assert(started && started.quiet === true, "loading spoke before a second or kept the note");
    // Opening is a one-second timer. The page clock has to land between about
    // 0.9s and 2s; a later poll must not stretch that into several seconds.
    const deadline = Date.now() + 2200;
    let shownAt = null;
    while (Date.now() < deadline) {
      const now = await evalJs(`(() => {
        const paper = document.getElementById("paper");
        const title = document.getElementById("paper-title");
        const week = document.querySelector(".week-row");
        const note = document.getElementById("editor-note");
        if (!paper || !title || !week || !note) return null;
        const titleBox = title.getBoundingClientRect();
        const weekBox = week.getBoundingClientRect();
        const ready = !document.querySelector(".spinner, [aria-busy='true']")
          && !(paper.innerText || "").trim()
          && (title.textContent || "").length > 0
          && week.querySelectorAll(".day-card").length === 7
          && note.hidden === false
          && note.textContent === "Opening\u2026"
          && titleBox.top >= weekBox.bottom - 1;
        return ready ? performance.now() : null;
      })()`);
      if (typeof now === "number") {
        shownAt = now;
        break;
      }
      await sleep(80);
    }
    assert(typeof shownAt === "number", "loading did not show the week, the title, and Opening");
    const elapsed = shownAt - started.start;
    assert(elapsed >= 900 && elapsed <= 2000, "Opening appeared at " + Math.round(elapsed) + "ms");
    const width = await evalJs(`document.documentElement.clientWidth`);
    if (width === 1280 && openedEdge) {
      const loadingEdge = await paperEdge();
      const titleShift = Math.abs(loadingEdge.title - openedEdge.title);
      const paperShift = Math.abs(loadingEdge.paper - openedEdge.paper);
      const shared = Math.abs(loadingEdge.title - loadingEdge.paper);
      assert(titleShift <= 1 && paperShift <= 1 && shared <= 1, "loading left edge title " + loadingEdge.title + " paper " + loadingEdge.paper + " opened title " + openedEdge.title + " paper " + openedEdge.paper);
    }
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
    const titleClear = await evalJs(`(() => {
      const title = document.getElementById("paper-title").getBoundingClientRect();
      const week = document.querySelector(".week-row").getBoundingClientRect();
      const note = document.getElementById("editor-note").getBoundingClientRect();
      return title.height > 8 && title.top >= week.bottom - 1 && note.top >= title.bottom - 1;
    })()`);
    assert(titleClear === true, "the failed-save title is under the week strip");
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
  let previous = null;
  for (const state of screens.states) {
    // The conflict sheet stays up for the edit that follows it. Any other
    // next step starts from the restored sample, so this shot can sit
    // immediately after today.
    if (previous === "conflict" && state !== "conflict-edit") await reloadSample();
    previous = state;
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

  const firstShot = fs.readFileSync(path.join(shotDir, "editor-first-1280.png"));
  const loadingShot = fs.readFileSync(path.join(shotDir, "editor-loading-1280.png"));
  assert(!firstShot.equals(loadingShot), "first open and loading are the same picture");
  await setWidth(390);
  await prepareEditorNormal();
  await evalJs(`document.documentElement.setAttribute("data-theme", "light")`);
  await evalJs(`(() => {
    document.getElementById("paper").focus();
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  const paperTone = await evalJs(`(() => {
    const bar = getComputedStyle(document.getElementById("format-bar"));
    const page = getComputedStyle(document.body);
    const barRgb = bar.backgroundColor.replace(/\\s/g, "");
    const pageRgb = page.backgroundColor.replace(/\\s/g, "");
    const marks = bar.color;
    return barRgb === pageRgb && /rgb\\(3[0-9],|rgb\\(2[0-9],|rgb\\(1[0-9],/.test(marks);
  })()`);
  assert(paperTone === true, "the light bar is not the paper color");
  await sleep(150);
  const lightShot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const lightBuf = Buffer.from(lightShot.data, "base64");
  const lightName = "editor-light-390.png";
  fs.writeFileSync(path.join(shotDir, lightName), lightBuf);
  shots.push(lightName);
  console.log("shot  " + lightName + "  " + lightBuf.length);
  await evalJs(`document.documentElement.removeAttribute("data-theme")`);

  await setWidth(1280);
  await expandRail();
  await evalJs(`(() => {
    document.getElementById("paper").focus();
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  const wideBar = await evalJs(`document.getElementById("format-bar").hidden === true || getComputedStyle(document.getElementById("format-bar")).display === "none"`);
  assert(wideBar === true, "the wide layout shows the formatting bar");

  await setWidth(390);
  await expandRail();
  await evalJs(`(() => {
    document.getElementById("paper").focus();
    window.dispatchEvent(new Event("resize"));
    return true;
  })()`);
  const editing = await evalJs(`(() => {
    const bar = document.getElementById("format-bar");
    const rail = document.querySelector(".today-rail");
    const ask = document.getElementById("ask-open");
    const barBox = bar.getBoundingClientRect();
    const railBox = rail.getBoundingClientRect();
    const askBox = ask.getBoundingClientRect();
    const hidden = bar.hidden || getComputedStyle(bar).display === "none";
    const overlaps = barBox.height > 0 && barBox.bottom > railBox.top + 1 && barBox.top < railBox.bottom - 1;
    return { hidden, overlaps, flush: Math.abs(barBox.bottom - askBox.top), above: barBox.bottom <= railBox.top + 1 };
  })()`);
  assert(editing && editing.hidden === false, "the focused editor hides the formatting bar");
  assert(editing.overlaps === false && editing.above === true, "the focused bar covers the timeline");
  assert(editing.flush <= 2, "the bar is not on the find line (" + (editing && editing.flush) + ")");
  await sleep(150);
  const editingShot = await send("Page.captureScreenshot", { format: "png" }, sessionId);
  const editingBuf = Buffer.from(editingShot.data, "base64");
  const editingName = "timeline-editing-390.png";
  fs.writeFileSync(path.join(shotDir, editingName), editingBuf);
  shots.push(editingName);
  console.log("shot  " + editingName + "  " + editingBuf.length);

  const expected = screens.states.length * screens.widths.length + 2;
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
