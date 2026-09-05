#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function doorBlock(from, until) {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start + 1);
  assert(start >= 0 && end > start, "block " + from);
  return src.slice(start, end);
}

function buttonTag(id) {
  const re = new RegExp("<button\\b[^>]*\\bid=\"" + id + "\"[^>]*>", "i");
  const m = html.match(re);
  assert(m, "missing button " + id);
  return m[0];
}

function buttonClass(id) {
  const tag = buttonTag(id);
  const m = tag.match(/\bclass="([^"]*)"/);
  return m ? m[1] : "";
}

function classList(id) {
  return buttonClass(id).split(/\s+/).filter(Boolean);
}

const results = [];

function check(name, run) {
  try {
    run();
    results.push({ name, ok: true });
    console.log("pass  " + name);
  } catch (err) {
    results.push({ name, ok: false, error: err.message });
    console.log("FAIL  " + name + "  " + err.message);
  }
}

check("Accept and Reject are hairline-button, not door-skip", () => {
  for (const id of ["door-accept", "door-reject"]) {
    const cls = classList(id);
    assert(cls.includes("hairline-button"), id + " must have class hairline-button, got " + buttonClass(id));
    assert(!cls.includes("door-skip"), id + " must not use door-skip class, got " + buttonClass(id));
  }
  assert(html.includes(">Accept<"), "Accept label");
  assert(html.includes(">Reject<"), "Reject label");
});

check("Get to Work and Capture thoughts are hairline-button", () => {
  assert(html.includes(">Get to Work<"), "Get to Work label");
  assert(html.includes(">Capture thoughts<"), "Capture thoughts label");
  for (const id of ["door-skip", "door-capture"]) {
    const cls = classList(id);
    assert(cls.includes("hairline-button"), id + " must have class hairline-button, got " + buttonClass(id));
  }
});

check("Capture thoughts calls goToday", () => {
  const capture = doorBlock(
    '$("door-capture").addEventListener("click"',
    '$("door-accept").addEventListener("click"'
  );
  assert(capture.includes("goToday()"), "Capture calls goToday");
  assert(capture.includes("hideDoorProposals()"), "Capture hides proposals");
  assert(capture.includes('input.value = ""') || capture.includes("input.value = ''"), "Capture clears input");
  assert(!capture.includes("saveDay"), "Capture must not saveDay");
  assert(!/\/api\/day/.test(capture), "Capture must not hit /api/day");
  assert(!/dump\.value/.test(capture), "Capture must not write dump");
});

check("Accept writes proposed lines through /api/day", () => {
  const accept = doorBlock(
    '$("door-accept").addEventListener("click"',
    '$("door-reject").addEventListener("click"'
  );
  assert(accept.includes("if (!doorProposed.length) return"), "Accept no-ops without proposals");
  assert(accept.includes("appendDoorTasks("), "Accept appends proposed tasks");
  assert(/\/api\/day/.test(accept), "Accept hits /api/day");
  assert(accept.includes('method: "PUT"'), "Accept PUTs the day");
  assert(accept.includes("goToday()"), "Accept goToday");
  assert(accept.includes("hideDoorProposals()"), "Accept hides proposals");
});

check("Reject clears Door and does not write", () => {
  const reject = doorBlock(
    '$("door-reject").addEventListener("click"',
    '$("toggle-month").addEventListener("click"'
  );
  assert(reject.includes("hideDoorProposals()"), "Reject hides proposals");
  assert(reject.includes('input.value = ""') || reject.includes("input.value = ''"), "Reject clears input");
  assert(!/\/api\/day/.test(reject), "Reject must not hit /api/day");
  assert(!reject.includes("goToday()"), "Reject stays on Door");
  assert(!reject.includes("saveDay"), "Reject must not saveDay");
});

check("day.css hairline-button is a 1px solid square", () => {
  const start = css.indexOf(".hairline-button {");
  assert(start >= 0, "missing .hairline-button");
  const end = css.indexOf("}", start);
  const block = css.slice(start, end + 1);
  assert(/border:\s*1px solid/.test(block), "hairline-button has border: 1px solid");
  assert(/border-radius:\s*0/.test(block), "hairline-button border-radius 0");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("door-accept-test ok  (" + results.length + " passed)");
