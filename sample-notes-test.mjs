#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(root, "fixtures", "sample-notes");
const vault = path.join(fixture, "vault");
const manifestPath = path.join(fixture, "manifest.json");
const screensPath = path.join(fixture, "screens.json");
const partTwo = path.join(root, "fixtures", "part-two-noteplan");

const DAY_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;
const REQUIRED_KINDS = [
  "day",
  "project",
  "plan",
  "capture",
  "week",
  "map",
  "broken-empty",
  "broken-encoding",
  "broken-front-matter",
  "broken-binary",
  "broken-misnamed",
  "broken-impossible-day",
];
const REQUIRED_SCREENS = [
  "door",
  "door-proposals",
  "today",
  "timeline",
  "month",
  "plan",
  "capture",
  "ask",
  "project",
  "map",
  "stage",
  "conflict",
  "conflict-edit",
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function walkFiles(dir, vaultRoot, out) {
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    const rel = path.relative(vaultRoot, abs).split(path.sep).join("/");
    const st = fs.statSync(abs);
    if (st.isDirectory()) walkFiles(abs, vaultRoot, out);
    else if (st.isFile()) out.push(rel);
  }
}

function validUtf8(buf) {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(buf);
    return true;
  } catch (err) {
    return false;
  }
}

function realDay(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  return utc.getUTCFullYear() === year && utc.getUTCMonth() === month - 1 && utc.getUTCDate() === day;
}

function isoUtc(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return Date.UTC(year, month - 1, day);
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

check("manifest lists a file for every case, and every file is listed", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  assert(manifest && Array.isArray(manifest.cases), "manifest.cases");
  assert(manifest.cases.length > 0, "manifest is empty");
  const ids = new Set();
  const listed = new Set();
  for (const entry of manifest.cases) {
    assert(entry && typeof entry.id === "string" && entry.id.length > 0, "case id");
    assert(!ids.has(entry.id), "duplicate id " + entry.id);
    ids.add(entry.id);
    assert(typeof entry.path === "string" && entry.path.length > 0, entry.id + " path");
    assert(!entry.path.startsWith("/") && !entry.path.split("/").includes(".."), entry.id + " escapes");
    assert(!listed.has(entry.path), "duplicate path " + entry.path);
    listed.add(entry.path);
    const abs = path.join(vault, entry.path);
    assert(fs.existsSync(abs) && fs.statSync(abs).isFile(), "listed case is missing: " + entry.id + " " + entry.path);
    assert(REQUIRED_KINDS.includes(entry.kind), entry.id + " kind " + entry.kind);
  }
  const found = [];
  walkFiles(vault, vault, found);
  found.sort();
  const want = [...listed].sort();
  const missingOnDisk = want.filter((rel) => !found.includes(rel));
  const extraOnDisk = found.filter((rel) => !listed.has(rel));
  assert(missingOnDisk.length === 0, "listed case missing on disk: " + missingOnDisk.join(", "));
  assert(extraOnDisk.length === 0, "file on disk is not in the manifest: " + extraOnDisk.join(", "));
  for (const kind of REQUIRED_KINDS) {
    assert(manifest.cases.some((entry) => entry.kind === kind), "missing kind " + kind);
  }
});

check("day notes span about three years and use log/YYYY-MM-DD.md", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const days = manifest.cases.filter((entry) => entry.kind === "day");
  assert(days.length >= 12, "expected a spread of day notes, got " + days.length);
  const isos = [];
  for (const entry of days) {
    const base = path.basename(entry.path);
    assert(entry.path === "log/" + base, entry.id + " is not a day path");
    assert(DAY_FILE.test(base), entry.id + " is not YYYY-MM-DD.md");
    const iso = base.slice(0, 10);
    assert(realDay(iso), entry.id + " is not a real calendar day");
    const text = fs.readFileSync(path.join(vault, entry.path), "utf8");
    assert(text.trim().length > 0, entry.id + " is empty");
    isos.push(iso);
  }
  isos.sort();
  const span = (isoUtc(isos[isos.length - 1]) - isoUtc(isos[0])) / 86400000;
  assert(span >= 1000, "day notes span " + span + " days, want about three years");
});

check("tasks, times, names, and dates are in the sample", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  let text = "";
  for (const entry of manifest.cases) {
    if (entry.kind === "broken-encoding" || entry.kind === "broken-binary" || entry.kind === "broken-empty") continue;
    text += fs.readFileSync(path.join(vault, entry.path), "utf8") + "\n";
  }
  assert(/^\s*[-*+]\s+\[ \]\s+\S/m.test(text), "missing an open task");
  assert(/^\s*[-*+]\s+\[x\]\s+\S/m.test(text), "missing a done task");
  assert(/^\s*[-*+]\s+\[X\]\s+\S/m.test(text), "missing an uppercase done task");
  assert(/^\s*[-*+]\s+\[\]\s+\S/m.test(text), "missing an empty checkbox stub");
  assert(/^\s{2,}[-*+]\s+\[[ xX]\]\s+\S/m.test(text), "missing a nested task");
  assert(/^\*\s+\[ \]\s+\S/m.test(text), "missing a star-marked open task");
  assert(/^\+\s+\[x\]\s+\S/m.test(text), "missing a plus-marked done task");
  assert(/@\d{1,2}:\d{2}\b/.test(text), "missing a time");
  assert(/@\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\b/.test(text), "missing a date and a time");
  assert(/@[A-Z][a-z]+\b/.test(text), "missing an @name");
  assert(/\b\d{4}-\d{2}-\d{2}\b/.test(text), "missing a date");
  assert(!/colby/i.test(text), "sample text must stay invented");
  assert(!/family room/i.test(text), "sample text must stay invented");
  assert(!/noteplan/i.test(text), "sample notes do not describe another app");
  assert(!/horse/i.test(text), "plan content stays a season note");
});

