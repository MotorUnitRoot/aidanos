#!/usr/bin/env node
/**
 * AidanOS — local-only. Binds 127.0.0.1 only.
 * Vault: AIDANOS_VAULT, or sibling vault/ beside this server.
 * On the Mac the vault is the parent (~/Grok/motorunit).
 * Never copy this folder's vault/ over that one.
 */
import http from "node:http";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VAULT = path.resolve(process.env.AIDANOS_VAULT || path.join(__dirname, "vault"));
const PUBLIC = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const HOST = "127.0.0.1";
const DAY_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;
const MTIME_SKEW_MS = 1;
const lastSelfWrites = new Map();
const pendingSelfWrites = new Set();
const sseClients = new Set();

function mondayOf(d) {
  const x = new Date(d + "T12:00:00");
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return isoDate(x);
}

function isoDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function todayIso() {
  return isoDate(new Date());
}

function isIsoDate(value) {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function addDays(iso, n) {
  const x = new Date(iso + "T12:00:00");
  x.setDate(x.getDate() + n);
  return isoDate(x);
}

async function readFileSafe(p) {
  try {
    return await fs.readFile(p, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function parseFrontmatter(raw) {
  const meta = {};
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) {
      const fm = raw.slice(4, end);
      body = raw.slice(end + 5);
      for (const line of fm.split("\n")) {
        const m = line.match(/^([a-zA-Z0-9_]+):\s*(.*)$/);
        if (!m) continue;
        let v = m[2].trim();
        if (
          (v.startsWith('"') && v.endsWith('"')) ||
          (v.startsWith("'") && v.endsWith("'"))
        ) {
          v = v.slice(1, -1);
        }
        if (v === "true") v = true;
        else if (v === "false") v = false;
        meta[m[1]] = v;
      }
    }
  }
  return { meta, body };
}

function parseTaskLine(line) {
  const m = String(line || "").match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
  if (!m) return null;
  return { done: m[1].toLowerCase() === "x", text: m[2].trim() };
}

function parseCheckboxes(text) {
  if (!text || !text.trim()) return [];
  const items = [];
  for (const line of text.split("\n")) {
    const item = parseTaskLine(line);
    if (item) items.push(item);
  }
  return items;
}

function headingIndex(lines, name) {
  const want = `## ${name}`;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === want) return i;
  }
  return -1;
}

function nextHeadingIndex(lines, from) {
  for (let i = from; i < lines.length; i++) {
    if (/^## /.test(lines[i])) return i;
  }
  return lines.length;
}

function getSection(body, name) {
  const lines = (body || "").split("\n");
  const start = headingIndex(lines, name);
  if (start === -1) return "";
  const end = nextHeadingIndex(lines, start + 1);
  return lines.slice(start + 1, end).join("\n").replace(/\s+$/, "");
}

function parseWeekMarkdown(raw, weekStart) {
  const days = [];
  const lines = raw.split("\n");
  let inTable = false;
  for (const line of lines) {
    if (line.startsWith("| date ")) {
      inTable = true;
      continue;
    }
    if (inTable && line.startsWith("|---")) continue;
    if (inTable && line.startsWith("|")) {
      const cells = line
        .split("|")
        .map((c) => c.trim())
        .filter((_, i, a) => i > 0 && i < a.length - 1);
      if (cells.length >= 4 && cells[0] !== "date") {
        days.push({
          date: cells[0],
          role: cells[1] || "",
          energy: (cells[2] || "green").toLowerCase(),
          mission_eve: String(cells[3]).toLowerCase() === "true",
          summary: cells[4] || "",
        });
      }
      continue;
    }
    if (inTable && !line.startsWith("|")) inTable = false;
  }
  if (days.length < 7) {
    const byDate = Object.fromEntries(days.map((d) => [d.date, d]));
    const filled = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(weekStart, i);
      filled.push(
        byDate[d] || {
          date: d,
          role: "",
          energy: "",
          mission_eve: false,
          summary: "",
        }
      );
    }
    return filled;
  }
  return days.slice(0, 7);
}

function parseBullets(text) {
  if (!text || !text.trim()) return [];
  return text
    .split("\n")
    .map((line) => line.replace(/^- /, "").trim())
    .filter(Boolean);
}

