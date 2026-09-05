#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(src.includes("async function landDoorQueryOnToday"), "Door lands maps");
assert(src.includes('await landDoorQueryOnToday(raw)'), "Door submit uses landDoorQueryOnToday");
const submit = src.slice(src.indexOf('$("door-form")'), src.indexOf('$("door-skip")'));
assert(submit.includes('if (!String(raw || "").trim())'), "empty Door skips land");
assert(submit.indexOf("landDoorQueryOnToday") < submit.indexOf("proposeDoorLines"), "map before sentence split");
assert(src.includes('$("door-skip").addEventListener("click"'), "Get to Work still exists");
const skip = src.slice(src.indexOf('$("door-skip")'), src.indexOf('$("door-capture")'));
assert(!skip.includes("landDoorQueryOnToday"), "empty Get to Work does not land maps");
assert(!skip.includes("proposeDoorLines"), "Get to Work does not invent tasks");
assert(src.includes('$("door-capture").addEventListener("click"'), "Capture thoughts exists");
const capture = src.slice(src.indexOf('$("door-capture")'), src.indexOf('$("door-accept")'));
assert(capture.includes("goToday()"), "Capture thoughts opens today");
assert(!capture.includes("landDoorQueryOnToday"), "Capture thoughts does not land maps");
console.log("pass  Door map path, empty Get to Work stays empty");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 3855;
const origin = `http://127.0.0.1:${PORT}`;
const vault = await fs.promises.mkdtemp(path.join(os.tmpdir(), "aidanos-door-"));
await fs.promises.mkdir(path.join(vault, "log"), { recursive: true });
await fs.promises.mkdir(path.join(vault, "maps"), { recursive: true });
const map = fs.readFileSync(path.join(__dirname, "vault/maps/file-a-receipt.md"), "utf8");
await fs.promises.writeFile(path.join(vault, "maps", "file-a-receipt.md"), map, "utf8");
const DATE = "2026-09-02";
await fs.promises.writeFile(path.join(vault, "log", DATE + ".md"), "", "utf8");

const child = spawn(process.execPath, [path.join(__dirname, "server.mjs")], {
  cwd: __dirname,
  env: { ...process.env, PORT: String(PORT), AIDANOS_VAULT: vault },
  stdio: ["ignore", "pipe", "pipe"],
});
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function cleanup() {
  try { child.kill("SIGTERM"); } catch {}
  await sleep(80);
  try { child.kill("SIGKILL"); } catch {}
  try { await fs.promises.rm(vault, { recursive: true, force: true }); } catch {}
}
process.on("exit", () => { try { child.kill("SIGKILL"); } catch {} });

try {
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    try {
      const r = await fetch(origin + "/api/health");
      if (r.ok) break;
    } catch {}
    await sleep(40);
  }
  const search = await fetch(origin + "/api/search?q=receipt");
  const hits = (await search.json()).hits || [];
  const mapHit = hits.find((h) => String(h.path).includes("file-a-receipt"));
  assert(mapHit, "search finds receipt map");
  const file = await fetch(origin + "/api/file?path=" + encodeURIComponent("maps/file-a-receipt.md"));
  const body = await file.json();
  // reuse mapNextStepLines via grab
  function grabFn(name, nextName) {
    const start = src.indexOf("function " + name + "(");
    const next = src.indexOf("function " + nextName + "(", start + 1);
    return src.slice(start, next);
  }
  const bundle = grabFn("mapNextStepLines", "appendDoorTasks") + grabFn("appendDoorTasks", "hideDoorProposals");
  const sandbox = {};
  new Function("sandbox", bundle + "\nsandbox.mapNextStepLines=mapNextStepLines;\nsandbox.appendMapTasks=appendMapTasks;\n")(sandbox);
  const steps = sandbox.mapNextStepLines(body.markdown);
  assert(steps.length === 4, "four receipt steps");
  const day = await (await fetch(origin + "/api/day?date=" + DATE)).json();
  const next = sandbox.appendMapTasks(day.markdown || "", steps);
  const put = await fetch(origin + "/api/day?date=" + DATE, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date: DATE, paper: next, markdown: next, mtime: day.mtime || 0 }),
  });
  assert(put.ok, "PUT day");
  const disk = await fs.promises.readFile(path.join(vault, "log", DATE + ".md"), "utf8");
  assert(disk.includes("- [ ] Find the receipt"), "Find on day");
  assert(disk.includes("- [ ] File the original"), "File on day");
  assert(!disk.includes("## Next steps"), "not a second map");
  console.log("pass  receipt map lands on empty day file");
} finally {
  await cleanup();
}
