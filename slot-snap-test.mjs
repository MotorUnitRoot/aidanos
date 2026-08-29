#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");

function grabFn(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const next = src.indexOf("function " + nextName + "(", start + 1);
  if (next < 0) throw new Error("missing next " + nextName);
  return src.slice(start, next);
}

const bundle = grabFn("slotIndexAtY", "slotAtPoint");
const sandbox = {};
const fn = new Function("sandbox", bundle + "; sandbox.slotIndexAtY = slotIndexAtY;");
fn(sandbox);
const { slotIndexAtY } = sandbox;

const results = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
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

const first = { top: 100, bottom: 150 };
const second = { top: 150, bottom: 200 };
const rects = [first, second];

check("y inside 15:00 rect → 0", () => {
  const y = (first.top + first.bottom) / 2;
  assert(y > first.top && y < first.bottom, "fixture y must sit inside first");
  assert(slotIndexAtY(rects, y) === 0, "got " + slotIndexAtY(rects, y));
});

check("y === 15:30.top (= 15:00.bottom) → 1", () => {
  assert(second.top === first.bottom, "fixture: 15:30.top must equal 15:00.bottom");
  assert(slotIndexAtY(rects, second.top) === 1, "got " + slotIndexAtY(rects, second.top));
});

check("y just below 15:00.top (inside 15:00) → 0", () => {
  const y = first.top + 1;
  assert(y >= first.top && y < first.bottom, "fixture y must sit inside first");
  assert(slotIndexAtY(rects, y) === 0, "got " + slotIndexAtY(rects, y));
});

check("y < first.top → 0", () => {
  assert(slotIndexAtY(rects, first.top - 20) === 0, "got " + slotIndexAtY(rects, first.top - 20));
});

check("y >= last.bottom → last", () => {
  assert(slotIndexAtY(rects, second.bottom) === 1, "got " + slotIndexAtY(rects, second.bottom));
  assert(slotIndexAtY(rects, second.bottom + 40) === 1, "got " + slotIndexAtY(rects, second.bottom + 40));
});

check("empty rects → -1", () => {
  assert(slotIndexAtY([], 120) === -1, "got " + slotIndexAtY([], 120));
});

check("highlightSlotAt / endSlotDrag call slotAtPoint, not elementFromPoint", () => {
  const hl = grabFn("highlightSlotAt", "endSlotDrag");
  assert(hl.includes("slotAtPoint("), "highlightSlotAt must call slotAtPoint");
  assert(!/elementFromPoint/.test(hl), "highlightSlotAt must not use elementFromPoint");
  const endStart = src.indexOf("function endSlotDrag(");
  assert(endStart >= 0, "missing endSlotDrag");
  const endNext = src.indexOf("\nfunction ", endStart + 1);
  const end = src.slice(endStart, endNext > endStart ? endNext : endStart + 600);
  assert(end.includes("slotAtPoint("), "endSlotDrag must call slotAtPoint");
  assert(!/elementFromPoint/.test(end), "endSlotDrag must not use elementFromPoint");
  const at = grabFn("slotAtPoint", "paintSlotGhost");
  assert(at.includes("getBoundingClientRect("), "slotAtPoint must use getBoundingClientRect");
  assert(at.includes("slotIndexAtY("), "slotAtPoint must use slotIndexAtY");
  assert(!/elementFromPoint/.test(at), "slotAtPoint must not use elementFromPoint");
  assert(end.includes("applyWhen(text, slot.dataset.time)"), "endSlotDrag must applyWhen(text, slot.dataset.time)");
});

check("ghost block is painted on the slot during drag", () => {
  const hl = grabFn("highlightSlotAt", "endSlotDrag");
  assert(hl.includes("paintSlotGhost("), "highlightSlotAt must paint a slot ghost");
  const paint = grabFn("paintSlotGhost", "clearSlotGhost");
  assert(paint.includes('"block ghost"') || paint.includes("'block ghost'") || paint.includes("slot-fill"), "paintSlotGhost must set class block ghost or slot-fill");
  assert(paint.includes(".slot-lane"), "ghost must land in .slot-lane");
  assert(paint.includes("stripWhen(text)"), "ghost shows the line, not raw markdown");
  const endStart = src.indexOf("function endSlotDrag(");
  const endNext = src.indexOf("\nfunction ", endStart + 1);
  const end = src.slice(endStart, endNext > endStart ? endNext : endStart + 600);
  assert(end.includes("clearSlotGhost("), "endSlotDrag must clear the slot ghost");
  assert(/\.block\.ghost[\s\S]{0,80}pointer-events:\s*none/.test(css) || /pointer-events:\s*none/.test(paint), "ghost pointer-events none");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("slot-snap-test ok  (" + results.length + " passed)");
