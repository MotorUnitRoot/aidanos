#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("./day.css", import.meta.url), "utf8");
const day26 = fs.readFileSync(new URL("./vault/log/2026-08-26.md", import.meta.url), "utf8");

function grabFn(name, nextName) {
  const start = src.indexOf("function " + name + "(");
  if (start < 0) throw new Error("missing " + name);
  const nextFn = src.indexOf("\nfunction " + nextName + "(", start + 1);
  const nextAsync = src.indexOf("\nasync function " + nextName + "(", start + 1);
  const cands = [nextFn, nextAsync].filter((i) => i >= 0);
  if (!cands.length) throw new Error("missing next " + nextName);
  return src.slice(start, Math.min(...cands)).replace(/\s+async\s*$/, "\n");
}

const bundle = [
  grabFn("escapeHtml", "attr"),
  grabFn("attr", "paintInline"),
  grabFn("paintInline", "indentPad"),
  grabFn("indentPad", "formatOneLine"),
  grabFn("formatOneLine", "formatPaper"),
  grabFn("formatPaper", "stripAccidentalBulletSpace"),
].join("\n");

const sandbox = {};
const fn = new Function(
  "sandbox",
  bundle +
    "; sandbox.frontmatterLineCount = frontmatterLineCount;" +
    " sandbox.formatPaper = formatPaper;" +
    " sandbox.formatOneLine = formatOneLine;"
);
fn(sandbox);
const { frontmatterLineCount, formatPaper } = sandbox;

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

const yaml26 = [
  "---",
  "date: 2026-08-26",
  "role: Train",
  "energy: green",
  "mission_eve: false",
  'hard_stop: "21:30"',
  "---",
  "",
].join("\n");

check("frontmatterLineCount(26th-shaped yaml) > 0", () => {
  const n = frontmatterLineCount(yaml26);
  assert(n > 0, "expected > 0, got " + n);
});

check('frontmatterLineCount("hello") === 0', () => {
  assert(frontmatterLineCount("hello") === 0, "plain text must be 0");
});

check("formatPaper yaml+body includes md-front and the body", () => {
  const body = "hello from the paper";
  const html = formatPaper(yaml26 + body);
  assert(html.includes("md-front"), "missing md-front class: " + html.slice(0, 200));
  assert(html.includes(body), "missing body text");
  const frontHits = (html.match(/md-front/g) || []).length;
  assert(frontHits > 0, "no md-front hits");
});

check("goToday source has openDay(todayIso()) and state.doc = null", () => {
  const start = src.indexOf("function goToday(");
  assert(start >= 0, "missing goToday");
  const next = src.indexOf("\nfunction ", start + 1);
  const go = src.slice(start, next > start ? next : start + 800);
  assert(go.includes("openDay(todayIso())"), "goToday must call openDay(todayIso())");
  assert(/state\.doc\s*=\s*null/.test(go), "goToday must set state.doc = null");
});

check("vault/log/2026-08-26.md still starts with ---", () => {
  assert(day26.startsWith("---"), "26th must still start with ---, got " + JSON.stringify(day26.slice(0, 20)));
});

check("day.css hides .md-line.md-front", () => {
  assert(/\.md-line\.md-front\s*\{\s*display:\s*none\s*;?\s*\}/.test(css), "missing .md-line.md-front { display: none }");
});

check("no code seeds ## Mark / ## Becoming / ## Architecture into a new day", () => {
  const server = fs.readFileSync(new URL("./server.mjs", import.meta.url), "utf8");
  const hay = src + "\n" + server;
  assert(!/## Mark/.test(hay), "must not write ## Mark");
  assert(!/## Becoming/.test(hay), "must not write ## Becoming");
  assert(!/## Architecture/.test(hay), "must not write ## Architecture");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("today-frontmatter-test ok  (" + results.length + " passed)");
