#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const chrome = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"]
  .find((p) => fs.existsSync(p)) || "";

async function loadChromium() {
  try {
    return (await import("playwright-core")).chromium;
  } catch (e) {}
  const local = "/tmp/pw/node_modules/playwright-core/index.mjs";
  if (fs.existsSync(local)) return (await import(local)).chromium;
  return null;
}

if (!chrome) {
  console.log("skip  question caret: chrome is not installed");
  process.exit(0);
}
const chromium = await loadChromium();
if (!chromium) {
  console.log("skip  question caret: playwright-core is not installed");
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-questions-"));
fs.cpSync(path.join(root, "vault"), vault, { recursive: true });
const answersPath = path.join(vault, "family-room-to-office", "answers.md");
const port = 22000 + Math.floor(Math.random() * 2000);
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: root,
  env: {
    ...process.env,
    PORT: String(port),
    AIDANOS_HOST: "127.0.0.1",
    AIDANOS_VAULT: vault,
    AIDANOS_VAULT_GIT_URL: "",
    AIDANOS_VAULT_GIT_TOKEN: "",
    GITHUB_TOKEN: "",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
const base = "http://127.0.0.1:" + port;
let browser;

async function waitForFile(pred) {
  const deadline = Date.now() + 4000;
  let last = "";
  while (Date.now() < deadline) {
    last = fs.existsSync(answersPath) ? fs.readFileSync(answersPath, "utf8") : "";
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

try {
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    if (child.exitCode != null) throw new Error("server exited");
    try {
      const res = await fetch(base + "/api/health");
      if (res.ok) break;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 40));
  }

  browser = await chromium.launch({
    executablePath: chrome,
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(base + "/", { waitUntil: "domcontentloaded" });
  await page.locator("#door-input").click();
  await page.keyboard.type("I want to convert my family room to an office.", { delay: 8 });
  await page.keyboard.press("Enter");
  await page.locator(".md-q").first().waitFor({ timeout: 8000 });

  const question = "Which room, and will anyone sleep there?";
  const answer = "Family room, nobody sleeps there";
  await page.locator(".md-line.ol").nth(0).locator(".md-num").click();
  await page.keyboard.press("End");
  await page.keyboard.type(answer, { delay: 12 });
  let disk = await waitForFile((text) => text.includes(answer));
  assert(disk.includes("1. " + question + answer), "day file:\n" + disk);
  assert(!disk.includes("WFahich"), "the question was edited:\n" + disk);
  assert((await page.locator(".md-line.ol").nth(0).locator(".md-q").innerText()) === question, "line 1 question changed");

  await page.locator(".md-line.ol").nth(0).locator(".md-num").click();
  await page.keyboard.press("End");
  await page.keyboard.type("X", { delay: 20 });
  disk = await waitForFile((text) => text.includes(answer + "X"));
  assert(disk.includes("1. " + question + answer + "X"), "End did not reach the end:\n" + disk);
  assert(!disk.includes("X" + answer), "End left the cursor at the start:\n" + disk);

  await page.locator(".md-line.ol").nth(1).locator(".md-q").click();
  await page.keyboard.type("The built-in shelves", { delay: 12 });
  disk = await waitForFile((text) => text.includes("The built-in shelves"));
  assert(disk.includes("2. What must stay?The built-in shelves"), "mid-question type:\n" + disk);
  assert((await page.locator(".md-line.ol").nth(1).locator(".md-q").innerText()) === "What must stay?", "line 2 question changed");

  const wall = "Will any wall or opening change?";
  await page.locator(".md-line.ol").nth(2).locator(".md-num").click();
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Delete");
  await page.keyboard.type("Z", { delay: 20 });
  disk = await waitForFile((text) => text.includes(wall + "Z"));
  assert((await page.locator(".md-line.ol").nth(2).locator(".md-q").innerText()) === wall, "backspace ate the question");
  assert(disk.includes("3. " + wall + "Z"), "backspace wrote a broken question:\n" + disk);
  assert(!disk.includes("3. Will any wall or opening changZ"), "backspace deleted the question mark:\n" + disk);

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(async () => {
    // Runs in the page, where the clipboard lives.
    await globalThis.navigator.clipboard.writeText("PASTED");
  });
  await page.locator(".md-line.ol").nth(3).locator(".md-q").click();
  await page.keyboard.press("Control+v");
  disk = await waitForFile((text) => text.includes("PASTED"));
  const desk = "Where does the desk go, and which way does the door swing?";
  assert((await page.locator(".md-line.ol").nth(3).locator(".md-q").innerText()) === desk, "paste changed the question");
  assert(disk.includes("4. " + desk + "PASTED"), "paste did not land after the question:\n" + disk);

  await page.locator(".md-line.ol").nth(4).locator(".md-q").click();
  await page.evaluate(() => {
    const pageDocument = globalThis.document;
    const q = pageDocument.querySelectorAll(".md-line.ol")[4].querySelector(".md-q");
    const data = new pageDocument.defaultView.DataTransfer();
    data.setData("text/plain", "DROPPED");
    const Drop = pageDocument.defaultView.DragEvent;
    q.dispatchEvent(new Drop("dragover", { bubbles: true, cancelable: true, dataTransfer: data }));
    q.dispatchEvent(new Drop("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
  });
  await page.waitForTimeout(200);
  assert((await page.locator(".md-line.ol").nth(4).locator(".md-q").innerText()) === "What has to be plugged in, and where is the panel?", "drop changed the question");

  const shotDir = "/opt/cursor/artifacts/wk13-fix";
  if (fs.existsSync(shotDir)) {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.screenshot({ path: path.join(shotDir, "questions-locked-1280.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: path.join(shotDir, "questions-locked-390.png") });
  }
  console.log("pass  question caret browser");
} catch (err) {
  console.log("FAIL  question caret browser  " + (err && err.message || err));
  process.exitCode = 1;
} finally {
  try { if (browser) await browser.close(); } catch (e) {}
  try { child.kill("SIGTERM"); } catch (e) {}
  const stop = Date.now() + 2000;
  while (child.exitCode == null && Date.now() < stop) {
    await new Promise((r) => setTimeout(r, 40));
  }
  try { child.kill("SIGKILL"); } catch (e) {}
  try { fs.rmSync(vault, { recursive: true, force: true }); } catch (e) {}
}
if (process.exitCode) process.exit(process.exitCode);
