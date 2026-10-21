#!/usr/bin/env node
// Drives the real client (app.js) against a fake page and fetch.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const appSrc = fs.readFileSync(path.join(root, "app.js"), "utf8");

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

function makeStorage() {
  const map = new Map();
  return {
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(k) { return map.has(String(k)) ? map.get(String(k)) : null; },
    setItem(k, v) { map.set(String(k), String(v)); },
    removeItem(k) { map.delete(String(k)); },
    clear() { map.clear(); },
    keys() { return [...map.keys()]; },
  };
}

function createEl(doc, id) {
  const attrs = {};
  const listeners = {};
  const el = {
    id: id || "",
    hidden: false,
    value: "",
    textContent: "",
    className: "",
    title: "",
    tabIndex: 0,
    style: {},
    dataset: {},
    children: [],
    childNodes: [],
    parentElement: null,
    _html: "",
  };
  const cls = new Set();
  el.classList = {
    add(...names) { names.forEach((n) => n && cls.add(n)); },
    remove(...names) { names.forEach((n) => cls.delete(n)); },
    toggle(name, force) {
      const on = force == null ? !cls.has(name) : !!force;
      if (on) cls.add(name);
      else cls.delete(name);
      return on;
    },
    contains(name) { return cls.has(name); },
  };
  el.setAttribute = (k, v) => {
    attrs[k] = String(v);
    if (k === "hidden") el.hidden = true;
  };
  el.removeAttribute = (k) => {
    delete attrs[k];
    if (k === "hidden") el.hidden = false;
  };
  el.getAttribute = (k) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null);
  el.hasAttribute = (k) => Object.prototype.hasOwnProperty.call(attrs, k);
  el.addEventListener = (type, fn) => {
    (listeners[type] || (listeners[type] = [])).push(fn);
  };
  el.removeEventListener = () => {};
  el.click = () => {
    const ev = { target: el, preventDefault() {}, stopPropagation() {} };
    (listeners.click || []).forEach((fn) => fn(ev));
  };
  el.appendChild = (child) => {
    el.children.push(child);
    el.childNodes.push(child);
    if (child) child.parentElement = el;
    return child;
  };
  el.insertBefore = (node, before) => {
    const i = el.children.indexOf(before);
    if (i < 0) el.children.push(node);
    else el.children.splice(i, 0, node);
    el.childNodes = el.children.slice();
    if (node) node.parentElement = el;
    return node;
  };
  el.removeChild = (child) => child;
  el.focus = () => { doc.activeElement = el; };
  el.blur = () => {};
  el.closest = () => null;
  el.contains = (node) => node === el;
  el.querySelector = (sel) => {
    if (sel === ".conflict-kicker") {
      if (!el._kicker) el._kicker = createEl(doc, "kicker");
      return el._kicker;
    }
    return null;
  };
  el.querySelectorAll = () => [];
  el.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: 0, right: 0, width: 0, height: 0 });
  Object.defineProperty(el, "innerHTML", {
    get() { return el._html; },
    set(v) { el._html = String(v ?? ""); },
  });
  Object.defineProperty(el, "innerText", {
    get() { return el.textContent; },
    set(v) { el.textContent = String(v ?? ""); },
  });
  return el;
}

