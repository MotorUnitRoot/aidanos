#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const boxStart = css.indexOf(".md-box {");
const doneStart = css.indexOf(".md-line.task.done .md-box");
assert(boxStart >= 0 && doneStart > boxStart, "md-box rule present");
const box = css.slice(boxStart, doneStart);
assert(/min-width:\s*1\.15em/.test(box) || /width:\s*1\.15em/.test(box), "box is at least 1.15em");
assert(/min-height:\s*1\.15em/.test(box) || /height:\s*1\.15em/.test(box), "box height is at least 1.15em");
assert(box.includes("::before"), "hit slop is ::before on the box, not the whole line");
assert(!/\.md-line\.task\s*\{[^}]*cursor:\s*pointer/.test(css), "the whole line is not the box");

assert(src.includes('e.target.closest(".md-box")') || src.includes("e.target.closest && e.target.closest(\".md-box\")"), "toggle is closest .md-box");
assert(src.includes("if (!box) return"), "click on words does not toggle");

const down = src.slice(
  src.indexOf('$("paper").addEventListener("mousedown"'),
  src.indexOf('$("paper").addEventListener("click"')
);
assert(down.includes(".md-box") && down.includes("preventDefault"), "mousedown on the box does not steal the caret");
console.log("checkbox-hit-test ok");
