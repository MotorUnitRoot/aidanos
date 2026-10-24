#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function grabFn(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const nextFn = src.indexOf("\nfunction " + nextName + "(", start + 1);
  if (nextFn < 0) throw new Error("missing next " + nextName);
  return src.slice(start, nextFn);
}

const bundle = [
  grabFn("matchPaperTask", "paperTaskSrc"),
  grabFn("paperTaskSrc", "paintTaskBodyHtml"),
  grabFn("indentDumpLine", "outdentDumpLine"),
  grabFn("outdentDumpLine", "formatBarBody"),
  grabFn("formatBarBody", "formatBarTaskLine"),
  grabFn("formatBarTaskLine", "formatBarHeadingLine"),
  grabFn("formatBarHeadingLine", "formatBarListLine"),
  grabFn("formatBarListLine", "formatBarApply"),
  grabFn("formatBarApply", "emptyListPrefix"),
].join("\n");

const sandbox = {};
const load = new Function(
  "sandbox",
  bundle +
    "; sandbox.formatBarTaskLine = formatBarTaskLine;" +
    " sandbox.formatBarHeadingLine = formatBarHeadingLine;" +
    " sandbox.formatBarListLine = formatBarListLine;" +
    " sandbox.formatBarApply = formatBarApply;" +
    " sandbox.indentDumpLine = indentDumpLine;" +
    " sandbox.outdentDumpLine = outdentDumpLine;"
);
load(sandbox);
const {
  formatBarTaskLine,
  formatBarHeadingLine,
  formatBarListLine,
  formatBarApply,
  indentDumpLine,
  outdentDumpLine,
} = sandbox;

const note = ["Keep this", "Buy milk", "Leave this"].join("\n");

function currentOnly(action, middle) {
  const out = formatBarApply(note, 1, action);
  const lines = out.split("\n");
  assert(lines.length === 3, action + " keeps the other lines");
  assert(lines[0] === "Keep this", action + " leaves the line above");
  assert(lines[2] === "Leave this", action + " leaves the line below");
  assert(lines[1] === middle, action + " changes the current line, got " + JSON.stringify(lines[1]));
}

currentOnly("task", "- [ ] Buy milk");
currentOnly("heading", "## Buy milk");
currentOnly("list", "- Buy milk");
currentOnly("indent", "  Buy milk");
assert(formatBarApply(note, 1, "outdent") === note, "outdent leaves a line that is already at the margin");

const indented = ["Keep this", "  Buy milk", "Leave this"].join("\n");
assert(formatBarApply(indented, 1, "outdent") === note, "outdent removes one level from the current line only");
assert(formatBarApply(indented, 1, "indent").split("\n")[1] === "    Buy milk", "indent adds one level on the current line");

assert(formatBarTaskLine("- Buy milk") === "- [ ] Buy milk", "a bullet becomes a task");
assert(formatBarTaskLine("* Buy milk") === "- [ ] Buy milk", "a star bullet becomes a task");
assert(formatBarTaskLine("1. Buy milk") === "- [ ] Buy milk", "a numbered line becomes a task");
assert(formatBarTaskLine("  nested") === "  - [ ] nested", "an indented line keeps its indent as a task");
assert(formatBarTaskLine("- [ ] Buy milk") === "- [x] Buy milk", "a task toggles done");
assert(formatBarTaskLine("- [x] Buy milk") === "- [ ] Buy milk", "a done task toggles open");
assert(formatBarTaskLine("* [ ] Buy milk") === "* [x] Buy milk", "a star task keeps its mark");
assert(formatBarTaskLine("# Buy milk") === "# Buy milk", "a heading stays a heading");
assert(formatBarTaskLine("## Why") === "## Why", "a section heading is not turned into a task");
assert(formatBarTaskLine("") === "- [ ] ", "an empty line becomes an empty task");

