#!/usr/bin/env node
/**
 * File morning writing into a day note.
 *
 * Since Aug 24 the section is called Reflection. New writes use that heading.
 * A day that still has the old "## Mark" heading is read as the same section.
 * New text for that day is appended under "## Mark". The heading is not
 * renamed, existing lines are not edited, and a second "## Reflection"
 * section is not added.
 *
 * This file does not search a vault, open a port, or pull notes on its own.
 * Pass the day file and the morning text file. Tests call the functions
 * with made-up strings.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const WRITE_SECTION = "Reflection";
export const READ_SECTIONS = ["Reflection", "Mark"];

function newlineOf(markdown) {
  const crlf = String(markdown).split("\r\n").length - 1;
  const lf = String(markdown).split("\n").length - 1 - crlf;
  return crlf > lf ? "\r\n" : "\n";
}

function splitLines(markdown) {
  return String(markdown).replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
}

function findHeading(lines, name) {
  const want = "## " + name;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === want) return i;
  }
  return -1;
}

function nextHeading(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (/^## /.test(lines[i].trim())) return i;
  }
  return lines.length;
}

function sectionAt(lines, name) {
  const start = findHeading(lines, name);
  if (start < 0) return null;
  const end = nextHeading(lines, start + 1);
  const bodyLines = lines.slice(start + 1, end);
  return { name, start, end, bodyLines };
}

function locateMorning(lines) {
  for (const name of READ_SECTIONS) {
    const found = sectionAt(lines, name);
    if (found) return found;
  }
  return null;
}

function bodyText(bodyLines) {
  return bodyLines.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function alreadyFiled(bodyLines, text) {
  const hay = "\n" + bodyLines.join("\n") + "\n";
  return hay.includes("\n" + text + "\n");
}

/**
 * Read the morning section. Reflection wins when both headings are present.
 * Otherwise the old Mark heading is the morning section. Missing means
 * `{ name: null, body: "" }`.
 */
export function readMorningSection(markdown) {
  const lines = splitLines(markdown ?? "");
  const found = locateMorning(lines);
  if (!found) return { name: null, body: "" };
  return { name: found.name, body: bodyText(found.bodyLines) };
}

function appendInSection(lines, found, text) {
  let contentEnd = found.end;
  while (contentEnd > found.start + 1 && lines[contentEnd - 1].trim() === "") {
    contentEnd -= 1;
  }
  const out = [];
  if (contentEnd === found.start + 1) {
    out.push(...lines.slice(0, found.start + 1));
    out.push("");
  } else {
    out.push(...lines.slice(0, contentEnd));
    out.push("");
  }
  out.push(...text.split("\n"));
  if (found.end < lines.length) {
    if (out[out.length - 1] !== "") out.push("");
    out.push(...lines.slice(found.end));
  } else if (out[out.length - 1] !== "") {
    out.push("");
  }
  return out;
}

function appendNewSection(lines, text) {
  const out = lines.slice();
  while (out.length > 0 && out[out.length - 1] === "") out.pop();
  if (out.length > 0) out.push("");
  out.push("## " + WRITE_SECTION);
  out.push("");
  out.push(...text.split("\n"));
  out.push("");
  return out;
}

/**
 * Place `morning` into the day note.
 * Returns the original string when there is nothing new to file.
 */
export function fileMorningWriting(markdown, morning) {
  const original = typeof markdown === "string" ? markdown : String(markdown ?? "");
  const text = String(morning ?? "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
  if (!text) return original;
  const lines = splitLines(original);
  const found = locateMorning(lines);
  if (found && alreadyFiled(found.bodyLines, text)) return original;
  const nl = newlineOf(original);
  const next = found ? appendInSection(lines, found, text) : appendNewSection(lines, text);
  return next.join(nl);
}

function usage() {
  console.error(
    "usage: node scripts/pull-noteplan-daily.mjs --day <day-note.md> --text-file <morning.txt>"
  );
}

function flagValue(argv, name) {
  const i = argv.indexOf(name);
  if (i < 0) return "";
  const value = argv[i + 1];
  if (!value || value.startsWith("--")) return "";
  return value;
}

function readTextFile(filePath, label) {
  let st;
  try {
    st = fs.statSync(filePath);
  } catch (e) {
    console.error(label + " not found (" + (e && e.code ? e.code : "error") + ")");
    process.exit(1);
  }
  if (!st.isFile()) {
    console.error(label + " is not a file");
    process.exit(1);
  }
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch (e) {
    console.error("could not read " + label + " (" + (e && e.code ? e.code : "error") + ")");
    process.exit(1);
  }
}

export function runCli(argv) {
  const dayPath = flagValue(argv, "--day");
  const textPath = flagValue(argv, "--text-file");
  if (!dayPath || !textPath) {
    usage();
    process.exit(2);
  }
  const day = readTextFile(dayPath, "day file");
  const morning = readTextFile(textPath, "morning file");
  const next = fileMorningWriting(day, morning);
  if (next === day) {
    console.log("unchanged");
    return;
  }
  try {
    fs.writeFileSync(dayPath, next, "utf8");
  } catch (e) {
    console.error("could not write day file (" + (e && e.code ? e.code : "error") + ")");
    process.exit(1);
  }
  console.log("updated");
}

function isDirectRun() {
  const entry = process.argv[1];
  if (!entry) return false;
  return path.resolve(entry) === fileURLToPath(import.meta.url);
}

if (isDirectRun()) {
  runCli(process.argv.slice(2));
}
