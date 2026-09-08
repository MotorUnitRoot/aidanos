#!/usr/bin/env node
import fs from "node:fs";

const src = fs.readFileSync(new URL("./app.js", import.meta.url), "utf8");
const html = fs.readFileSync(new URL("./index.html", import.meta.url), "utf8");
const sw = fs.readFileSync(new URL("./sw.js", import.meta.url), "utf8");

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
  grabFn("stripAccidentalBulletSpace", "joinBrokenHyphens"),
  grabFn("joinBrokenHyphens", "normalizeCheckboxStub"),
  grabFn("normalizeCheckboxStub", "cleanPaperMarkdown"),
  grabFn("cleanPaperMarkdown", "normalizeSeasonPlanMarkdown"),
  grabFn("lineBody", "sourceTaskMarkdown"),
  grabFn("sourceTaskMarkdown", "serializeLine"),
  grabFn("serializeLine", "readPaper"),
].join("\n");

const sandbox = {};
const fn = new Function(
  "sandbox",
  bundle +
    "; sandbox.formatOneLine = formatOneLine;" +
    " sandbox.normalizeCheckboxStub = normalizeCheckboxStub;" +
    " sandbox.cleanPaperMarkdown = cleanPaperMarkdown;" +
    " sandbox.sourceTaskMarkdown = sourceTaskMarkdown;" +
    " sandbox.serializeLine = serializeLine;" +
    " sandbox.matchPaperTask = matchPaperTask;" +
    " sandbox.paperTaskSrc = paperTaskSrc;"
);
fn(sandbox);
const {
  formatOneLine,
  normalizeCheckboxStub,
  cleanPaperMarkdown,
  sourceTaskMarkdown,
  serializeLine,
} = sandbox;

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function fakeTask(body, { done = false, indent = "", mark = "-" } = {}) {
  return {
    classList: {
      contains: (c) => c === "is-source" || (c === "done" && done),
    },
    dataset: { kind: "task", indent, mark },
    querySelector: (sel) => sel === ".md-body" ? { innerText: body, textContent: body } : null,
    innerText: body,
    textContent: body,
  };
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

check("source task uses md-box + md-body, not raw - [ ] string", () => {
  const html = formatOneLine("- [ ] buy milk", true);
  assert(html.includes("is-source"), "missing is-source");
  assert(html.includes('data-kind="task"'), "missing task kind");
  assert(html.includes("md-box"), "missing md-box");
  assert(html.includes('class="md-body"'), "missing md-body");
  assert(/<span class="md-body">buy milk<\/span>/.test(html), "body should be editable text only: " + html);
  assert(!/>\s*- \[ \] buy milk/.test(html), "must not paint raw checkbox markdown");
  assert(html.includes('data-src="- [ ] buy milk"'), "data-src should be normalized: " + html);
});

check("source [] stub normalizes data-src to [ ]", () => {
  const html = formatOneLine("- [] buy milk", true);
  assert(html.includes("md-box"), "pretty chrome for [] stub");
  assert(html.includes('data-src="- [ ] buy milk"'), "[] should normalize to [ ]: " + html);
  assert(/<span class="md-body">buy milk<\/span>/.test(html), "body only");
});

check("source [x] keeps done chrome and data-src", () => {
  const html = formatOneLine("- [x] done item", true);
  assert(html.includes(" done"), "done class");
  assert(html.includes('aria-checked="true"'), "checked box");
  assert(html.includes('data-src="- [x] done item"'), "data-src keeps [x]: " + html);
  assert(/<span class="md-body">done item<\/span>/.test(html), "body only");
});

check("source heading special-case is unchanged", () => {
  const html = formatOneLine("## Hello", true);
  assert(html.includes("md-hash"), "heading keeps md-hash");
  assert(html.includes("is-source"), "heading is-source");
  assert(html.includes('data-kind="h"'), "heading kind");
  assert(/<span class="md-body">Hello<\/span>/.test(html), "heading body");
});

check("other source lines stay raw", () => {
  const html = formatOneLine("plain note", true);
  assert(html.includes("is-source"), "plain is-source");
  assert(html.includes("plain note"), "raw text present");
  assert(!html.includes("md-box"), "plain line is not a task");
  assert(!html.includes('data-kind="task"'), "plain is not task");
});

check("inactive task still pretty", () => {
  const html = formatOneLine("- [ ] buy milk", false);
  assert(html.includes("md-box"), "inactive md-box");
  assert(html.includes("md-body"), "inactive md-body");
  assert(!html.includes("is-source"), "inactive is not source");
});

check("normalizeCheckboxStub - [] → - [ ]", () => {
  assert(normalizeCheckboxStub("- []") === "- [ ]", JSON.stringify(normalizeCheckboxStub("- []")));
  assert(normalizeCheckboxStub("- [] buy") === "- [ ] buy", JSON.stringify(normalizeCheckboxStub("- [] buy")));
  assert(normalizeCheckboxStub("- [ ] keep") === "- [ ] keep", "already spaced");
  assert(normalizeCheckboxStub("- [x] done") === "- [x] done", "checked unchanged");
  assert(normalizeCheckboxStub("not a task []") === "not a task []", "non-task unchanged");
});

check("cleanPaperMarkdown runs normalizeCheckboxStub", () => {
  const out = cleanPaperMarkdown("- [] one\n- [x] two");
  assert(out.includes("- [ ] one"), "stub normalized: " + out);
  assert(out.includes("- [x] two"), "checked kept");
});

check("serializeLine / sourceTaskMarkdown rebuild - [ ] body", () => {
  const open = fakeTask("buy milk");
  assert(sourceTaskMarkdown(open) === "- [ ] buy milk", sourceTaskMarkdown(open));
  assert(serializeLine(open) === "- [ ] buy milk", serializeLine(open));
  const done = fakeTask("buy milk", { done: true });
  assert(sourceTaskMarkdown(done) === "- [x] buy milk", sourceTaskMarkdown(done));
  const nest = fakeTask("nested", { indent: "  ", mark: "-" });
  assert(sourceTaskMarkdown(nest) === "  - [ ] nested", sourceTaskMarkdown(nest));
});

check("cache bust task1 / shell v22", () => {
  assert(html.includes("/app.js?v=task1"), "index.html app.js ?v=task1");
  assert(/aidanos-shell-v22/.test(sw), "sw.js CACHE v22");
});

const failed = results.filter((r) => r.ok === false);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("paper-task-source-test ok  (" + results.length + " passed)");