assert(formatBarHeadingLine("Buy milk") === "## Buy milk", "a plain line becomes a level-2 heading");
assert(formatBarHeadingLine("## Buy milk") === "Buy milk", "pressing heading again on a level-2 heading switches it off");
assert(formatBarHeadingLine("## Why") === "Why", "a level-2 heading switches off to its body");
assert(formatBarHeadingLine("## ") === "", "an empty level-2 heading switches off");
assert(formatBarHeadingLine("# Buy milk") === "## Buy milk", "a level-1 heading becomes level 2");
assert(formatBarHeadingLine("### Deep") === "## Deep", "a deeper heading becomes level 2");
assert(formatBarHeadingLine(formatBarHeadingLine("Buy milk")) === "Buy milk", "heading toggles back to the line");
assert(formatBarHeadingLine(formatBarHeadingLine("## Section")) === "## Section", "switching a level-2 heading off and on restores it");
assert(formatBarHeadingLine("- [ ] Buy milk") === "## Buy milk", "a task's body becomes a level-2 heading");
assert(formatBarHeadingLine("- Buy milk") === "## Buy milk", "a list's body becomes a level-2 heading");
assert(formatBarHeadingLine("1. Buy milk") === "## Buy milk", "a numbered line becomes a level-2 heading");
assert(formatBarHeadingLine("  nested") === "## nested", "an indented line becomes a level-2 heading");
assert(formatBarHeadingLine("") === "## ", "an empty line becomes an empty level-2 heading");

assert(formatBarListLine("- Buy milk") === "Buy milk", "a bullet toggles off");
assert(formatBarListLine("* Buy milk") === "Buy milk", "a star bullet toggles off");
assert(formatBarListLine("+ Buy milk") === "Buy milk", "a plus bullet toggles off");
assert(formatBarListLine("1. Buy milk") === "Buy milk", "a numbered line toggles off");
assert(formatBarListLine("2) Buy milk") === "Buy milk", "a parenthesis number toggles off");
assert(formatBarListLine("- [ ] Buy milk") === "- Buy milk", "a task becomes a bullet");
assert(formatBarListLine("- [x] Buy milk") === "- Buy milk", "a done task becomes a bullet");
assert(formatBarListLine("# Buy milk") === "- Buy milk", "a heading becomes a bullet");
assert(formatBarListLine("## Why") === "- Why", "a level-2 heading becomes a bullet");
assert(formatBarListLine("  Buy milk") === "  - Buy milk", "indent is kept when a line becomes a list");
assert(formatBarListLine("  - Buy milk") === "  Buy milk", "a nested bullet toggles off and keeps indent");
assert(formatBarListLine("") === "- ", "an empty line becomes an empty bullet");
assert(formatBarListLine(formatBarListLine("Buy milk")) === "Buy milk", "list toggles back to the line");

assert(indentDumpLine("- [ ] Buy milk") === "  - [ ] Buy milk", "indent shifts the whole current line");
assert(outdentDumpLine("    - Buy milk") === "  - Buy milk", "outdent removes two spaces");
assert(outdentDumpLine("\tBuy milk") === "Buy milk", "outdent removes a tab");
assert(outdentDumpLine(" Buy milk") === " Buy milk", "a single space is not a level");

