#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

assert(!fs.existsSync(path.join(root, "design-system/periodic-table")), "do not revive periodic-table");

const readme = read("design-system/atomic-library/README.md");
const table = read("design-system/atomic-library/TABLE.md");
const gallery = read("design-system/atomic-library/gallery.html");
const pressure = read("design-system/atomic-library/PRESSURE.md");
const index = read("design-system/README.md");
const lastMile = read("design-system/patterns/last-mile.md");
const kernel = read("design-system/components/README.md");

const sections = ["## Foundations", "## Controls", "## Composition patterns", "## States"];
for (const name of sections) {
  assert(table.includes(name), "TABLE.md must have " + name);
}

assert(table.includes("elevation"), "foundations must refuse elevation catalogs");
assert(table.includes("motion"), "foundations must refuse motion catalogs");
assert(table.includes("thirty-four") || table.includes("34"), "Keep is closed at thirty-four");

const already = [
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
  "Saved chip",
  "Door prompt bar"
];

const keep = [
  "Text input",
  "Multiline",
  "Search field",
  "Number",
  "Money",
  "Date",
  "Time",
  "Radio/choice",
  "Select",
  "Drag handle",
  "Tabs",
  "Segmented control",
  "Chip/tag",
  "Person chip",
  "Status word",
  "Progress fraction",
  "Spinner/loading",
  "Tooltip/field help",
  "Validation line",
  "Soft notice",
  "Page message",
  "Menu",
  "Menu item",
  "Popover",
  "Dialog/confirm panel",
  "Sheet/drawer",
  "Modal scrim",
  "Title",
  "Section head",
  "Separator",
  "List row",
  "Checkbox row",
  "Table head",
  "Table cell"
];

assert(keep.length === 34, "Keep list must be 34, got " + keep.length);

const composition = [
  "Labeled field",
  "Key facts",
  "Place crumb",
  "Related strip",
  "Association line",
  "Activity line",
  "Log activity",
  "Stage steps",
  "Prompt bar / actions row",
  "Lookup field",
  "Line-item sheet",
  "Data table",
  "Bulk bar",
  "Child list",
  "Dependency line",
  "Confirm pair",
  "Confirm destroy",
  "Settings group",
  "Filter chips row",
  "Pagination strip",
  "Attachment line",
  "Quiet sheet",
  "Duration mark"
];

const states = [
  "Default",
  "Hover",
  "Focus",
  "Active",
  "Disabled",
  "Loading",
  "Empty",
  "Error",
  "Success",
  "Selected",
  "Dragging",
  "Checked",
  "Expanded",
  "Collapsed"
];

const refuse = [
  "Switch / toggle",
  "Slider",
  "Reaction kit",
  "Chart zoo",
  "Stepper",
  "Icon-only button",
  "Badge count",
  "Progress bar or ring",
  "Skeleton shimmer",
  "Toast stack",
  "Avatar pile",
  "Presence dot",
  "Traffic-light badge",
  "Floating action button",
  "Left icon nav rail",
  "Path chevrons",
  "Highlights panel",
  "Utility bar",
  "Console subtabs",
  "App Builder mosaic",
  "Monday rainbow",
  "Lightning brand",
  "Theme catalog",
  "Salesforce chrome",
  "Resize handle"
];

const defer = ["Board lane", "Board card", "Board column", "Board slip", "Timeline view"];

for (const name of already) {
  assert(table.includes("| " + name + " | Already |"), "TABLE.md must mark " + name + " Already");
  assert(gallery.includes("<h2>" + name + "</h2>"), "gallery.html must show " + name);
}

assert(table.includes("| Save state | Already |"), "Save state is the saved chip, Already");

for (const name of keep) {
  assert(table.includes("| " + name + " | Keep |"), "TABLE.md must mark " + name + " Keep");
  assert(gallery.includes("<h2>" + name + "</h2>"), "gallery.html must show " + name);
}

const keepRows = [...table.matchAll(/\| [^|]+ \| Keep \|/g)];
assert(keepRows.length === 34, "TABLE.md must have exactly 34 Keep rows, got " + keepRows.length);

for (const name of composition) {
  assert(table.includes("| " + name + " |"), "TABLE.md must name composition " + name);
  assert(!table.includes("| " + name + " | Keep |"), name + " is composition, not Keep");
  assert(gallery.includes("<h2>" + name + "</h2>"), "gallery.html must show composition " + name);
}

for (const name of states) {
  assert(table.includes(name), "TABLE.md must name state " + name);
}

for (const name of refuse) {
  assert(table.includes("| " + name + " | Refuse |"), "TABLE.md must refuse " + name);
}

for (const name of defer) {
  assert(table.includes("| " + name + " | Defer |"), "TABLE.md must defer " + name);
}

assert(table.includes("operating system file dialog") || table.includes("file dialog is System"), "OS file dialog is System");

const headings = [...gallery.matchAll(/<h2>([^<]+)<\/h2>/g)].map((m) => m[1]);
for (const name of [...already, ...keep, ...composition]) {
  assert(headings.includes(name), "gallery must include heading " + name);
}

const keepAndAlreadyHeadings = headings.filter((h) => already.includes(h) || keep.includes(h));
assert(keepAndAlreadyHeadings.length === already.length + keep.length, "gallery must show each Keep and Already once");

assert(!gallery.includes("<h2>Get to Work</h2>"), "Get to Work is not its own atom");
assert(!gallery.includes("<h2>Capture thoughts</h2>"), "Capture thoughts is not its own atom");
assert(gallery.includes("class=\"hairline-button\""), "gallery must use the kernel hairline button");
assert(gallery.includes("../foundations/tokens.css"), "gallery must load Stoic tokens");
assert(gallery.includes("../components/primitives.css"), "gallery must load kernel primitives");
assert(!gallery.includes("class=\"skeleton\"") && !gallery.includes("class=\"progress-bar\"") && !gallery.includes("class=\"fab\"") && !gallery.includes("class=\"avatar\""), "gallery must not ship refused chrome");

assert(!/Where CRM|ERP:|Project:|### Identity|### Fields|### Collections/.test(table), "TABLE.md must not frame vendor screen jobs");
assert(!table.includes("periodic table") && !table.includes("Periodic table"), "TABLE.md must not revive periodic-table framing");
assert(!readme.includes("periodic table of") && readme.includes("snipped"), "README must say the jobs draft was snipped");

assert(index.includes("atomic-library"), "design-system README must point at atomic-library");
assert(index.includes("number 7") || index.includes("pull request 7") || index.includes("pull request (number 7)"), "design-system README must note pull request 7 was snipped");
assert(lastMile.includes("atomic-library/TABLE.md"), "last-mile must generate from the atomic library");
assert(kernel.includes("atomic-library"), "kernel README must point at the atomic library");

const surfaces = [
  "Mail",
  "Calendar",
  "Notes",
  "Chat",
  "Checkout",
  "Settings",
  "Admin tables",
  "Charts",
  "Media",
  "Auth",
  "Onboarding",
  "File picker",
  "Offline"
];
for (const name of surfaces) {
  assert(pressure.includes(name) && pressure.includes("PASS"), "PRESSURE.md must pass " + name);
}
assert((pressure.match(/PASS/g) || []).length >= 13, "PRESSURE.md must mark 13 passes");
assert(pressure.includes("Pagination strip") || table.includes("Pagination strip"), "pagination strip is named");
assert(!pressure.includes("forced Keep") || pressure.includes("No Keep atom was added"), "pressure did not add Keep atoms");

console.log("atomic-library-test ok");
