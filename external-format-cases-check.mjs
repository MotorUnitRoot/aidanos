import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";

const SEEN = [
  1, 2, 3, 4, 5, 6, 7, 8, 11, 15, 16, 17, 18, 25, 26, 27, 28, 29, 30, 31, 34, 35,
  41, 42, 43, 47, 52, 55, 58, 59, 61, 62, 64, 65,
];
const GUESSED = [9, 12, 13, 20, 21, 24, 32, 33, 36, 37, 38, 40, 44, 48, 51, 54, 60, 63];
const UNKNOWN = [10, 14, 19, 22, 23, 39, 45, 46, 49, 50, 53, 56, 57];

const NOTES = [
  {
    id: "regular-lines",
    path: "notes/regular-lines.md",
    title: "ZZ REA Test Lines",
    where: 'New regular note in a new folder "ZZ REA Test"',
  },
  {
    id: "regular-frontmatter",
    path: "notes/regular-frontmatter.md",
    title: "ZZ REA Frontmatter",
    where: "New regular note, same folder",
  },
  {
    id: "linked-note",
    path: "notes/linked-note.md",
    title: "ZZ REA Linked Note",
    where: "Created by clicking the c41 link, then filled in",
  },
  {
    id: "monday-text",
    path: "notes/monday-text.md",
    title: "Daily note, Monday Jan 9, 2017",
    where: "That day's calendar note",
  },
  {
    id: "week-text",
    path: "notes/week-text.md",
    title: "Weekly note, 2017-W02 (Jan 9 to 15, 2017)",
    where: "That week's calendar note",
  },
  {
    id: "friday-empty",
    path: "notes/friday-empty.md",
    title: "Daily note, Friday Jan 13, 2017",
    where: "Open only, type nothing",
  },
];

const ACTIVE_KEYS = ["number", "context", "input", "expected", "label"];
const PENDING_FILE_KEYS = ["number", "title", "label", "status"];
const PENDING_LIST_KEYS = ["number", "title", "label", "path", "status"];
const ACTIVE_LIST_KEYS = ["number", "path"];

function sameNumbers(actual, expected, label) {
  assert.deepEqual([...actual].sort((a, b) => a - b), [...expected].sort((a, b) => a - b), label);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function listFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => !name.startsWith(".")).sort();
}