function jsonRes(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    statusText: status === 200 ? "OK" : "Conflict",
    headers: { get() { return null; } },
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

function boot() {
  const requests = [];
  const timers = [];
  let timerSeq = 1;
  const storage = makeStorage();
  const session = makeStorage();
  const els = new Map();
  const doc = {
    activeElement: null,
    visibilityState: "visible",
    title: "",
  };
  doc.body = createEl(doc, "body");
  doc.documentElement = createEl(doc, "html");
  doc.createElement = (tag) => createEl(doc, tag);
  doc.createRange = () => ({
    setStart() {},
    setEndBefore() {},
    toString() { return ""; },
  });
  doc.getElementById = (id) => {
    if (!els.has(id)) els.set(id, createEl(doc, id));
    return els.get(id);
  };
  doc.addEventListener = () => {};
  doc.removeEventListener = () => {};
  doc.querySelector = () => null;
  doc.querySelectorAll = () => [];
  const sheet = doc.getElementById("conflict-sheet");
  sheet.hidden = true;
  sheet.setAttribute("hidden", "");

  const sandbox = {
    console,
    Date,
    Math,
    JSON,
    Number,
    String,
    Object,
    Array,
    Promise,
    Error,
    RegExp,
    parseInt,
    parseFloat,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    AbortController,
    URL,
    URLSearchParams,
    document: doc,
    navigator: {},
    location: { protocol: "about:", hash: "", pathname: "/", search: "", href: "about:blank" },
    history: { replaceState() {}, pushState() {} },
    localStorage: storage,
    sessionStorage: session,
    setTimeout(fn, ms) {
      const id = timerSeq++;
      timers.push({ id, fn, ms: Number(ms) || 0 });
      return id;
    },
    clearTimeout(id) {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    fetch(url, opts) {
      const method = String((opts && opts.method) || "GET").toUpperCase();
      const u = String(url);
      if (method === "GET" && u.startsWith("/api/file")) {
        return Promise.resolve(jsonRes(200, { path: "", markdown: "", mtime: 1 }));
      }
      if (method === "GET" && u.startsWith("/api/plan")) {
        return Promise.resolve(jsonRes(200, { plan: null, exists: false }));
      }
      if (method === "GET" && u.startsWith("/api/week")) {
        return Promise.resolve(jsonRes(200, { week_start: "2026-10-19", days: [], exists: false }));
      }
      if (method === "GET" && u.startsWith("/api/month")) {
        return Promise.resolve(jsonRes(200, { year: 2026, month: 10, days: [] }));
      }
      if (method === "GET" && u.startsWith("/api/sync")) {
        return Promise.resolve(jsonRes(200, { enabled: false, ok: true, error: "", conflicts: [], join: false, left: "" }));
      }
      return new Promise((resolve, reject) => {
        requests.push({ url: u, method, opts: opts || {}, resolve, reject });
      });
    },
    EventSource: class {
      constructor() { this.readyState = 1; this.onmessage = null; }
      close() { this.readyState = 2; }
    },
    matchMedia() {
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    },
  };
  sandbox.addEventListener = () => {};
  sandbox.removeEventListener = () => {};
  sandbox.getSelection = () => null;
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(appSrc, sandbox, { filename: "app.js" });
  return { sandbox, requests, timers, storage, doc };
}

async function tick() {
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
}

function take(requests, pred) {
  const i = requests.findIndex(pred);
  if (i < 0) return null;
  return requests.splice(i, 1)[0];
}

async function loadDay(client, date, markdown, mtime) {
  const pending = client.sandbox.openDay(date);
  await tick();
  const got = take(client.requests, (r) => r.method === "GET" && r.url.includes("/api/day") && r.url.includes(date));
  assert(got, "no GET for " + date + " (" + client.requests.map((r) => r.method + " " + r.url).join(", ") + ")");
  got.resolve(jsonRes(200, { date, markdown, mtime }));
  await pending;
  await tick();
}

const results = [];
function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => {
      results.push({ name, ok: true });
      console.log("pass  " + name);
    })
    .catch((err) => {
      results.push({ name, ok: false, error: err && err.stack || String(err) });
      console.log("FAIL  " + name + "  " + (err && err.message || err));
    });
}

await check("a day switch with a 409 keeps the text and shows the sheet", async () => {
  const client = boot();
  const day = "2026-10-21";
  const next = "2026-10-22";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "typed on the phone";
  client.sandbox.scheduleSave();
  const leaving = client.sandbox.openDay(next);
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "day switch did not try to save the old day");
  const sent = JSON.parse(put.opts.body);
  assert(sent.markdown === "typed on the phone", "old day save sent " + sent.markdown);
  assert(sent.mtime === 100, "old day save used the loaded mtime");
  put.resolve(jsonRes(409, {
    error: "disk newer",
    date: day,
    markdown: "from the desk",
    mtime: 400,
  }));
  await leaving;
  await tick();
  assert(dump.value === "typed on the phone", "409 day switch dropped the typed text: " + dump.value);
  const sheet = client.doc.getElementById("conflict-sheet");
  assert(sheet.hidden === false, "409 day switch did not show the conflict sheet");
  assert(client.doc.getElementById("conflict-mine").textContent === "typed on the phone", "sheet mine is not the typed text");
  assert(client.doc.getElementById("conflict-theirs").textContent === "from the desk", "sheet theirs is not the disk text");
  assert(
    !client.requests.some((r) => r.url.includes(next)),
    "409 day switch still loaded the next day",
  );
});