const bar = html.slice(html.indexOf('id="format-bar"'), html.indexOf("<script"));
const labels = [...bar.matchAll(/<button[^>]*aria-label="([^"]+)"/g)].map((m) => m[1]);
assert(labels.join(",") === "Task,Heading,List,Indent,Outdent,Undo,Find,Hide keyboard", "button labels: " + labels.join(","));
const acts = [...bar.matchAll(/data-fmt="([^"]+)"/g)].map((m) => m[1]);
assert(acts.join(",") === "task,heading,list,indent,outdent,undo,find,hide", "button order: " + acts.join(","));
function buttonBlock(act) {
  const m = bar.match(new RegExp('<button[^>]*data-fmt="' + act + '"[\\s\\S]*?</button>'));
  assert(m, "missing button " + act);
  return m[0];
}
const indentSvg = buttonBlock("indent");
const outdentSvg = buttonBlock("outdent");
assert(indentSvg !== outdentSvg, "indent and outdent are different drawings");
assert(indentSvg.includes("10.2 12") && indentSvg.includes("M12 5h9.5"), "indent shows lines with an arrow pointing right");
assert(outdentSvg.includes("13.8 12") && outdentSvg.includes("M2.5 5h9.5"), "outdent shows the same lines with an arrow pointing left");
const hideSvg = buttonBlock("hide");
const keyCaps = (hideSvg.match(/<rect /g) || []).length;
assert(keyCaps >= 9, "hide keyboard draws key caps, got " + keyCaps);
assert(hideSvg.includes("M7.5 17.5"), "a down chevron sits under the keyboard");
assert(!bar.includes("Wand") && !bar.includes("Command") && !bar.includes("Text style"), "removed buttons stay gone");
assert(!html.includes("fmt-bar") && !html.includes("fmt-btn"), "old bar classes are gone");

const wire = src.slice(src.indexOf("function wireFormatBar("), src.indexOf("function bindConflict("));
assert(wire.includes('act === "task"') && wire.includes("fmtToggleTaskLine()"), "task button");
assert(wire.includes('act === "heading"') && wire.includes("fmtHeadingLine()"), "heading button");
assert(wire.includes('act === "list"') && wire.includes("fmtListLine()"), "list button");
assert(wire.includes('act === "indent"') && wire.includes("fmtIndentLine()"), "indent button");
assert(wire.includes('act === "outdent"') && wire.includes("fmtOutdentLine()"), "outdent button");
assert(wire.includes('act === "undo"') && wire.includes("runPaperUndoAction()"), "undo button");
assert(wire.includes('act === "find"') && wire.includes("moveCursorToFindLine()"), "find button");
assert(wire.includes('act === "hide"') && wire.includes("hidePhoneKeyboard()"), "hide keyboard button");
assert(!wire.includes('act === "style"') && !wire.includes('act === "wand"') && !wire.includes('act === "command"'), "old handlers are gone");
assert(!src.includes("fmtBoldSelectionOrLine"), "text-style handler is gone");
assert(src.includes('"(max-width: 640px)"') || src.includes("(max-width: 640px)"), "phone width gates the bar");
assert(!src.includes("pointer: coarse"), "a wide window does not grow the bar");

assert(css.includes("/* Formatting bar above keyboard */"), "stylesheet names the bar");
assert(!css.includes("fmt-bar") && !css.includes("fmt-btn") && !css.includes("fmt-ico"), "old bar classes are gone from css");
const rule = css.slice(css.indexOf(".format-bar {"), css.indexOf(".format-btn {"));
assert(/background:\s*var\(--bg\)/.test(rule), "bar uses the paper background");
assert(/border-radius:\s*0/.test(rule), "bar is not a pill");
assert(/box-shadow:\s*none/.test(rule), "bar has no floating shadow");
assert(!rule.includes("#1c1c1e"), "bar has no dark fill");
assert(/min-height:\s*max\(44px,\s*var\(--tap\)\)/.test(css), "buttons are at least 44px");
const wide = css.slice(css.indexOf("@media (min-width: 641px)"));
assert(wide.includes(".format-bar") && /display:\s*none\s*!important/.test(wide), "wide windows hide the bar");

const bannedStyle = "NotePlan" + "-style";
const bannedCapsule = "cap" + "sule";
function filesUnder(dir, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name === ".git") continue;
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}
for (const file of filesUnder(root, [])) {
  const text = fs.readFileSync(file, "utf8");
  assert(!text.includes(bannedStyle), path.relative(root, file) + " still says " + bannedStyle);
  if (file.endsWith("day.css") || file.endsWith("app.js") || file.endsWith("index.html")) {
    assert(!text.includes(bannedCapsule), path.relative(root, file) + " still names the old shape");
  }
}

console.log("format-bar-test ok");
