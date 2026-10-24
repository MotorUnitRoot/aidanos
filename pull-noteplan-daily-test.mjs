#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  WRITE_SECTION,
  fileMorningWriting,
  readMorningSection,
  runCli,
} from "./scripts/pull-noteplan-daily.mjs";

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

function nonempty(markdown) {
  return String(markdown)
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function keepsEveryLine(before, after) {
  const want = nonempty(before);
  const got = nonempty(after);
  let i = 0;
  for (const line of got) {
    if (i < want.length && line === want[i]) i += 1;
  }
  return i === want.length;
}

const kettle = "The kettle was already warm.";
const street = "The street was quiet before breakfast.";
const boat = "A paper boat sat on the desk.";

check("a new day is filed under Reflection", () => {
  const before = "# Picnic day\n\nBring cups.\n";
  const after = fileMorningWriting(before, street);
  assert(WRITE_SECTION === "Reflection", "write section");
  assert(after.includes("## Reflection\n"), after);
  assert(!after.includes("## Mark"), "new day must not gain ## Mark");
  assert(after.indexOf("Bring cups.") < after.indexOf("## Reflection"), "old lines stay above the new section");
  assert(after.indexOf("## Reflection") < after.indexOf(street), "morning text sits under Reflection");
  assert(keepsEveryLine(before, after), "dropped a line:\n" + after);
  const read = readMorningSection(after);
  assert(read.name === "Reflection", read.name);
  assert(read.body === street, read.body);
});

check("a day that already has Reflection is extended there", () => {
  const before = [
    "# Picnic day",
    "",
    "## Reflection",
    "",
    kettle,
    "",
    "## Later",
    "",
    boat,
    "",
  ].join("\n");
  const after = fileMorningWriting(before, street);
  const heads = after.match(/^## Reflection\s*$/gm) || [];
  assert(heads.length === 1, "one Reflection heading, got " + heads.length);
  assert(!after.includes("## Mark"), "must not add Mark");
  assert(after.indexOf(kettle) < after.indexOf(street), "new text follows what was already there");
  assert(after.indexOf(street) < after.indexOf("## Later"), "new text stays inside Reflection");
  assert(after.indexOf("## Later") < after.indexOf(boat), "the later section stays");
  assert(keepsEveryLine(before, after), "dropped a line:\n" + after);
  const again = fileMorningWriting(after, street);
  assert(again === after, "filing the same morning text again must not duplicate it");
  const read = readMorningSection(after);
  assert(read.name === "Reflection", read.name);
  assert(read.body.includes(kettle) && read.body.includes(street), read.body);
});

check("a day that only has Mark is extended under Mark", () => {
  const before = [
    "---",
    "date: 2099-03-03",
    "---",
    "",
    "# Picnic day",
    "",
    "## Mark",
    "",
    kettle,
    "",
    "## Later",
    "",
    boat,
    "",
  ].join("\n");
  const after = fileMorningWriting(before, street);
  assert(after.includes("## Mark\n"), "the old heading stays");
  assert(!after.includes("## Reflection"), "must not open a second section");
  assert(after.indexOf("## Mark") < after.indexOf(kettle), "existing sentence stays under Mark");
  assert(after.indexOf(kettle) < after.indexOf(street), "new text is appended after the existing sentence");
  assert(after.indexOf(street) < after.indexOf("## Later"), "new text stays inside Mark");
  assert(keepsEveryLine(before, after), "dropped or renamed a line:\n" + after);
  const read = readMorningSection(after);
  assert(read.name === "Mark", "reader still accepts Mark, got " + read.name);
  assert(read.body.includes(kettle) && read.body.includes(street), read.body);
  const again = fileMorningWriting(after, street);
  assert(again === after, "second file must leave the Mark day untouched");
});

check("prose that says Mark is not a Mark section", () => {
  const before = "# Picnic day\n\nMark the calendar for the picnic.\n\n## Later\n\n" + boat + "\n";
  const after = fileMorningWriting(before, street);
  assert(after.includes("## Reflection\n"), after);
  assert(!/^## Mark\s*$/m.test(after), "must not invent a Mark heading");
  assert(after.includes("Mark the calendar for the picnic."), "the sentence stays");
  assert(keepsEveryLine(before, after), "dropped a line:\n" + after);
});

check("empty morning writing does not add a heading", () => {
  const before = "# Picnic day\n\nBring cups.\n";
  assert(fileMorningWriting(before, "  \n") === before, "blank morning must return the same note");
  assert(fileMorningWriting("", "") === "", "empty stays empty");
});

check("when both headings exist, Reflection takes the new text and Mark stays", () => {
  const before = [
    "# Picnic day",
    "",
    "## Reflection",
    "",
    street,
    "",
    "## Mark",
    "",
    kettle,
    "",
  ].join("\n");
  const after = fileMorningWriting(before, boat);
  assert(after.indexOf(boat) < after.indexOf("## Mark"), "new text goes under Reflection");
  assert(after.indexOf("## Mark") < after.indexOf(kettle), "Mark text stays under Mark");
  const markCount = (after.match(/^## Mark\s*$/gm) || []).length;
  const reflectionCount = (after.match(/^## Reflection\s*$/gm) || []).length;
  assert(markCount === 1 && reflectionCount === 1, "headings stay one each");
  assert(keepsEveryLine(before, after), "dropped a line:\n" + after);
  const read = readMorningSection(before);
  assert(read.name === "Reflection", "reader prefers Reflection when both exist");
  assert(read.body === street, read.body);
});

check("cli files made-up text and does not print it", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "reflection-morning-"));
  const day = path.join(dir, "day.md");
  const morning = path.join(dir, "morning.txt");
  const before = "# Picnic day\n\n## Mark\n\n" + kettle + "\n";
  fs.writeFileSync(day, before);
  fs.writeFileSync(morning, street + "\n");
  const script = fileURLToPath(new URL("./scripts/pull-noteplan-daily.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [script, "--day", day, "--text-file", morning], {
    encoding: "utf8",
  });
  assert(run.status === 0, "status " + run.status + " stderr " + run.stderr);
  const out = (run.stdout || "") + (run.stderr || "");
  assert(!out.includes(street) && !out.includes(kettle), "cli printed note text: " + out);
  assert(run.stdout.trim() === "updated", run.stdout);
  const filed = fs.readFileSync(day, "utf8");
  assert(filed.includes("## Mark"), "heading kept");
  assert(!filed.includes("## Reflection"), "no second section");
  assert(filed.includes(kettle) && filed.includes(street), "both sentences on disk");
  const second = spawnSync(process.execPath, [script, "--day", day, "--text-file", morning], {
    encoding: "utf8",
  });
  assert(second.status === 0 && second.stdout.trim() === "unchanged", second.stdout + second.stderr);
  assert(fs.readFileSync(day, "utf8") === filed, "unchanged run rewrote the file");
  fs.rmSync(dir, { recursive: true, force: true });
});

check("cli with no paths exits without reading a note", () => {
  let code = 0;
  const logs = [];
  const orig = {
    exit: process.exit,
    error: console.error,
    log: console.log,
  };
  process.exit = (status) => {
    code = status;
    throw new Error("exit");
  };
  console.error = (...args) => logs.push(args.join(" "));
  console.log = (...args) => logs.push(args.join(" "));
  try {
    runCli([]);
  } catch (err) {
    assert(err.message === "exit", err.message);
  } finally {
    process.exit = orig.exit;
    console.error = orig.error;
    console.log = orig.log;
  }
  assert(code === 2, "expected usage exit, got " + code);
  assert(logs.join("\n").includes("--day"), logs.join("\n"));
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("pull-noteplan-daily-test ok  (" + results.length + " passed)");