await check("close with a 409 stores the text and the next load offers it", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "unsent close text";
  client.sandbox.scheduleSave();
  client.sandbox.flushOnLeave();
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "close did not try to save");
  const sent = JSON.parse(put.opts.body);
  assert(sent.mtime === 100, "close save was not based on the loaded version");
  put.resolve(jsonRes(409, {
    error: "disk newer",
    date: day,
    markdown: "from the desk",
    mtime: 400,
  }));
  await tick();
  const sheet = client.doc.getElementById("conflict-sheet");
  assert(sheet.hidden === true, "a close-time 409 opened the sheet");
  const key = client.storage.keys().find((k) => k.indexOf("log/" + day + ".md") >= 0 && k.endsWith(":100"));
  assert(key, "unsent text was not stored by path and base version (" + client.storage.keys().join(", ") + ")");
  const held = JSON.parse(client.storage.getItem(key));
  assert(held.markdown === "unsent close text", "stored text was " + held.markdown);
  assert(held.base === 100, "stored base was " + held.base);
  assert(held.path === "log/" + day + ".md", "stored path was " + held.path);

  await loadDay(client, day, "from the desk", 400);
  assert(sheet.hidden === false, "the next load did not offer the stored text");
  assert(client.doc.getElementById("conflict-mine").textContent === "unsent close text", "offered mine is not the stored text");
  assert(client.doc.getElementById("conflict-theirs").textContent === "from the desk", "offered theirs is not the disk text");
  client.doc.getElementById("conflict-take").click();
  await tick();
  assert(sheet.hidden === true, "Take theirs left the sheet open");
  assert(
    !client.storage.keys().some((k) => k.indexOf("log/" + day + ".md") >= 0),
    "choosing left the stored copy behind",
  );
});

await check("typing during an in-flight day save keeps the flag set", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "one", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "one";
  client.sandbox.scheduleSave();
  const saving = client.sandbox.saveDay();
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "the in-flight save never started");
  dump.value = "one plus";
  client.sandbox.scheduleSave();
  put.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await saving;
  await tick();
  client.sandbox.flushOnLeave();
  await tick();
  const again = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(again, "the unsaved-edits flag was cleared while a later edit was still on the page");
  const sent = JSON.parse(again.opts.body);
  assert(sent.markdown === "one plus", "the later edit was not what got saved (" + sent.markdown + ")");
});

await check("a pending timer during a day switch never writes to the new day", async () => {
  const client = boot();
  const day = "2026-10-21";
  const next = "2026-10-22";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "old typed text";
  client.sandbox.scheduleSave();
  assert(client.timers.some((t) => t.ms === 350), "typing did not start the debounce timer");
  const leaving = client.sandbox.openDay(next);
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "the old day was not saved on the way out");
  assert(JSON.parse(put.opts.body).markdown === "old typed text", "the old day save was not the typed text");
  put.resolve(jsonRes(200, { ok: true, date: day, mtime: 150 }));
  await tick();
  const got = take(client.requests, (r) => r.method === "GET" && r.url.includes(next));
  assert(got, "the new day was not loaded");
  got.resolve(jsonRes(200, { date: next, markdown: "day b", mtime: 50 }));
  await leaving;
  await tick();
  assert(dump.value === "day b", "the new day did not paint (" + dump.value + ")");
  const queued = client.timers.splice(0, client.timers.length);
  for (const t of queued) t.fn();
  await tick();
  const late = client.requests.filter((r) => r.method === "PUT" && r.url.includes(next));
  assert(late.length === 0, "the debounce timer wrote the new day: " + late.map((r) => r.opts && r.opts.body).join(" | "));
  assert(dump.value === "day b", "the timer replaced the new day");
});

