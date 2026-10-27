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
  grabFn("continueLinePrefix", "splitDumpLine"),
  grabFn("splitDumpLine", "indentDumpLine"),
  grabFn("lineBody", "sourceTaskMarkdown"),
  grabFn("sourceTaskMarkdown", "serializeLine"),
  grabFn("serializeLine", "readPaper"),
  grabFn("isSourceTask", "clampPaperCaret"),
  grabFn("clampPaperCaret", "paperCaretHost"),
  grabFn("paperCaretHost", "ensurePaperBodyCaret"),
  grabFn("ensurePaperBodyCaret", "placeCaret"),
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
    " sandbox.paperTaskSrc = paperTaskSrc;" +
    " sandbox.continueLinePrefix = continueLinePrefix;" +
    " sandbox.splitDumpLine = splitDumpLine;" +
    " sandbox.paperCaretHost = paperCaretHost;" +
    " sandbox.ensurePaperBodyCaret = ensurePaperBodyCaret;" +
    " sandbox.paintTaskBodyHtml = paintTaskBodyHtml;"
);
fn(sandbox);
const {
  formatOneLine,
  normalizeCheckboxStub,
  cleanPaperMarkdown,
  sourceTaskMarkdown,
  serializeLine,
  continueLinePrefix,
  splitDumpLine,
  paperCaretHost,
  ensurePaperBodyCaret,
  paintTaskBodyHtml,
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

check("source [] stub keeps the typed line and still draws a box", () => {
  const html = formatOneLine("- [] buy milk", true);
  assert(html.includes("md-box"), "pretty chrome for [] stub");
  assert(html.includes('data-src="- [] buy milk"'), "[] must stay typed: " + html);
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

check("open, done, cancelled, and scheduled draw the same way", () => {
  const open = formatOneLine("- [ ] Oil the latch", false);
  const lower = formatOneLine("- [x] Sweep", false);
  const upper = formatOneLine("- [X] Count the spare bulbs", false);
  const cancelled = formatOneLine("- [-] cancelled words", false);
  const scheduled = formatOneLine("- [>] scheduled words", false);
  assert(open.includes("md-box") && open.includes('aria-checked="false"'), "open box: " + open);
  assert(lower.includes("md-box") && lower.includes(" done"), "lower x: " + lower);
  assert(upper.includes("md-box") && upper.includes(" done") && upper.includes('data-src="- [X] Count the spare bulbs"'), "upper X stays typed: " + upper);
  assert(cancelled.includes("cancelled") && !cancelled.includes("md-box") && cancelled.includes('data-src="- [-] cancelled words"'), "cancelled: " + cancelled);
  assert(scheduled.includes("md-go") && scheduled.includes("scheduled") && !scheduled.includes("md-box"), "scheduled: " + scheduled);
  assert(src.includes("return keptTaskLine(el, dumpLine)"), "a task click must keep the typed line");
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
  const empty = fakeTask("");
  assert(sourceTaskMarkdown(empty) === "- [ ] ", sourceTaskMarkdown(empty));
  assert(serializeLine(empty) === "- [ ] ", serializeLine(empty));
  const zwsp = fakeTask("\u200b");
  assert(sourceTaskMarkdown(zwsp) === "- [ ] ", "zwsp body serializes empty: " + sourceTaskMarkdown(zwsp));
});

check("empty source task keeps md-box and a caret host in md-body", () => {
  for (const line of ["- [ ]", "- [ ] ", "- []"]) {
    const html = formatOneLine(line, true);
    assert(html.includes("is-source"), "is-source for " + JSON.stringify(line));
    assert(html.includes("md-box"), "md-box for empty task " + JSON.stringify(line));
    assert(html.includes('contenteditable="false"'), "box stays non-editable");
    assert(/<span class="md-body">(<br>|​|\u200b)<\/span>/.test(html), "empty md-body has br or zwsp: " + html);
    assert(!/>\s*- \[\]/.test(html) && !/>\s*- \[ \]/.test(html), "must not dump raw checkbox: " + html);
    assert(html.includes('data-src="' + line + '"'), "data-src keeps the typed line: " + html);
  }
  assert(paintTaskBodyHtml("", true) === "<br>", paintTaskBodyHtml("", true));
  assert(paintTaskBodyHtml("x", true) === "x", paintTaskBodyHtml("x", true));
});

check("Enter continueLinePrefix + split lands on empty task markdown", () => {
  assert(continueLinePrefix("- [ ] buy milk") === "- [ ] ", continueLinePrefix("- [ ] buy milk"));
  assert(continueLinePrefix("  * [x] done") === "  * [ ] ", continueLinePrefix("  * [x] done"));
  const split = splitDumpLine("- [ ] buy milk", "- [ ] buy milk".length);
  assert(split.right === "- [ ] ", "new line is empty task: " + JSON.stringify(split));
  const html = formatOneLine(split.right, true);
  assert(html.includes("md-box"), "continued line keeps pretty box");
  assert(/<span class="md-body">(<br>|​|\u200b)<\/span>/.test(html), "continued empty body has caret host: " + html);
});

check("paperCaretHost prefers .md-body on task lines", () => {
  const body = { classList: { contains: (c) => c === "md-body" } };
  const line = {
    dataset: { kind: "task" },
    querySelector: (sel) => sel === ".md-body" ? body : null,
    classList: { contains: () => false },
  };
  assert(paperCaretHost(line) === body, "task line host is md-body");
  assert(paperCaretHost(body) === body, "md-body is already the host");
  const plain = { dataset: { kind: "p" }, querySelector: () => body, classList: { contains: () => false } };
  assert(paperCaretHost(plain) === plain, "plain line stays the line");
  const emptyBody = { childNodes: [], querySelector: () => null, appendChild(n) { this.child = n; } };
  assert(ensurePaperBodyCaret(emptyBody) === emptyBody, "ensure returns host without document");
});

check("cache bust task3 / shell cache name", () => {
  assert(html.includes("/app.js?v=task3"), "index.html app.js ?v=task3");
  assert(html.includes("/day.css?v=task3"), "index.html day.css ?v=task3");
  assert(/const CACHE = "aidanos-shell-v\d+"/.test(sw), "sw.js names a shell cache");
});

const failed = results.filter((r) => r.ok === false);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("paper-task-source-test ok  (" + results.length + " passed)");
