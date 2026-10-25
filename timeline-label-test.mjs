#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const start = src.indexOf("const WHEN_RE");
const end = src.indexOf("function escapeHtml");
if (start < 0 || end < 0) throw new Error("timeline helpers moved");
const sandbox = {};
const fn = new Function(
  "sandbox",
  src.slice(start, end) +
    "; sandbox.stripWhen = stripWhen; sandbox.parseBlocks = parseBlocks;"
);
fn(sandbox);
const { stripWhen, parseBlocks } = sandbox;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
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

check("a timeline block keeps the words and drops the marks", () => {
  const chairs = stripWhen("  - [ ] Set out the extra chairs @14:00");
  assert(chairs === "Set out the extra chairs", chairs);
  assert(!chairs.includes("- [ ]"), "checkbox mark stayed");
  assert(!chairs.includes("@"), "time tag stayed");
  const meet = stripWhen("Meet @Nim at @2026-03-20 16:45. The morning check is @2026-06-02T08:15.");
  assert(meet === "Meet @Nim at 2026-03-20. The morning check is 2026-06-02.", meet);
  assert(!meet.includes("@2026"), "a raw date tag stayed");
  assert(meet.includes("@Nim"), "the name was dropped");
  assert(meet.includes("2026-03-20"), "the date was dropped");
  assert(meet.includes("2026-06-02"), "the morning date was dropped");
});

check("done tasks are marked done and open tasks are not", () => {
  const text = [
    "- [ ] Oil the north window latch @09:30 @Nim",
    "- [x] Sweep the stone steps @08:00",
    "  - [ ] Set out the extra chairs @14:00",
    "Meet @Nim at @2026-03-20 16:45. The morning check is @2026-06-02T08:15.",
  ].join("\n");
  const blocks = parseBlocks(text, {});
  const byTime = Object.fromEntries(blocks.map((block) => [block.time, block]));
  assert(byTime["09:30"].text === "Oil the north window latch @Nim", byTime["09:30"].text);
  assert(byTime["09:30"].done === false, "the open latch was done");
  assert(byTime["08:00"].text === "Sweep the stone steps", byTime["08:00"].text);
  assert(byTime["08:00"].done === true, "the swept steps were not done");
  assert(byTime["14:00"].text === "Set out the extra chairs", byTime["14:00"].text);
  assert(byTime["14:00"].done === false, "the open chairs were done");
  assert(byTime["16:45"].text === "Meet @Nim at 2026-03-20. The morning check is 2026-06-02.", byTime["16:45"].text);
  assert(byTime["16:45"].done === false, "the meeting was done");
});

const failed = results.filter((item) => item.ok === false);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("timeline-label-test ok  (" + results.length + " passed)");