await check("close with no server reply stores the text and the next load offers it", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "kept across refresh";
  client.sandbox.scheduleSave();
  client.sandbox.flushOnLeave();
  const key = client.storage.keys().find((k) => k.indexOf("log/" + day + ".md") >= 0);
  assert(key, "the local copy was not written before the server answered (" + client.storage.keys().join(", ") + ")");
  const held = JSON.parse(client.storage.getItem(key));
  assert(held.markdown === "kept across refresh", "stored text was " + held.markdown);
  assert(held.path === "log/" + day + ".md", "stored path was " + held.path);
  assert(held.base === 100, "stored base was " + held.base);
  const put = client.requests.find((r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "the closing save was not sent");
  assert(put.opts.keepalive === true, "the closing save was not sent with keepalive");
  assert(JSON.parse(put.opts.body).markdown === "kept across refresh", "the closing save was not the typed text");
  await loadDay(client, day, "saved line", 100);
  const sheet = client.doc.getElementById("conflict-sheet");
  assert(sheet.hidden === false, "the next load did not offer the unanswered text");
  assert(client.doc.getElementById("conflict-mine").textContent === "kept across refresh", "offered mine is not the stored text");
  assert(client.doc.getElementById("conflict-theirs").textContent === "saved line", "offered theirs is not the disk text");
});

await check("close while a save is in flight still sends the closing save", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "first draft";
  client.sandbox.scheduleSave();
  client.sandbox.saveDay();
  await tick();
  const first = client.requests.find((r) => r.method === "PUT" && r.url.includes(day));
  assert(first, "the earlier save never started");
  assert(JSON.parse(first.opts.body).markdown === "first draft", "the earlier save was not the first draft");
  dump.value = "second draft";
  client.sandbox.scheduleSave();
  client.sandbox.flushOnLeave();
  const puts = client.requests.filter((r) => r.method === "PUT" && r.url.includes(day));
  assert(puts.length >= 2, "the closing save waited for the earlier one (" + puts.length + " sent)");
  const closePut = puts.find((r) => r.opts && r.opts.keepalive === true);
  assert(closePut, "the closing save was not sent while the earlier one was in flight");
  assert(JSON.parse(closePut.opts.body).markdown === "second draft", "the closing save was not the latest text");
  const key = client.storage.keys().find((k) => k.indexOf("log/" + day + ".md") >= 0);
  assert(key, "the local copy was not written while the earlier save was in flight");
  assert(JSON.parse(client.storage.getItem(key)).markdown === "second draft", "the stored copy was not the latest text");
});

await check("an in-flight autosave does not make the day switch show a conflict", async () => {
  const client = boot();
  const day = "2026-10-21";
  const next = "2026-10-22";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "typed while saving";
  client.sandbox.scheduleSave();
  client.sandbox.saveDay();
  await tick();
  const first = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(first, "the autosave never started");
  assert(JSON.parse(first.opts.body).markdown === "typed while saving", "the autosave was not the typed text");
  assert(JSON.parse(first.opts.body).mtime === 100, "the autosave was not based on the loaded version");
  const leaving = client.sandbox.openDay(next);
  await tick();
  assert(
    !client.requests.some((r) => r.method === "PUT"),
    "the day switch sent another save before the autosave finished",
  );
  first.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await tick();
  const second = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(second, "the day switch did not save after the autosave");
  const sent = JSON.parse(second.opts.body);
  assert(sent.markdown === "typed while saving", "the follow-up save lost the typed text (" + sent.markdown + ")");
  assert(sent.mtime === 180, "the follow-up save reused the old version " + sent.mtime);
  second.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await tick();
  const got = take(client.requests, (r) => r.method === "GET" && r.url.includes(next));
  assert(got, "the next day was not loaded");
  got.resolve(jsonRes(200, { date: next, markdown: "day b", mtime: 50 }));
  await leaving;
  await tick();
  assert(dump.value === "day b", "the next day did not paint (" + dump.value + ")");
  assert(client.doc.getElementById("conflict-sheet").hidden === true, "the day switch showed a conflict sheet");
});

