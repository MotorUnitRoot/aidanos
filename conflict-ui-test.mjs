#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(html.includes('id="conflict-sheet"'), "conflict sheet in paper");
assert(html.includes("Keep mine"), "Keep mine");
assert(html.includes("Take theirs"), "Take theirs");
assert(html.includes("Edit"), "Edit");
assert(!/id="conflict-sheet"[^>]*door/.test(html), "conflict is not Door chrome");
assert(html.includes('id="conflict-mine"'), "yours");
assert(html.includes('id="conflict-theirs"'), "theirs");

const saveStart = src.indexOf("async function saveDay(");
assert(saveStart >= 0, "saveDay missing");
const saveEnd = src.indexOf("\nfunction currentView(", saveStart);
const saveFn = src.slice(saveStart, saveEnd);
assert(saveFn.includes("handleSaveConflict"), "interactive 409 opens conflict UI");
assert(!/putNote\(Number\(body\.mtime\)/.test(saveFn), "no silent overwrite retry on note 409");
assert(!saveFn.includes("applyRemoteDay"), "day 409 must not drop local edits");
assert(!saveFn.includes("applyRemoteNote"), "note 409 must not drop local edits");

assert(src.includes("function openPaperConflict("), "openPaperConflict");
assert(src.includes("function resolveConflictKeep("), "Keep mine handler");
assert(src.includes("function resolveConflictTheirs("), "Take theirs handler");
assert(src.includes("function resolveConflictEdit("), "Edit handler");
assert(src.includes("mtime: info.mtime"), "Keep mine uses server mtime as base");

const applyStart = src.indexOf("async function applyStepsToToday(");
assert(applyStart >= 0, "applyStepsToToday missing");
const applyFn = src.slice(applyStart, src.indexOf("async function landMapNextStepsOnToday(", applyStart));
assert(/Quiet merge/.test(applyFn), "map-task 409 is labeled a quiet merge");
assert(applyFn.includes("appendMapTasks"), "quiet merge still appends");
assert(!applyFn.includes("openPaperConflict"), "map-task merge does not open conflict UI");

assert(css.includes(".conflict-sheet"), "conflict styles");
assert(!css.includes("body.view-door .conflict-sheet"), "conflict is not Door-skinned");
const sheetAt = css.indexOf(".conflict-sheet {");
assert(sheetAt >= 0, "conflict-sheet rule");
assert(css.slice(sheetAt, sheetAt + 180).includes("42rem"), "conflict sits on paper width");

console.log("conflict-ui-test ok");
