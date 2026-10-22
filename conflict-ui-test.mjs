#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
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

assert(html.includes("This note was also changed on your other device."), "the conflict heading");
assert(!src.includes("This page changed on disk."), "the old heading is gone");
assert(src.includes('pathEl.hidden = true'), "the bare date under the heading is hidden");
assert(src.includes('textContent = "Open"'), "each off-page conflict has Open");
assert(src.includes('row.className = "choice-row"'), "Open sits on the choice line");
assert(src.includes("row.appendChild(kicker)") && src.includes("row.appendChild(button)"), "the label and Open share one row");
assert(css.includes("#conflict-waiting .choice-row"), "the choice row is a line");
assert(/#conflict-waiting \.choice-row \{[^}]*justify-content:\s*space-between/.test(css), "Open sits at the right end of the line");
assert(src.includes('and " + choice.more + " more"'), "several pages end with and N more");
assert(!src.includes('and " + choice.more + " more."'), "and N more has no full stop");
assert(src.includes('setAttribute("aria-label", "Open " + line.name)'), "Open names its page for a screen reader");
assert(src.includes("function reloadClearedPage("), "a cleared page reloads its text");
assert(src.includes("reloadClearedPage(info)"), "reload runs when the open page's conflict clears");
assert(src.includes("function needsChoiceLine("), "the choice line is computed");
assert(!src.includes("Tuesday, October 20 needs a choice"), "the weekday is not hard-coded");

const dateFns = src.slice(src.indexOf("function parseDate("), src.indexOf("function formatRailDate("));
const sandbox = { Date, Set, Math, String, RegExp };
vm.runInNewContext(dateFns + "\nthis.needsChoiceLine = needsChoiceLine;\nthis.elsewhereConflicts = elsewhereConflicts;", sandbox);
assert(sandbox.needsChoiceLine("2026-10-20") === "Tuesday, October 20 needs a choice", "October 20, 2026 is a Tuesday");
assert(sandbox.needsChoiceLine("2026-12-31") === "Thursday, December 31 needs a choice", "the last day of 2026");
assert(sandbox.needsChoiceLine("2027-01-01") === "Friday, January 1 needs a choice", "the weekday crosses the year boundary");
const listed = sandbox.elsewhereConflicts([
  { date: "2027-01-01" },
  { date: "2026-12-31" },
  { path: "log/2026-10-20.md" },
  { date: "2026-10-19" },
  { date: "2026-10-18" },
], "2026-10-22");
assert(listed.lines.length === 3, "three lines are shown");
assert(listed.more === 2, "and 2 more");
assert(listed.lines[0].label === "Sunday, October 18 needs a choice", listed.lines[0] && listed.lines[0].label);
assert(listed.lines[1].label === "Monday, October 19 needs a choice", listed.lines[1] && listed.lines[1].label);
assert(listed.lines[2].label === "Tuesday, October 20 needs a choice", listed.lines[2] && listed.lines[2].label);
const here = sandbox.elsewhereConflicts([{ date: "2026-10-20" }], "2026-10-20");
assert(here.lines.length === 0 && here.more === 0, "the open page is not listed again");
const mixed = sandbox.elsewhereConflicts([
  { path: "notes/Kitchen remodel.md" },
  { date: "2026-10-20", path: "log/2026-10-20.md" },
  { path: "notes/Other.md" },
  { date: "2026-10-21" },
], "2026-10-22");
assert(mixed.lines.length === 3, "days and notes share three lines");
assert(mixed.more === 1, "and 1 more counts both kinds");
assert(mixed.lines[0].label === "Tuesday, October 20 needs a choice", mixed.lines[0] && mixed.lines[0].label);
assert(mixed.lines[2].label === "Kitchen remodel needs a choice", mixed.lines[2] && mixed.lines[2].label);
assert(mixed.lines[2].name === "Kitchen remodel", "the note title is the screen-reader name");
const onNote = sandbox.elsewhereConflicts([
  { path: "notes/Kitchen remodel.md" },
  { date: "2026-10-20" },
], { date: "", path: "notes/Kitchen remodel.md" });
assert(onNote.lines.length === 1 && onNote.lines[0].date === "2026-10-20", "the open note is left off the list");

assert(css.includes(".conflict-sheet"), "conflict styles");
assert(!css.includes("body.view-door .conflict-sheet"), "conflict is not Door-skinned");
const sheetAt = css.indexOf(".conflict-sheet {");
assert(sheetAt >= 0, "conflict-sheet rule");
assert(css.slice(sheetAt, sheetAt + 180).includes("42rem"), "conflict sits on paper width");

console.log("conflict-ui-test ok");