await check("two quick day switches do not resend the old version", async () => {
  const client = boot();
  const day = "2026-10-21";
  const mid = "2026-10-22";
  const next = "2026-10-23";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "typed once";
  client.sandbox.scheduleSave();
  const leaveMid = client.sandbox.openDay(mid);
  await tick();
  const first = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(first, "the first day switch did not save the old day");
  assert(JSON.parse(first.opts.body).markdown === "typed once", "the first save was not the typed text");
  assert(JSON.parse(first.opts.body).mtime === 100, "the first save was not based on the loaded version");
  const leaveNext = client.sandbox.openDay(next);
  await tick();
  assert(
    !client.requests.some((r) => r.method === "PUT"),
    "the second click resent the old day before the first save finished",
  );
  first.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await tick();
  const second = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(second, "the second day switch did not save after the first");
  const sent = JSON.parse(second.opts.body);
  assert(sent.markdown === "typed once", "the second save lost the typed text (" + sent.markdown + ")");
  assert(sent.mtime === 180, "the second save reused the old version " + sent.mtime);
  second.resolve(jsonRes(200, { ok: true, date: day, mtime: 190 }));
  await tick();
  assert(!client.requests.some((r) => r.url.includes(mid)), "the first click still loaded its day");
  const got = take(client.requests, (r) => r.method === "GET" && r.url.includes(next));
  assert(got, "the second day was not loaded");
  got.resolve(jsonRes(200, { date: next, markdown: "day c", mtime: 70 }));
  await leaveMid;
  await leaveNext;
  await tick();
  assert(dump.value === "day c", "the second day did not paint (" + dump.value + ")");
  assert(client.doc.getElementById("conflict-sheet").hidden === true, "the quick switches showed a conflict sheet");
});

await check("typing during a day switch does not show a conflict or lose the text", async () => {
  const client = boot();
  const day = "2026-10-21";
  const next = "2026-10-22";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "alpha";
  client.sandbox.scheduleSave();
  const leaving = client.sandbox.openDay(next);
  await tick();
  const first = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(first, "the day switch did not start saving");
  assert(JSON.parse(first.opts.body).markdown === "alpha", "the first save was not the text at the click");
  assert(JSON.parse(first.opts.body).mtime === 100, "the first save was not based on the loaded version");
  dump.value = "alpha beta";
  client.sandbox.scheduleSave();
  assert(!client.requests.some((r) => r.method === "PUT"), "typing sent a second save before the first finished");
  first.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await tick();
  const second = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(second, "the newer text was not saved");
  const sent = JSON.parse(second.opts.body);
  assert(sent.markdown === "alpha beta", "the newer text was lost (" + sent.markdown + ")");
  assert(sent.mtime === 180, "the newer text was saved with the old version " + sent.mtime);
  second.resolve(jsonRes(200, { ok: true, date: day, mtime: 200 }));
  await tick();
  const got = take(client.requests, (r) => r.method === "GET" && r.url.includes(next));
  assert(got, "the next day was not loaded");
  got.resolve(jsonRes(200, { date: next, markdown: "day b", mtime: 50 }));
  await leaving;
  await tick();
  assert(dump.value === "day b", "the next day did not paint (" + dump.value + ")");
  assert(client.doc.getElementById("conflict-sheet").hidden === true, "typing during the switch showed a conflict sheet");
});

await check("a day switch that cannot reach the server stays on the day", async () => {
  const client = boot();
  const day = "2026-10-21";
  const next = "2026-10-22";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "typed offline";
  client.sandbox.scheduleSave();
  const leaving = client.sandbox.openDay(next);
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "the day switch did not try to save");
  put.reject(new Error("Failed to fetch"));
  await leaving;
  await tick();
  assert(dump.value === "typed offline", "the failed switch left the page (" + dump.value + ")");
  assert(client.doc.getElementById("conflict-sheet").hidden === true, "a network failure opened the conflict sheet");
  assert(client.doc.getElementById("status").textContent === "Failed to fetch", "the status line did not use the fetch error");
  const key = client.storage.keys().find((k) => k.indexOf("log/" + day + ".md") >= 0);
  assert(key, "the failed switch did not keep a local copy");
  assert(JSON.parse(client.storage.getItem(key)).markdown === "typed offline", "the local copy was not the typed text");
  assert(!client.requests.some((r) => r.url.includes(next)), "the failed switch still loaded the next day");
});

