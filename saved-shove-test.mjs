#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(path.join(root, "day.css"), "utf8");
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");
function assert(c, m) { if (!c) throw new Error(m); }
const statusBlock = css.slice(css.indexOf(".today-nav .status"), css.indexOf(".today-nav .status.error"));
assert(statusBlock.includes("min-width"), "status chip must reserve width");
assert(statusBlock.includes("min-height") || statusBlock.includes("height:"), "status chip must reserve height");
assert(statusBlock.includes("nowrap"), "status chip must not wrap");
assert(css.includes("align-items: center"), "today-nav align-items center");
assert(src.includes("msg ||") && src.includes("setStatus"), "empty status keeps a line box");
console.log("saved-shove-test ok");
