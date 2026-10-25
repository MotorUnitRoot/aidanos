#!/usr/bin/env node
// Types a sample week of notes and saves each file unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveNote } from "./live-note.mjs";
import { isNotePlanFolder, writeNoteText } from "./note-save.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const source = path.join(root, "fixtures", "sample-notes", "vault");
const week = [
  "log/2026-03-09.md",
  "log/2026-03-14.md",
  "log/2026-03-15.md",
  "log/2026-03-16.md",
  "aidanos/weeks/2026-03-09.md",
];

function fail(message) {
  console.error(message);
  process.exit(1);
}

const destRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-week-"));
const notePlan = path.join(destRoot, "Library", "Containers", "co.noteplan.NotePlan3", "Data", "Documents");

for (const relative of week) {
  const original = fs.readFileSync(path.join(source, relative), "utf8");
  const note = createLiveNote("");
  let built = "";
  for (const character of original) {
    built += character;
    if (note.type(built) !== built) fail(relative + " changed while typing");
  }
  if (note.text() !== original) fail(relative + " was not the typed text");
  const file = path.join(notePlan, relative);
  if (!isNotePlanFolder(file)) fail(relative + " is not inside a NotePlan folder");
  await writeNoteText(file, note.text());
  const saved = fs.readFileSync(file, "utf8");
  if (saved !== original) fail(relative + " on disk was not the typed text");
}

console.log("typed " + week.length + " notes, files match");