await check("an older stored copy is not offered after a later good save", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "first typing";
  client.sandbox.scheduleSave();
  const saving = client.sandbox.saveDay();
  await tick();
  const autosave = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(autosave, "the autosave never started");
  dump.value = "first typing plus";
  client.sandbox.scheduleSave();
  client.sandbox.flushOnLeave();
  const hide = take(client.requests, (r) => r.method === "PUT" && r.opts && r.opts.keepalive === true);
  assert(hide, "the hide did not send a save");
  assert(JSON.parse(hide.opts.body).markdown === "first typing plus", "the hide save was not the text on the page");
  hide.resolve(jsonRes(409, {
    error: "disk newer",
    date: day,
    markdown: "from elsewhere",
    mtime: 150,
  }));
  await tick();
  const stored = client.storage.keys().filter((k) => k.indexOf("log/" + day + ".md") >= 0);
  assert(stored.length === 1, "the refused hide did not keep a local copy (" + stored.join(", ") + ")");
  assert(JSON.parse(client.storage.getItem(stored[0])).markdown === "first typing plus", "the stored copy was not the hide text");
  autosave.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await saving;
  await tick();
  const still = client.storage.keys().filter((k) => k.indexOf("log/" + day + ".md") >= 0);
  assert(still.length === 1, "the earlier save cleared the newer stored copy");
  assert(JSON.parse(client.storage.getItem(still[0])).markdown === "first typing plus", "the stored copy changed after the earlier save");
  dump.value = "second typing";
  client.sandbox.scheduleSave();
  const later = client.sandbox.saveDay();
  await tick();
  const put = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day));
  assert(put, "the later save was not sent");
  assert(JSON.parse(put.opts.body).markdown === "second typing", "the later save was not the newest text");
  put.resolve(jsonRes(200, { ok: true, date: day, mtime: 220 }));
  await later;
  await tick();
  assert(
    !client.storage.keys().some((k) => k.indexOf("log/" + day + ".md") >= 0),
    "the later save left the older copy stored (" + client.storage.keys().join(", ") + ")",
  );
  await loadDay(client, day, "second typing", 220);
  assert(client.doc.getElementById("conflict-sheet").hidden === true, "the next open offered the older copy");
  assert(dump.value === "second typing", "the next open replaced the saved text (" + dump.value + ")");
});

await check("a refused save older than a confirmed save does not open the sheet", async () => {
  const client = boot();
  const day = "2026-10-21";
  await loadDay(client, day, "saved line", 100);
  const dump = client.doc.getElementById("dump");
  dump.value = "older line";
  client.sandbox.scheduleSave();
  const saving = client.sandbox.saveDay();
  await tick();
  const autosave = take(client.requests, (r) => r.method === "PUT" && r.url.includes(day) && !(r.opts && r.opts.keepalive));
  assert(autosave, "the autosave never started");
  assert(JSON.parse(autosave.opts.body).markdown === "older line", "the autosave was not the older text");
  dump.value = "newer line";
  client.sandbox.scheduleSave();
  client.sandbox.flushOnLeave();
  const hide = take(client.requests, (r) => r.method === "PUT" && r.opts && r.opts.keepalive === true);
  assert(hide, "the hide did not send a save");
  assert(JSON.parse(hide.opts.body).markdown === "newer line", "the hide save was not the newer text");
  hide.resolve(jsonRes(200, { ok: true, date: day, mtime: 180 }));
  await tick();
  autosave.resolve(jsonRes(409, {
    error: "disk newer",
    date: day,
    markdown: "newer line",
    mtime: 180,
  }));
  await saving;
  await tick();
  const sheet = client.doc.getElementById("conflict-sheet");
  assert(sheet.hidden === true, "the refused older save opened the conflict sheet");
  assert(client.doc.getElementById("conflict-mine").textContent !== "older line", "the sheet offered the older text as mine");
  assert(dump.value === "newer line", "the refused save replaced the newer text (" + dump.value + ")");
  assert(
    !client.storage.keys().some((k) => {
      if (k.indexOf("log/" + day + ".md") < 0) return false;
      return JSON.parse(client.storage.getItem(k)).markdown === "older line";
    }),
    "the refused older save was stored",
  );
  await loadDay(client, day, "newer line", 180);
  assert(sheet.hidden === true, "the next open offered the older text");
  assert(dump.value === "newer line", "the next open did not keep the confirmed text (" + dump.value + ")");
});

const failed = results.filter((r) => !r.ok);
console.log("");
if (failed.length) {
  console.log(failed.length + " failed, " + (results.length - failed.length) + " passed");
  process.exit(1);
}
console.log("keep-text-test ok  (" + results.length + " passed)");
