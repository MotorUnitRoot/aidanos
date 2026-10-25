#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createLiveNote, shapeNote, tickLine } from "./editor/live-note.mjs";
import { isNotePlanFolder, noteSaveStyle, writeNoteText } from "./editor/note-save.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => console.log("pass  " + name))
    .catch((err) => {
      console.log("FAIL  " + name + "  " + (err && err.message || err));
      process.exitCode = 1;
    });
}

await check("a typed week is saved unchanged", async () => {
  execFileSync(process.execPath, [path.join(root, "editor", "type-week.mjs")], {
    cwd: root,
    stdio: "inherit",
  });
});

await check("a tick changes the box and leaves the words", async () => {
  const source = "Keep this\n- [ ] Oil the latch\nplain words\n";
  const note = createLiveNote(source);
  assert(note.tick(1) === "Keep this\n- [x] Oil the latch\nplain words\n", note.text());
  assert(note.text().includes("Oil the latch"), "the words moved");
  assert(note.undo() === source, "undo did not restore the line");
  assert(tickLine("plain words") === "plain words", "a plain line was rewritten");
  assert(tickLine("- [] Note the glass order") === "- [x] Note the glass order", tickLine("- [] Note the glass order"));
});

await check("headings, lists, and tasks get a shape", async () => {
  const shapes = shapeNote("# Harbor\n\n- [ ] Oil\n- hanging\n1. numbered\nplain\n");
  assert(shapes[0].role === "heading" && shapes[0].level === 1, "heading");
  assert(shapes[1].role === "empty", "blank line");
  assert(shapes[2].role === "task" && shapes[2].ticked === false, "task");
  assert(shapes[3].role === "list", "bullet");
  assert(shapes[4].role === "list", "numbered");
  assert(shapes[5].role === "plain", "plain");
  assert(shapes.every((shape) => shape.source != null), "source dropped");
});

await check("a NotePlan folder saves in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-save-"));
  const file = path.join(dir, "NotePlan", "log", "day.md");
  assert(isNotePlanFolder(file), "folder was not recognized");
  assert(noteSaveStyle(file, true) === "in-place", "swap-in was allowed inside the folder");
  await writeNoteText(file, "one\n");
  const inode = fs.statSync(file).ino;
  const style = await writeNoteText(file, "one\ntwo\n", { swapInRequested: true });
  assert(style === "in-place", style);
  assert(fs.statSync(file).ino === inode, "the file was replaced");
  assert(fs.readFileSync(file, "utf8") === "one\ntwo\n", "text");
  const names = fs.readdirSync(path.dirname(file));
  assert(!names.some((name) => name.includes(".tmp")), "a temp file was left behind");
});

await check("swap-in still works outside a NotePlan folder", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-swap-"));
  const file = path.join(dir, "notes.md");
  assert(!isNotePlanFolder(file), "an ordinary folder was treated as NotePlan");
  assert(noteSaveStyle(file, true) === "swap-in", "outside save was in place");
  assert(noteSaveStyle(file, false) === "in-place", "the setting could not choose in place");
  await writeNoteText(file, "one\n", { style: "swap-in" });
  const inode = fs.statSync(file).ino;
  await writeNoteText(file, "two\n", { style: "swap-in" });
  assert(fs.statSync(file).ino !== inode, "swap-in kept the same file");
  assert(fs.readFileSync(file, "utf8") === "two\n", "swap text");
});

await check("five thousand lines stay responsive", async () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) {
    if (i % 20 === 0) lines.push("# Section " + i);
    else if (i % 5 === 0) lines.push("- [ ] Task " + i + " stays put");
    else if (i % 2 === 0) lines.push("- hanging line " + i);
    else lines.push("A plain sentence " + i + ".");
  }
  const big = lines.join("\n");
  let bestFull = Infinity;
  for (let pass = 0; pass < 3; pass++) {
    const started = performance.now();
    const shapes = shapeNote(big);
    const elapsed = performance.now() - started;
    assert(shapes.length === 5000, "line count");
    assert(shapes[0].role === "heading", "first heading");
    assert(shapes[5].role === "task", "task shape");
    if (elapsed < bestFull) bestFull = elapsed;
  }
  assert(bestFull < 250, "reading 5,000 lines took " + bestFull.toFixed(1) + "ms");
  const note = createLiveNote(big);
  let bestKey = Infinity;
  for (let pass = 0; pass < 5; pass++) {
    const started = performance.now();
    note.replace(big.length, big.length, "!");
    note.shapeLineAt(4999);
    note.undo();
    const elapsed = performance.now() - started;
    if (elapsed < bestKey) bestKey = elapsed;
  }
  assert(bestKey < 30, "one keystroke took " + bestKey.toFixed(1) + "ms");
  assert(note.text() === big, "the long note was rewritten");
});

await check("holding the words does not start a drag", async () => {
  const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
  const start = src.indexOf('$("paper").addEventListener("pointerdown"');
  assert(start >= 0, "pointerdown missing");
  const body = src.indexOf(".md-body", start);
  const arm = src.indexOf("slotDrag.armed = true", start);
  assert(body > start && body < arm, "word selection is armed as a drag");
});

if (process.exitCode) process.exit(process.exitCode);
console.log("editor-live-test ok");