export function checkExternalFormatCases(repoRoot) {
  assert.equal(SEEN.length, 34);
  assert.equal(GUESSED.length, 18);
  assert.equal(UNKNOWN.length, 13);

  const dir = path.join(repoRoot, "fixtures", "part-two-noteplan");
  assert.deepEqual(listFiles(dir), ["README.md", "cases", "manifest.json", "notes", "pending"]);

  const readme = fs.readFileSync(path.join(dir, "README.md"), "utf8");
  assert.match(readme, /notes in the format NotePlan uses/);
  assert.match(readme, /neutral file names/);
  assert.match(readme, /Day-note and weekly-note file naming and folder layout/);
  assert.match(readme, /waits for spec v0.3/);
  assert.match(readme, /Do not invent/);
  assert.match(readme, /40-case/);
  assert.match(readme, /no expected result/);
  assert.match(readme, /run a reader against `input` and `context`/);

  const manifest = readJson(path.join(dir, "manifest.json"));
  assert.deepEqual(Object.keys(manifest).sort(), ["active", "notes", "pending"]);
  assert.deepEqual(manifest.notes, NOTES);

  assert.deepEqual(
    listFiles(path.join(dir, "notes")),
    NOTES.map((note) => path.basename(note.path)).sort(),
  );
  for (const note of NOTES) {
    const file = path.join(dir, note.path);
    const base = path.basename(note.path);
    assert.equal(base.includes("W"), false, base);
    assert.doesNotMatch(base, /^\d{4}-\d{2}-\d{2}/);
    assert.equal(fs.existsSync(file), true, note.path);
  }

  const regular = fs.readFileSync(path.join(dir, "notes/regular-lines.md"), "utf8");
  assert.ok(regular.startsWith("# ZZ REA Test Lines\n"));
  assert.ok(regular.includes("\t* c46a tab child\n"));
  assert.ok(regular.includes("  * c46b two-space child\n"));
  assert.ok(regular.includes("\t- c47a note under parent\n\n\t* c47b after a blank line\n"));
  assert.ok(regular.endsWith("```\n* c49 fake task inside code #zzcode >2017-01-10\n```\n"));
  const front = fs.readFileSync(path.join(dir, "notes/regular-frontmatter.md"), "utf8");
  assert.ok(front.startsWith("---\ntitle: ZZ REA Frontmatter\n"));
  const linked = fs.readFileSync(path.join(dir, "notes/linked-note.md"), "utf8");
  assert.equal(linked, "# ZZ REA Linked Note\n## Fake Heading\nFake text under the heading.\n");
  const monday = fs.readFileSync(path.join(dir, "notes/monday-text.md"), "utf8");
  assert.ok(monday.startsWith("## c30 09:00 - 11:00 Fake focus\n* c30a Fake email\n"));
  assert.ok(monday.includes("\t* c54a open child\n\t* [x] c54b done child\n"));
  assert.equal(fs.readFileSync(path.join(dir, "notes/week-text.md"), "utf8"), "* c59 Fake weekly task\n");
  assert.equal(fs.readFileSync(path.join(dir, "notes/friday-empty.md")).length, 0);

  assert.ok(Array.isArray(manifest.active));
  assert.ok(Array.isArray(manifest.pending));
  sameNumbers(manifest.active.map((entry) => entry.number), SEEN, "active case numbers");
  sameNumbers(manifest.pending.map((entry) => entry.number), GUESSED.concat(UNKNOWN), "pending case numbers");

  const activePaths = new Set();
  for (const entry of manifest.active) {
    assert.deepEqual(Object.keys(entry), ACTIVE_LIST_KEYS);
    assert.equal(entry.path, "cases/" + entry.number + ".json");
    activePaths.add(entry.path);
    const file = path.join(dir, entry.path);
    assert.equal(fs.existsSync(file), true, "missing active case " + entry.number);
    const body = readJson(file);
    assert.deepEqual(Object.keys(body), ACTIVE_KEYS, "active case " + entry.number);
    assert.equal(body.number, entry.number);
    assert.equal(typeof body.context, "string");
    assert.ok(body.context.length > 0);
    assert.equal(typeof body.input, "string");
    assert.ok(body.input.length > 0);
    assert.equal(typeof body.expected, "string");
    assert.ok(body.expected.length > 0);
    assert.equal(body.label, "Seen");
    assert.equal(Object.hasOwn(body, "status"), false);
    assert.equal(Object.hasOwn(body, "title"), false);
  }
  assert.deepEqual(listFiles(path.join(dir, "cases")), [...activePaths].map((item) => path.basename(item)).sort());

  const pendingPaths = new Set();
  for (const entry of manifest.pending) {
    assert.deepEqual(Object.keys(entry), PENDING_LIST_KEYS, "pending list " + entry.number);
    assert.equal(entry.path, "pending/" + entry.number + ".json");
    assert.equal(entry.status, "waits for spec v0.3");
    const expectedLabel = GUESSED.includes(entry.number) ? "Guessed" : "Unknown";
    assert.equal(entry.label, expectedLabel);
    assert.equal(typeof entry.title, "string");
    assert.ok(entry.title.length > 0);
    pendingPaths.add(entry.path);
    const file = path.join(dir, entry.path);
    assert.equal(fs.existsSync(file), true, "missing pending case " + entry.number);
    const body = readJson(file);
    assert.deepEqual(Object.keys(body), PENDING_FILE_KEYS, "pending case " + entry.number);
    assert.equal(body.number, entry.number);
    assert.equal(body.title, entry.title);
    assert.equal(body.label, entry.label);
    assert.equal(body.status, "waits for spec v0.3");
    assert.equal(Object.hasOwn(body, "expected"), false);
    assert.equal(Object.hasOwn(body, "input"), false);
    assert.equal(Object.hasOwn(body, "context"), false);
  }
  assert.deepEqual(listFiles(path.join(dir, "pending")), [...pendingPaths].map((item) => path.basename(item)).sort());

  const activeNumbers = new Set(manifest.active.map((entry) => entry.number));
  for (const entry of manifest.pending) {
    assert.equal(activeNumbers.has(entry.number), false, "pending case counted as active " + entry.number);
  }

  const banned = ["CLEARED by Legal", "Colby"];
  const files = [];
  function walk(rel) {
    const abs = path.join(dir, rel);
    if (fs.statSync(abs).isDirectory()) {
      for (const name of listFiles(abs)) walk(path.join(rel, name));
      return;
    }
    files.push(rel);
  }
  for (const name of listFiles(dir)) walk(name);
  for (const rel of files) {
    const text = fs.readFileSync(path.join(dir, rel), "utf8");
    for (const word of banned) {
      assert.equal(text.includes(word), false, rel + " contains " + word);
    }
    if (rel !== "README.md") {
      assert.equal(text.includes("NotePlan"), false, rel);
    }
    assert.doesNotMatch(text, /\bH\d+\b/);
    assert.doesNotMatch(text, /\bP\d+\b/);
    assert.doesNotMatch(text, /\bO\d+\b/);
    assert.equal(text.includes("CL3."), false, rel);
    const urls = text.match(/https?:\/\/[^\s)"\]]+/g) || [];
    for (const url of urls) {
      assert.equal(url, "https://example.test", rel);
    }
  }
}
