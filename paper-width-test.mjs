#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function rule(sel) {
  const i = css.indexOf(sel + " {");
  assert(i >= 0, sel + " missing");
  const rest = css.slice(i);
  const end = rest.indexOf("\n}");
  assert(end > 0, sel + " unclosed");
  return rest.slice(0, end);
}

const wrap = rule(".paper-wrap");
const paper = rule(".paper");
const head = rule(".paper-head");

assert(/align-items:\s*center/.test(wrap), "paper-wrap centers in the column");
assert(/width:\s*42rem/.test(paper), "paper is 42rem");
assert(/max-width:\s*100%/.test(paper), "paper shrinks in a narrow column, does not stretch past 42rem");
assert(/margin-left:\s*auto/.test(paper) && /margin-right:\s*auto/.test(paper), "paper is centered, not jammed left");
assert(/width:\s*42rem/.test(head), "paper-head is 42rem");
assert(/margin:\s*0 auto/.test(head) || (/margin-left:\s*auto/.test(head) && /margin-right:\s*auto/.test(head)), "paper-head is centered");
assert(!/^\s*width:\s*100%;/m.test(paper), "paper is not stretched to fill");
console.log("paper-width-test ok");