check("plan, project, capture, week, and map use the vault layout", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const plan = manifest.cases.find((entry) => entry.kind === "plan");
  assert(plan.path === "aidanos/active-horse.md", "Plan is the season file the app opens");
  const planText = fs.readFileSync(path.join(vault, plan.path), "utf8");
  assert(planText.includes("## Why"), "plan Why");
  assert(planText.includes("## Next steps"), "plan Next steps");
  assert(planText.includes("## Waiting"), "plan Waiting");
  assert(/^- \[ \] /m.test(planText) && /^- \[x\] /m.test(planText), "plan has open and done tasks");
  for (const entry of manifest.cases.filter((item) => item.kind === "project")) {
    assert(entry.path.startsWith("projects/") && entry.path.endsWith(".md"), entry.id);
    assert(fs.readFileSync(path.join(vault, entry.path), "utf8").trim().length > 0, entry.id);
  }
  const capture = manifest.cases.find((entry) => entry.kind === "capture");
  assert(capture.path === "Capture.md", "capture path");
  const week = manifest.cases.find((entry) => entry.kind === "week");
  const weekDate = week.path.match(/^aidanos\/weeks\/(\d{4}-\d{2}-\d{2})\.md$/);
  assert(weekDate, "week file is aidanos/weeks/YYYY-MM-DD.md");
  const monday = weekDate[1];
  assert(realDay(monday), "week date");
  assert(new Date(monday + "T12:00:00Z").getUTCDay() === 1, "week file is a Monday");
  assert(fs.readFileSync(path.join(vault, week.path), "utf8").includes("| date "), "week table");
  const map = manifest.cases.find((entry) => entry.kind === "map");
  assert(/^maps\/.+\.md$/.test(map.path) && !/^maps\/the-/i.test(map.path), "map path");
  const mapText = fs.readFileSync(path.join(vault, map.path), "utf8");
  assert(mapText.includes("## Stages") && mapText.includes("### "), "map stages");
});

check("broken files are actually broken", () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  function entry(kind) {
    return manifest.cases.find((item) => item.kind === kind);
  }
  function buf(kind) {
    return fs.readFileSync(path.join(vault, entry(kind).path));
  }
  assert(buf("broken-empty").length === 0, "empty file has bytes");
  assert(!validUtf8(buf("broken-encoding")), "wrong encoding still decodes as UTF-8");
  const front = buf("broken-front-matter").toString("utf8");
  assert(front.startsWith("---\n"), "front matter does not open");
  assert(!front.includes("\n---"), "front matter still closes");
  assert(buf("broken-binary").includes(0), "binary junk has no NUL");
  const misnamed = entry("broken-misnamed");
  assert(misnamed.path.startsWith("log/"), "misnamed day is not in log/");
  assert(!DAY_FILE.test(path.basename(misnamed.path)), "misnamed day uses a real day name");
  const impossible = entry("broken-impossible-day");
  const base = path.basename(impossible.path);
  assert(impossible.path === "log/" + base && DAY_FILE.test(base), "impossible day is not named like a day");
  assert(!realDay(base.slice(0, 10)), "impossible day is a real date");
});

check("part two placeholder is empty and labeled", () => {
  assert(fs.statSync(partTwo).isDirectory(), "missing part two folder");
  const names = fs.readdirSync(partTwo).filter((name) => !name.startsWith("."));
  assert(names.length === 1 && names[0] === "README.md", "part two must stay empty except the README: " + names.join(", "));
  const readme = fs.readFileSync(path.join(partTwo, "README.md"), "utf8");
  assert(/NotePlan-format line cases/.test(readme), "placeholder names the line cases");
  assert(/day-note layout/.test(readme), "placeholder names the day-note layout");
  assert(/Legal-approved/.test(readme), "placeholder says the cases wait for a Legal-approved description");
  assert(/40-case/.test(readme), "placeholder says the cases count toward the 40-case target");
  assert(/Do not invent/.test(readme), "placeholder says not to invent that format");
});

check("screen list cannot drop a state", () => {
  const screens = JSON.parse(fs.readFileSync(screensPath, "utf8"));
  assert(Array.isArray(screens.widths) && screens.widths.length === 2, "widths");
  assert(screens.widths[0] === 1280 && screens.widths[1] === 390, "widths must be 1280 and 390");
  assert(Array.isArray(screens.states) && screens.states.length === REQUIRED_SCREENS.length, "screen count");
  for (const id of REQUIRED_SCREENS) {
    assert(screens.states.includes(id), "listed screen missing: " + id);
  }
});

const failed = results.filter((item) => !item.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("sample-notes-test ok  (" + results.length + " passed)");
