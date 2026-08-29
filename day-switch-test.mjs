#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(root, "app.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const start = src.indexOf("async function openDay(");
assert(start >= 0, "openDay missing");
const next = src.indexOf("\nfunction renderDay(", start);
assert(next > start, "renderDay after openDay");
const fn = src.slice(start, next);

assert(!fn.includes("setStatus(\"Loading\")"), "day switch must not show Loading");
assert(!/await leaveCurrentPaper\(\)/.test(fn), "new day must not wait on saving the old one");
assert(/api\("\/api\/day\?date="/.test(fn), "openDay still GET /api/day");
assert(fn.includes("renderDay()"), "openDay paints the day");
assert(fn.indexOf("renderDay()") < fn.indexOf("putRawDay"), "paint before saving the old day");
assert(fn.indexOf("renderDay()") < fn.indexOf("await renderMonth()"), "paper paints before month");
assert(fn.includes("openDayGen"), "stale openDay must not clobber");
assert(/catch \(e\)/.test(fn), "a failed switch is caught");

const apiStart = src.indexOf("async function api(");
const apiFn = src.slice(apiStart, src.indexOf("function dayMarkdown(", apiStart));
assert(!apiFn.includes("AbortController") && !apiFn.includes("abort("), "do not abort the day fetch");
assert(apiFn.includes("fetch("), "api still fetches");

const goStart = src.indexOf("function goToday(");
const go = src.slice(goStart, src.indexOf("$(\"door-form\")", goStart));
assert(go.includes("showView(\"today\")"), "Today from Plan shows Today");
assert(go.includes("openDay(todayIso())"), "Today from Plan opens calendar today");
assert(src.includes("querySelectorAll(\"a[href='#today']\")"), "Plan Today link also calls goToday");
assert(src.includes("if (currentView() === \"today\")"), "Door boot does not fetch the day");
assert(src.includes("!state.week"), "Get to work still loads week cards");

console.log("day-switch-test ok");
