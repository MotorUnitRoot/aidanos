#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

const list = [
  "Door prompt bar",
  "Hairline button",
  "Text link",
  "Week card",
  "Week chevron",
  "Day chevron",
  "42rem paper",
  "Checkbox",
  "Hanging list",
  "Wiki link",
  "Quiet label",
  "Empty state (Write.)",
  "Ask strip",
  "Search hit",
  "Half-hour agenda slot",
  "Drag preview",
  "Month day (mark if a note exists)",
  "Saved chip (reserved space, does not shove the paper)"
];

const headings = [
  "Door prompt bar",
  "Hairline button",
  "Text link",
  "Week card",
  "Week chevron",
  "Day chevron",
  "42rem paper",
  "Checkbox",
  "Hanging list",
  "Wiki link",
  "Quiet label",
  "Empty state",
  "Ask strip",
  "Search hit",
  "Half-hour agenda slot",
  "Drag preview",
  "Month day",
  "Saved chip"
];

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const readme = read("design-system/components/README.md");
const library = read("design-system/components/library.html");
const primitives = read("design-system/components/primitives.css");
const door = read("design-system/patterns/door.html");
const today = read("design-system/patterns/today.html");
const plan = read("design-system/patterns/plan.html");
const generated = read("design-system/patterns/generated.html");

for (const name of list) {
  assert(readme.includes("- " + name), "README.md must name " + name);
}

for (const name of headings) {
  assert(library.includes("<h2>" + name + "</h2>"), "library.html must show " + name);
}

assert(!library.includes("<h2>Get to Work</h2>"), "Get to Work is not its own primitive");
assert(!library.includes("<h2>Capture thoughts</h2>"), "Capture thoughts is not its own primitive");

assert(primitives.includes(".hairline-button"), "primitives.css must define the hairline button");
assert(!primitives.includes("text-decoration: underline"), "hairline button is not underlined text");

const hairlineUses = library.match(/class="hairline-button">([^<]+)</g) || [];
const labels = hairlineUses.map((m) => m.replace(/class="hairline-button">/, "").replace("<", ""));
for (const label of ["Get to Work", "Capture thoughts", "Accept", "Reject"]) {
  assert(labels.includes(label), "library hairline button must show " + label);
}

assert((door.match(/class="hairline-button"/g) || []).length >= 2, "Door uses the hairline button twice");
assert(door.includes(">Get to Work<") && door.includes(">Capture thoughts<"), "Door shows both uses");
assert(!door.includes("class=\"capture\"") && !door.includes("class=\"work\""), "Door does not invent special button classes");

assert((generated.match(/class="hairline-button"/g) || []).length >= 2, "generated last-mile uses the hairline button twice");
assert(generated.includes(">Get to Work<") && generated.includes(">Capture thoughts<"), "generated shows both uses");
assert(!generated.includes("class=\"capture\"") && !generated.includes("class=\"work\""), "generated does not invent special button classes");

assert(today.includes("class=\"text-link") && today.includes("class=\"week-chevron\"") && today.includes("class=\"day-chevron\""), "Today assembles text link, week chevron, and day chevron");
assert(today.includes("class=\"saved") && today.includes("class=\"month-day"), "Today assembles saved chip and month day");
assert(plan.includes("class=\"text-link") && plan.includes("class=\"quiet-label\"") && plan.includes("class=\"box\""), "Plan assembles text link, quiet label, and checkbox");

for (const [name, html] of [["door", door], ["today", today], ["plan", plan], ["generated", generated]]) {
  assert(html.includes("../components/primitives.css"), name + ".html must load primitives.css");
  assert(!/class="capture"/.test(html), name + ".html must not invent a capture look");
}

const saved = primitives.slice(primitives.indexOf(".saved {"), primitives.indexOf(".saved.is-saved"));
assert(saved.includes("min-width"), "saved chip must reserve width");
assert(saved.includes("min-height") || saved.includes("height:"), "saved chip must reserve height");
assert(saved.includes("nowrap"), "saved chip must not wrap");

console.log("library-primitives-test ok");
