#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");

function grabFn(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const next = src.indexOf("function " + nextName + "(", start + 1);
  if (next < 0) throw new Error("missing next " + nextName);
  return src.slice(start, next);
}

const helperSrc = grabFn("proposeDoorLines", "mapNextStepLines");
const sandbox = {};
const fn = new Function(
  "sandbox",
  helperSrc + "; sandbox.proposeDoorLines = proposeDoorLines;"
);
fn(sandbox);
const { proposeDoorLines } = sandbox;

const results = [];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function same(got, want, label) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  assert(g === w, label + ": " + g + " != " + w);
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

function doorBlock(from, until) {
  const start = src.indexOf(from);
  const end = src.indexOf(until, start + 1);
  assert(start >= 0 && end > start, "block " + from);
  return src.slice(start, end);
}

check("empty / whitespace → []", () => {
  same(proposeDoorLines(""), [], "empty string");
  same(proposeDoorLines("   "), [], "spaces");
  same(proposeDoorLines("\t\n"), [], "whitespace");
  same(proposeDoorLines(null), [], "null");
});

check("single clause is one line", () => {
  same(proposeDoorLines("write the letter"), ["- [ ] write the letter"], "one clause");
});

check("split and / or comma / semicolon", () => {
  same(
    proposeDoorLines("sit the door and walk"),
    ["- [ ] sit the door", "- [ ] walk"],
    "and"
  );
  same(
    proposeDoorLines("sit the door, walk"),
    ["- [ ] sit the door", "- [ ] walk"],
    "comma"
  );
  same(
    proposeDoorLines("sit the door; walk"),
    ["- [ ] sit the door", "- [ ] walk"],
    "semicolon"
  );
  same(
    proposeDoorLines("sit, walk, and rest"),
    ["- [ ] sit", "- [ ] walk", "- [ ] rest"],
    "comma and"
  );
});

check("do not invent extra tasks", () => {
  const got = proposeDoorLines("write the letter");
  assert(got.length === 1, "one clause stays one task");
  assert(!got.some((line) => /mark/i.test(line)), "must not invent Mark");
});

check("helper never says horse or Mark", () => {
  assert(!/\bhorse\b/i.test(helperSrc) && !/\bMark\b/.test(helperSrc), "proposeDoorLines source");
});

check("submit-with-text proposes and does not write", () => {
  const submit = doorBlock(
    '$("door-form").addEventListener("submit"',
    '$("door-skip").addEventListener("click"'
  );
  assert(submit.includes("e.preventDefault()"), "preventDefault");
  assert(submit.includes("proposeDoorLines("), "submit proposes");
  assert(submit.includes("paintDoorProposals("), "paints proposals");
  assert(!submit.includes("saveDay"), "submit must not saveDay");
  assert(!submit.includes("openDay"), "submit must not openDay");
  assert(!/\/api\/day/.test(submit), "submit must not hit /api/day");
  assert(!/\bPUT\b/.test(submit), "submit must not PUT");
  assert(!submit.includes("applyDoorPending"), "applyDoorPending stays dead");
  assert(!/sessionStorage/.test(submit), "no sessionStorage dump inject");
  assert(!/dump\.value/.test(submit), "must not append to dump");
  const withText = submit.match(/if \(lines\.length\) \{[\s\S]*?return;\s*\}/);
  assert(withText, "with-text branch");
  assert(withText[0].includes("paintDoorProposals("), "with-text paints");
  assert(!withText[0].includes("goToday"), "with-text does not goToday");
  assert(!withText[0].includes("saveDay"), "with-text does not saveDay");
  assert(submit.includes("goToday()"), "empty Enter still goToday");
  assert(submit.includes("hideDoorProposals()"), "empty Enter hides proposals");
});

check("Get to Work / empty still skip, no dump write", () => {
  const skip = doorBlock(
    '$("door-skip").addEventListener("click"',
    "(function wireDoorCapture()"
  );
  assert(skip.includes('input.value = ""') || skip.includes("input.value = ''"), "clears input");
  assert(skip.includes("hideDoorProposals()"), "hides proposals");
  assert(skip.includes("goToday()"), "Get to Work goToday");
  assert(!skip.includes("saveDay"), "skip must not saveDay");
  assert(!skip.includes("openDay"), "skip must not openDay");
  assert(!/\/api\/day/.test(skip), "skip must not hit /api/day");
  assert(!skip.includes("applyDoorPending"), "applyDoorPending stays dead");
  assert(!/dump\.value/.test(skip), "skip must not append to dump");
});

check("applyDoorPending stays dead", () => {
  assert(!src.includes("function applyDoorPending"), "no applyDoorPending function");
  const propose = src.slice(src.indexOf("function proposeDoorLines("), src.indexOf("function mapNextStepLines("));
  assert(!/dump\.value\s*=/.test(propose), "proposeDoorLines must not write dump");
  const submit = doorBlock(
    '$("door-form").addEventListener("submit"',
    '$("door-skip").addEventListener("click"'
  );
  assert(!/dump\.value\s*=/.test(submit), "Door submit must not write dump.value");
  const skip = doorBlock(
    '$("door-skip").addEventListener("click"',
    "(function wireDoorCapture()"
  );
  assert(!/dump\.value\s*=/.test(skip), "Get to Work must not write dump.value");
});

check("Door UI paints proposals, no Mark / horse", () => {
  assert(html.includes('id="door-proposals"'), "proposals slot");
  assert(css.includes(".door-proposals"), "proposals style");
  const doorHtml = html.slice(html.indexOf('id="view-door"'), html.indexOf('id="view-today"'));
  assert(!/\bhorse\b/i.test(doorHtml) && !/\bMark\b/.test(doorHtml), "Door HTML never says horse or Mark");
  const doorCssStart = css.indexOf("/* ——— Door ——— */");
  const doorCssEnd = css.indexOf("/* ——— Today room ——— */");
  const doorCss = css.slice(doorCssStart, doorCssEnd);
  assert(!/\bhorse\b/i.test(doorCss) && !/\bMark\b/.test(doorCss), "Door CSS never says horse or Mark");
});

check("Capture thoughts opens a blank Capture note", () => {
  assert(html.includes('id="door-capture"'), "capture id");
  assert(html.includes(">Get to Work<"), "Get to Work label");
  assert(html.includes(">Capture thoughts<"), "Capture thoughts label");
  assert(html.includes('class="hairline-button"'), "hairline-button class");
  assert(html.includes('class="door-actions"'), "side-by-side wrapper");
  const capture = doorBlock(
    "(function wireDoorCapture()",
    '$("door-accept").addEventListener("click"'
  );
  assert(src.includes("async function openCaptureNote("), "openCaptureNote exists");
  assert(capture.includes("openCaptureNote()"), "Capture openCaptureNote");
  assert(!capture.includes("goToday()"), "Capture does not goToday");
  assert(capture.includes("hideDoorProposals()"), "Capture hides");
  assert(!/dump\.value\s*=/.test(capture), "Capture must not write dump");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("door-propose-test ok  (" + results.length + " passed)");