function parsePlan(raw) {
  if (!raw) {
    return { title: "", subtitle: "", why: "", steps: [], parked: [] };
  }
  const { meta, body } = parseFrontmatter(raw);
  const h1 = (body.match(/^#\s+(.+)$/m) || [])[1];
  return {
    title: meta.title || h1 || "",
    subtitle: meta.subtitle || "",
    why: getSection(body, "Why").trim(),
    steps: parseCheckboxes(getSection(body, "Next steps")),
    parked: parseBullets(getSection(body, "Waiting")),
  };
}

function safeJoin(root, rel) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(rel || "").split("?")[0]);
  } catch {
    throw new Error("bad path");
  }
  const cleaned = decoded.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!cleaned || cleaned.includes("\0")) {
    throw new Error("bad path");
  }
  const parts = cleaned.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) {
    throw new Error("path escapes vault");
  }
  const resolved = path.resolve(root, ...parts);
  const rootResolved = path.resolve(root);
  if (
    resolved !== rootResolved &&
    !resolved.startsWith(rootResolved + path.sep)
  ) {
    throw new Error("path escapes vault");
  }
  return resolved;
}

async function listMdTree(dir, vaultRoot) {
  const out = [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    if (e.name.endsWith(".tmp")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...(await listMdTree(p, vaultRoot)));
    } else if (e.isFile() && e.name.endsWith(".md")) {
      out.push(path.relative(vaultRoot, p).split(path.sep).join("/"));
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function dayMarkdownFromBody(body) {
  if (typeof body === "string") return body;
  if (!body || typeof body !== "object") return "";
  if (typeof body.markdown === "string") return body.markdown;
  return "";
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

function json(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(data);
}

async function fileMtimeMs(p) {
  try {
    const st = await fs.stat(p);
    return Math.trunc(st.mtimeMs);
  } catch (e) {
    if (e.code === "ENOENT") return 0;
    throw e;
  }
}

function isSelfWrite(date, diskMtime) {
  if (pendingSelfWrites.has(date)) return true;
  const own = lastSelfWrites.get(date);
  if (own == null) return false;
  return diskMtime <= own + MTIME_SKEW_MS;
}

async function atomicWriteFile(filePath, markdown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp`;
  try {
    await fs.writeFile(tmpPath, markdown, "utf8");
    await fs.rename(tmpPath, filePath);
  } catch (e) {
    try { await fs.unlink(tmpPath); } catch {}
    throw e;
  }
}

function atomicWriteDay(logPath, markdown) {
  return atomicWriteFile(logPath, markdown);
}

function kernelRel(rel) {
  const top = String(rel || "").replace(/\\/g, "/").replace(/^\/+/, "").split("/")[0].toLowerCase();
  return top === "log" || top === "tasks" || top === "aidanos";
}

function sendDayWatch(date, mtime) {
  const payload = `data: ${JSON.stringify({ date, mtime })}\n\n`;
  for (const client of sseClients) {
    try { client.write(payload); } catch {}
  }
}

function startLogWatch() {
  const logDir = path.join(VAULT, "log");
  try {
    fsSync.mkdirSync(logDir, { recursive: true });
  } catch {}
  try {
    const watcher = fsSync.watch(logDir, { persistent: true, recursive: false }, (_eventType, filename) => {
      if (!filename) return;
      const name = path.basename(String(filename));
      if (name.endsWith(".tmp")) return;
      if (!DAY_FILE_RE.test(name)) return;
      const date = name.slice(0, 10);
      const logPath = path.join(logDir, name);
      fsSync.stat(logPath, (err, st) => {
        if (err || !st) return;
        const mtime = Math.trunc(st.mtimeMs);
        if (isSelfWrite(date, mtime)) return;
        sendDayWatch(date, mtime);
      });
    });
    watcher.on("error", (err) => {
      console.error("log watch", err);
    });
  } catch (err) {
    console.error("log watch", err);
  }
}

function sendFile(res, filePath, contentType) {
  return fs.readFile(filePath).then(
    async (buf) => {
      if (String(contentType).includes("text/html")) {
        try {
          const st = await fs.stat(path.join(PUBLIC, "app.js"));
          const v = Math.trunc(st.mtimeMs);
          buf = Buffer.from(
            String(buf).replace(/src="\/app\.js[^"]*"/, 'src="/app.js?v=' + v + '&b=door"'),
            "utf8"
          );
        } catch {}
      }
      res.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      res.end(buf);
    },
    () => {
      res.writeHead(404);
      res.end("Not found");
    }
  );
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${HOST}:${PORT}`);
    const { pathname } = url;

    if (pathname === "/api/health") {
      return json(res, 200, { ok: true, vault: VAULT });
    }

    if (pathname === "/api/week" && req.method === "GET") {
      let start = url.searchParams.get("start");
      if (!start) start = mondayOf(todayIso());
      else if (!isIsoDate(start)) {
        return json(res, 400, { error: "start must be YYYY-MM-DD" });
      }
      const weekPath = path.join(VAULT, "aidanos", "weeks", `${start}.md`);
      let raw = await readFileSafe(weekPath);
      if (!raw) {
        const days = [];
        for (let i = 0; i < 7; i++) {
          const d = addDays(start, i);
          days.push({
            date: d,
            role: "",
            energy: "",
            mission_eve: false,
            summary: "",
          });
        }
        return json(res, 200, { week_start: start, days, exists: false });
      }
      const days = parseWeekMarkdown(raw, start);
      for (const d of days) {
        const logRaw = await readFileSafe(path.join(VAULT, "log", `${d.date}.md`));
        if (logRaw) {
          const items = parseCheckboxes(logRaw);
          d.rx_total = items.length;
          d.rx_done = items.filter((p) => p.done).length;
          d.task_open = items.filter((t) => !t.done).length;
        } else {
          d.rx_total = 0;
          d.rx_done = 0;
          d.task_open = 0;
        }
      }
      return json(res, 200, { week_start: start, days, exists: true });
    }

    if (pathname === "/api/day" && req.method === "GET") {
      const date = url.searchParams.get("date");
      if (!date) return json(res, 400, { error: "date required" });
      if (!isIsoDate(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
      const logPath = path.join(VAULT, "log", `${date}.md`);
      const raw = await readFileSafe(logPath);
      const markdown = raw == null ? "" : raw;
      const mtime = raw == null ? 0 : await fileMtimeMs(logPath);
      return json(res, 200, { date, markdown, mtime });
    }

    if (pathname === "/api/month" && req.method === "GET") {
      let year;
      let month;
      const dateParam = url.searchParams.get("date");
      if (dateParam) {
        if (!isIsoDate(dateParam)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
        year = Number(dateParam.slice(0, 4));
        month = Number(dateParam.slice(5, 7));
      } else {
        const yearRaw = url.searchParams.get("year");
        const monthRaw = url.searchParams.get("month");
        if (yearRaw == null || monthRaw == null) {
          return json(res, 400, { error: "year and month, or date, required" });
        }
        year = Number(yearRaw);
        month = Number(monthRaw);
        if (!Number.isInteger(year) || year < 1 || year > 9999) {
          return json(res, 400, { error: "year invalid" });
        }
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          return json(res, 400, { error: "month must be 1–12" });
        }
      }
      const prefix = `${year}-${String(month).padStart(2, "0")}-`;
      const logDir = path.join(VAULT, "log");
      let names = [];
      try {
        names = await fs.readdir(logDir);
      } catch (e) {
        if (e.code === "ENOENT") return json(res, 200, { year, month, days: [] });
        throw e;
      }
      const days = [];
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        if (!name.startsWith(prefix)) continue;
        const date = name.slice(0, 10);
        const raw = await readFileSafe(path.join(logDir, name));
        if (raw == null) continue;
        if (!String(raw).trim()) continue;
        days.push(date);
      }
      days.sort((a, b) => a.localeCompare(b));
      return json(res, 200, { year, month, days });
    }

    if (pathname === "/api/day" && req.method === "PUT") {
      const date = url.searchParams.get("date");
      if (!date) return json(res, 400, { error: "date required" });
      if (!isIsoDate(date)) return json(res, 400, { error: "date must be YYYY-MM-DD" });
      const incoming = await readBody(req);
      let body;
      try {
        body = JSON.parse(incoming);
      } catch {
        body = incoming;
      }
      const markdown = dayMarkdownFromBody(body);
      const clientMtime = body && typeof body === "object" && body.mtime != null
        ? Number(body.mtime)
        : NaN;
      const logPath = path.join(VAULT, "log", `${date}.md`);
      let diskMtime = 0;
      let exists = false;
      try {
        const st = await fs.stat(logPath);
        exists = st.isFile();
        diskMtime = Math.trunc(st.mtimeMs);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (
        exists &&
        Number.isFinite(clientMtime) &&
        diskMtime > clientMtime + MTIME_SKEW_MS &&
        !isSelfWrite(date, diskMtime)
      ) {
        const raw = await readFileSafe(logPath);
        return json(res, 409, {
          error: "disk newer",
          date,
          markdown: raw == null ? "" : raw,
          mtime: diskMtime,
        });
      }
      pendingSelfWrites.add(date);
      try {
        await atomicWriteDay(logPath, markdown);
        const mtime = await fileMtimeMs(logPath);
        lastSelfWrites.set(date, mtime);
        return json(res, 200, { ok: true, date, mtime });
      } finally {
        pendingSelfWrites.delete(date);
      }
    }

    if (pathname === "/api/plan" && req.method === "GET") {
      const raw = await readFileSafe(path.join(VAULT, "aidanos", "active-horse.md"));
      return json(res, 200, { plan: parsePlan(raw), exists: Boolean(raw) });
    }

    if (pathname === "/api/open-tasks" && req.method === "GET") {
      const logDir = path.join(VAULT, "log");
      let names = [];
      try {
        names = await fs.readdir(logDir);
      } catch (e) {
        if (e.code === "ENOENT") return json(res, 200, { items: [] });
        throw e;
      }
      const items = [];
      names.sort((a, b) => a.localeCompare(b));
      for (const name of names) {
        if (name.endsWith(".tmp")) continue;
        if (!DAY_FILE_RE.test(name)) continue;
        const date = name.slice(0, 10);
        const raw = await readFileSafe(path.join(logDir, name));
        if (raw == null) continue;
        const lines = raw.split("\n");
        for (let i = 0; i < lines.length; i++) {
          const item = parseTaskLine(lines[i]);
          if (item && !item.done) {
            items.push({ date, line: i, text: item.text });
          }
        }
      }
      return json(res, 200, { items });
    }

    if (pathname === "/api/folders" && req.method === "GET") {
      const entries = await fs.readdir(VAULT, { withFileTypes: true });
      const folders = [];
      for (const e of entries) {
        if (!e.isDirectory() || e.name.startsWith(".")) continue;
        if (e.name === "log" || e.name === "tasks" || e.name === "aidanos") continue;
        folders.push({ name: e.name, path: e.name });
      }
      folders.sort((a, b) => a.name.localeCompare(b.name));
      return json(res, 200, { folders });
    }

    if (pathname === "/api/file" && req.method === "GET") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "path required" });
      let abs;
      try {
        abs = safeJoin(VAULT, rel);
      } catch (e) {
        return json(res, 400, { error: e.message || "bad path" });
      }
      if (!String(rel).replace(/\\/g, "/").endsWith(".md")) {
        return json(res, 400, { error: "markdown only" });
      }
      const raw = await readFileSafe(abs);
      if (raw == null) return json(res, 404, { error: "not found", path: rel });
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
      const mtime = await fileMtimeMs(abs);
      return json(res, 200, { path: relPath, markdown: raw, mtime });
    }

    if (pathname === "/api/file" && req.method === "PUT") {
      const rel = url.searchParams.get("path");
      if (!rel) return json(res, 400, { error: "path required" });
      let abs;
      try {
        abs = safeJoin(VAULT, rel);
      } catch (e) {
        return json(res, 400, { error: e.message || "bad path" });
      }
      const relPath = path.relative(VAULT, abs).split(path.sep).join("/");
      if (!String(relPath).endsWith(".md")) {
        return json(res, 400, { error: "markdown only" });
      }
      if (kernelRel(relPath)) {
        return json(res, 400, { error: "kernel path" });
      }
      const incoming = await readBody(req);
      let body;
      try {
        body = JSON.parse(incoming);
      } catch {
        body = incoming;
      }
      const markdown = dayMarkdownFromBody(body);
      const clientMtime = body && typeof body === "object" && body.mtime != null
        ? Number(body.mtime)
        : NaN;
      let diskMtime = 0;
      let exists = false;
      try {
        const st = await fs.stat(abs);
        if (st.isDirectory()) return json(res, 400, { error: "not a file" });
        exists = st.isFile();
        diskMtime = Math.trunc(st.mtimeMs);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const writeKey = "f:" + relPath;
      if (
        exists &&
        Number.isFinite(clientMtime) &&
        diskMtime > clientMtime + MTIME_SKEW_MS &&
        !isSelfWrite(writeKey, diskMtime)
      ) {
        const raw = await readFileSafe(abs);
        return json(res, 409, {
          error: "disk newer",
          path: relPath,
          markdown: raw == null ? "" : raw,
          mtime: diskMtime,
        });
      }
      pendingSelfWrites.add(writeKey);
      try {
        await atomicWriteFile(abs, markdown);
        const mtime = await fileMtimeMs(abs);
        lastSelfWrites.set(writeKey, mtime);
        return json(res, 200, { ok: true, path: relPath, mtime });
      } finally {
        pendingSelfWrites.delete(writeKey);
      }
    }

    if (pathname === "/api/tree" && req.method === "GET") {
      const dirParam = url.searchParams.get("dir") || ".";
      let abs;
      try {
        abs = dirParam === "." || dirParam === "" ? VAULT : safeJoin(VAULT, dirParam);
      } catch (e) {
        return json(res, 400, { error: e.message || "bad path" });
      }
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch (e) {
        if (e.code === "ENOENT") {
          return json(res, 404, { error: "directory not found", dir: dirParam });
        }
        throw e;
      }
      if (!stat.isDirectory()) {
        return json(res, 400, { error: "not a directory", dir: dirParam });
      }
      const files = await listMdTree(abs, VAULT);
      return json(res, 200, { dir: dirParam, files });
    }

    if (pathname === "/api/search" && req.method === "GET") {
      const q = String(url.searchParams.get("q") || "").trim();
      if (!q) return json(res, 200, { hits: [] });
      const needle = q.toLowerCase();
      const files = await listMdTree(VAULT, VAULT);
      const hits = [];
      const MAX_HITS = 40;
      const MAX_PER_FILE = 3;
      const MAX_BYTES = 1000000;
      for (const rel of files) {
        if (!rel.endsWith(".md") || rel.endsWith(".tmp")) continue;
        const relNorm = String(rel).replace(/\\/g, "/");
        const relBase = relNorm.split("/").pop() || "";
        if (/^TODAY\.md$/i.test(relBase)) continue;
        if (relNorm.startsWith("aidanos/") && relNorm !== "aidanos/active-horse.md") continue;
        let abs;
        try {
          abs = safeJoin(VAULT, rel);
        } catch {
          continue;
        }
        let st;
        try {
          st = await fs.stat(abs);
        } catch {
          continue;
        }
        if (!st.isFile() || st.size > MAX_BYTES) continue;
        const raw = await readFileSafe(abs);
        if (raw == null) continue;
        const lines = raw.split("\n");
        let nThis = 0;
        for (let i = 0; i < lines.length; i++) {
          const text = lines[i].replace(/\r$/, "");
          if (text.toLowerCase().includes(needle)) {
            hits.push({ path: relNorm, line: i, text });
            nThis += 1;
            if (hits.length >= MAX_HITS) return json(res, 200, { hits });
            if (nThis >= MAX_PER_FILE) break;
          }
        }
      }
      return json(res, 200, { hits });
    }

    if (pathname === "/api/day-watch" && req.method === "GET") {
      req.setTimeout(0);
      res.setTimeout(0);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
      });
      res.write(":\n\n");
      sseClients.add(res);
      const drop = () => sseClients.delete(res);
      req.on("close", drop);
      res.on("close", drop);
      return;
    }

    if (pathname === "/api/skin.css" && req.method === "GET") {
      const skinPath = path.join(VAULT, "aidanos", "skin.css");
      const raw = await readFileSafe(skinPath);
      res.writeHead(200, {
        "Content-Type": "text/css; charset=utf-8",
        "Cache-Control": "no-store",
      });
      res.end(raw || "/* no personal skin */\n");
      return;
    }

    let file = pathname === "/" ? "index.html" : pathname;
    let full;
    try {
      full = safeJoin(PUBLIC, file);
    } catch {
      res.writeHead(400);
      return res.end("Bad path");
    }
    const rel = path.relative(path.resolve(PUBLIC), full).split(path.sep).join("/");
    const base = path.basename(full);
    if (
      rel === "vault" ||
      rel.startsWith("vault/") ||
      /^old-/i.test(base) ||
      rel === "launchd" ||
      rel.startsWith("launchd/")
    ) {
      res.writeHead(404);
      return res.end("Not found");
    }
    const ext = path.extname(full);
    const types = {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml",
      ".json": "application/json",
    };
    return sendFile(res, full, types[ext] || "application/octet-stream");
  } catch (err) {
    console.error(err);
    json(res, 500, { error: String(err.message || err) });
  }
});

startLogWatch();
server.listen(PORT, HOST, () => {
  console.log(`AidanOS`);
  console.log(`  vault: ${VAULT}`);
  console.log(`  open:  http://${HOST}:${PORT}`);
});
