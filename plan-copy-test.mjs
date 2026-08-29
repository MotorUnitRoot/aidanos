#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ ok: true, name });
    console.log("pass ", name);
  } catch (e) {
    results.push({ ok: false, name, err: e.message });
    console.log("FAIL ", name, e.message);
  }
}

check("Plan chrome is Plan, not horse", () => {
  assert(html.includes('id="view-plan"'), "view-plan");
  assert(html.includes(">Plan<"), "nav or heading says Plan");
  assert(/Next steps/.test(html), "Next steps");
  assert(/Waiting/.test(html), "Waiting");
  assert(!/\bhorse\b/i.test(html), "HTML never says horse");
});

check("renderPlan paints the season title, never horse", () => {
  assert(/function planScreenTitle/.test(src), "planScreenTitle");
  assert(/planScreenTitle\(h\)/.test(src), "h1 uses season title");
  assert(/\\bhorse\\b/.test(src) && /return "Plan"/.test(src), "horse title falls back to Plan");
  const render = src.slice(src.indexOf("function renderPlan("), src.indexOf("async function loadPlan("));
  assert(!/textContent = "Plan"/.test(render), "must not hardcode Plan over the season title");
});

check("loadPlan repaints Plan after the file lands", () => {
  const load = src.slice(src.indexOf("async function loadPlan("), src.indexOf("function openAsk("));
  assert(/\/api\/plan/.test(load), "reads the season file");
  assert(/currentView\(\) === "plan"/.test(load), "repaint if already on Plan");
  assert(/renderPlan\(\)/.test(load), "calls renderPlan");
});

check("filename stays the season file; the man sees Plan", () => {
  assert(server.includes("active-horse.md"), "disk may keep the filename");
  assert(/function wikiNoteTitle/.test(src), "wikiNoteTitle");
  assert(/active-horse/.test(src) && /return "Plan"/.test(src), "active-horse paints as Plan");
  const titleFn = src.slice(src.indexOf("function wikiNoteTitle("), src.indexOf("async function openWiki("));
  assert(/\\bhorse\\b/.test(titleFn), "a horse stem never reaches the paper title");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("plan-copy-test ok  (" + results.length + " passed)");
