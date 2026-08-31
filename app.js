const $ = (id) => document.getElementById(id);

const state = {
  weekStart: null,
  week: null,
  day: null,
  doc: null,
  selectedDate: null,
  saveTimer: null,
  dirty: false,
  monthShown: false,
  monthView: null,
  paintTimer: null,
  askTimer: null,
  askGen: 0,
  openDayGen: 0,
  lastPaperSelection: "",
  activeLine: -1,
  folderDir: "",
  plan: { title: "", why: "", steps: [], parked: [] },
};

const PAGE_VIEWS = ["door", "today", "plan"];
const DOW = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const DOW_FULL = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
function daySlots() {
  const times = [];
  for (let h = 6; h <= 21; h++) {
    const hh = String(h).padStart(2, "0");
    times.push(hh + ":00");
    times.push(hh + ":30");
  }
  times.push("22:00");
  return times;
}
const WHEN_RE = /@(?:\d{4}-\d{2}-\d{2}[ T])?(\d{1,2}:\d{2})\b/;

function mondayOf(d = new Date()) {
  const x = new Date(d);
  x.setHours(12, 0, 0, 0);
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  return iso(x);
}

function iso(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return y + "-" + m + "-" + day;
}

function todayIso() { return iso(new Date()); }

function addDays(isoStr, n) {
  const x = new Date(isoStr + "T12:00:00");
  x.setDate(x.getDate() + n);
  return iso(x);
}

function parseDate(dateStr) {
  return new Date(dateStr + "T12:00:00");
}

function formatPaperTitle(dateStr) {
  return parseDate(dateStr).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatRailDate(dateStr) {
  return parseDate(dateStr).toLocaleDateString("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

function formatCardMonth(dateStr) {
  const d = parseDate(dateStr);
  return d.toLocaleDateString("en-US", { month: "short" }).toUpperCase() +
    " " + d.getFullYear();
}

function energyLabel(d) {
  const role = String(d.role || "").trim();
  if (/^(train|flex|rest)$/i.test(role)) {
    return role.charAt(0).toUpperCase() + role.slice(1).toLowerCase();
  }
  if (role && !/father|builder|writer/i.test(role)) return role;
  const e = String(d.energy || "").toLowerCase();
  if (e === "flex") return "Flex";
  if (e === "rest") return "Rest";
  return "Train";
}

function normalizeTime(hhmm) {
  const parts = String(hhmm || "").split(":");
  if (parts.length < 2) return "";
  return String(parseInt(parts[0], 10)).padStart(2, "0") + ":" +
    String(parseInt(parts[1], 10)).padStart(2, "0");
}

function stripWhen(line) {
  return String(line || "")
    .replace(WHEN_RE, "")
    .replace(/^[-*+]\s*\[[ xX]\]\s*/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTaskLine(line) {
  const m = String(line || "").match(/^\s*- \[([ xX])\]\s*(.*)$/);
  if (!m) return null;
  return { done: m[1].toLowerCase() === "x", text: m[2].trim() };
}

function parseBlocks(text, day) {
  const blocks = [];
  const seen = new Set();
  for (const line of String(text || "").split("\n")) {
    const m = line.match(WHEN_RE);
    if (!m) continue;
    const time = normalizeTime(m[1]);
    const label = stripWhen(line);
    if (!time || !label) continue;
    const key = time + "|" + label;
    if (seen.has(key)) continue;
    seen.add(key);
    blocks.push({ time, text: label, raw: line });
  }
  const stop = day && day.hard_stop ? normalizeTime(day.hard_stop) : "";
  if (stop && !blocks.some((b) => b.time === stop && /hard stop/i.test(b.text))) {
    blocks.push({ time: stop, text: "hard stop", bound: true });
  }
  return blocks;
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function attr(s) {
  return escapeHtml(s).replace(/\n/g, " ");
}

function wikiSpan(name, showMarks) {
  const n = String(name || "");
  const inner = showMarks ? "[[" + escapeHtml(n) + "]]" : escapeHtml(n);
  return '<span class="md-link" data-name="' + attr(n) + '">' + inner + '</span>';
}
function paintWiki(escaped, showMarks) {
  return String(escaped || "").replace(/\[\[([^\]]+)\]\]/g, (_, name) => wikiSpan(name, showMarks));
}
function paintBold(escaped) {
  return String(escaped || "").replace(/\*\*([^*]+)\*\*/g, '<strong class="md-b">$1</strong>');
}
function paintInline(s) {
  return paintWiki(paintBold(escapeHtml(s)
    .replace(/@(\d{1,2}:\d{2})\b/g, '<span class="md-when">@$1</span>')), false);
}

function indentPad(spaces) {
  const n = String(spaces || "").replace(/\t/g, "  ").length;
  return n ? "padding-left:" + (n * 0.55) + "em;" : "";
}

function formatOneLine(line, asSource, hidden) {
  if (asSource) {
    let cls = "md-line is-source";
    if (hidden) cls += " md-front";
    let kind = "p";
    let extra = "";
    let m;
    if ((m = line.match(/^(#{1,6})(\s+)(.*)$/))) {
      cls += " h" + m[1].length;
      kind = "h";
      extra = ' data-level="' + m[1].length + '"';
    } else if ((m = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/))) {
      cls += " task" + (/x/i.test(m[3]) ? " done" : "") + (m[1] ? " nest" : "");
      kind = "task";
      extra = ' data-indent="' + attr(m[1]) + '" data-mark="' + attr(m[2]) + '"';
    } else if ((m = line.match(/^(\s*)([-*+])\s+(.*)$/))) {
      cls += " ul" + (m[1] ? " nest" : "");
      kind = "ul";
      extra = ' data-indent="' + attr(m[1]) + '" data-mark="' + attr(m[2]) + '"';
    } else if ((m = line.match(/^(\s*)(\d+[.)])(\s+)(.*)$/))) {
      cls += " ol" + (m[1] ? " nest" : "");
      kind = "ol";
      extra = ' data-indent="' + attr(m[1]) + '" data-num="' + attr(m[2]) + '"';
    } else if ((m = line.match(/^(\s{2,})(\S.*)$/))) {
      cls += " nest";
      kind = "nest";
      extra = ' data-indent="' + attr(m[1]) + '"';
    } else if (!line) {
      cls += " empty";
      kind = "empty";
    }
    return '<div draggable="true" class="' + cls + '" data-kind="' + kind + '" data-src="' + attr(line) + '"' + extra + ">" +
      (line ? paintWiki(escapeHtml(line), true) : "<br>") + "</div>";
  }
  const front = hidden ? " md-front" : "";
  let m;
  if ((m = line.match(/^(#{1,6})(\s+)(.*)$/))) {
    return '<div draggable="true" class="md-line' + front + ' h' + m[1].length + '" data-kind="h" data-src="' + attr(line) + '" data-level="' +
      m[1].length + '"><span class="md-body">' + paintInline(m[3]) + "</span></div>";
  }
  if ((m = line.match(/^(\s*)([-*+])\s+\[([ xX])\]\s*(.*)$/))) {
    const on = /x/i.test(m[3]);
    const nest = m[1] ? " nest" : "";
    return '<div draggable="true" class="md-line' + front + ' task' + (on ? " done" : "") + nest +
      '" data-kind="task" data-src="' + attr(line) + '" data-indent="' + attr(m[1]) + '" data-mark="' + attr(m[2]) +
      '" style="' + indentPad(m[1]) + '"><span class="md-box" contenteditable="false" role="checkbox" aria-checked="' +
      (on ? "true" : "false") + '"></span><span class="md-body">' +
      paintInline(m[4]) + "</span></div>";
  }
  if ((m = line.match(/^(\s*)([-*+])\s+(.*)$/))) {
    const nest = m[1] ? " nest" : "";
    return '<div draggable="true" class="md-line' + front + ' ul' + nest + '" data-kind="ul" data-src="' + attr(line) + '" data-indent="' + attr(m[1]) +
      '" data-mark="' + attr(m[2]) + '" style="' + indentPad(m[1]) +
      '"><span class="md-bul" aria-hidden="true"></span><span class="md-body">' + paintInline(m[3]) + "</span></div>";
  }
  if ((m = line.match(/^(\s*)(\d+[.)])(\s+)(.*)$/))) {
    const nest = m[1] ? " nest" : "";
    return '<div draggable="true" class="md-line' + front + ' ol' + nest + '" data-kind="ol" data-src="' + attr(line) + '" data-indent="' + attr(m[1]) +
      '" data-num="' + attr(m[2]) + '" style="' + indentPad(m[1]) +
      '"><span class="md-num">' + escapeHtml(m[2]) + '</span><span class="md-body">' +
      paintInline(m[4]) + "</span></div>";
  }
  if ((m = line.match(/^(\s{2,})(\S.*)$/))) {
    return '<div draggable="true" class="md-line' + front + ' nest" data-kind="nest" data-src="' + attr(line) + '" data-indent="' + attr(m[1]) +
      '" style="' + indentPad(m[1]) + '"><span class="md-body">' + paintInline(m[2]) +
      "</span></div>";
  }
  if (!line) return '<div draggable="true" class="md-line' + front + ' empty" data-kind="empty" data-src=""><br></div>';
  return '<div draggable="true" class="md-line' + front + '" data-kind="p" data-src="' + attr(line) + '"><span class="md-body">' + paintInline(line) + "</span></div>";
}

function frontmatterLineCount(md) {
  const lines = String(md ?? "").split("\n");
  if (lines[0] !== "---") return 0;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i] === "---") return i + 1;
  }
  return 0;
}

function formatPaper(md, activeIndex) {
  const text = String(md ?? "");
  if (!text && (activeIndex == null || activeIndex < 0)) return "";
  const lines = text.split("\n");
  const hide = frontmatterLineCount(text);
  return lines.map((line, i) => formatOneLine(line, i === activeIndex, i < hide)).join("");
}

function stripAccidentalBulletSpace(line) {
  return String(line ?? "").replace(/^ ([-*+])/, "$1");
}

function continueLinePrefix(line) {
  const s = String(line || "");
  const task = s.match(/^(\s*)([-*+])\s+\[[ xX]\]\s*/);
  if (task) return task[1] + task[2] + " [ ] ";
  const ul = s.match(/^(\s*)([-*+])\s+/);
  if (ul) return ul[1] + ul[2] + " ";
  return "";
}

function splitDumpLine(text, off) {
  const s = String(text ?? "");
  const n = off == null ? s.length : Math.max(0, Math.min(s.length, off));
  if (n <= 0) return { left: "", right: s, caret: 0 };
  const left = s.slice(0, n);
  const rest = s.slice(n);
  const prefix = continueLinePrefix(s);
  if (!prefix) return { left, right: rest, caret: 0 };
  return { left, right: prefix + rest, caret: prefix.length };
}

function indentDumpLine(line) {
  return "  " + String(line ?? "");
}

function outdentDumpLine(line) {
  const s = String(line ?? "");
  if (s.charAt(0) === "\t") return s.slice(1);
  if (s.startsWith("  ")) return s.slice(2);
  return s;
}

function emptyListPrefix(line) {
  const s = String(line ?? "");
  const task = s.match(/^(\s*[-*+]\s+\[[ xX]\]\s*)$/);
  if (task) return task[1];
  const ul = s.match(/^(\s*[-*+]\s+)$/);
  if (ul) return ul[1];
  const ol = s.match(/^(\s*\d+[.)]\s+)$/);
  if (ol) return ol[1];
  return "";
}

function lineBody(n) {
  const body = n.querySelector(".md-body");
  const src = body || n;
  const raw = (src.innerText != null && String(src.innerText) !== "" ? src.innerText : (src.textContent || ""));
  return stripAccidentalBulletSpace(String(raw).replace(/\n/g, "").replace(/\u00a0/g, " "));
}

function serializeLine(n) {
  if (n.classList && n.classList.contains("is-source")) return stripAccidentalBulletSpace(lineBody(n));
  const kind = n.dataset.kind;
  const src = n.getAttribute("data-src");
  if (src != null && src !== "") {
    if (kind === "task") {
      const on = n.classList.contains("done");
      const was = /\[[xX]\]/.test(src);
      if (on === was) return src;
      return on ? src.replace(/\[ \]/, "[x]") : src.replace(/\[[xX]\]/, "[ ]");
    }
    return src;
  }
  const body = lineBody(n);
  if (kind === "h") {
    if (/^#{1,6}\s/.test(body)) return body;
    if (!String(body || "").trim()) return "";
    const level = parseInt(n.dataset.level || "1", 10);
    return "#".repeat(Math.max(1, Math.min(6, level))) + " " + body;
  }
  if (kind === "task") {
    if (/^\s*[-*+]\s+\[[ xX]\]/.test(body)) return body;
    const done = n.classList.contains("done");
    const mark = n.dataset.mark || "-";
    return (n.dataset.indent || "") + mark + " [" + (done ? "x" : " ") + "] " + body;
  }
  if (kind === "ul") {
    if (/^\s*[-*+]\s+/.test(body)) return body;
    return (n.dataset.indent || "") + (n.dataset.mark || "-") + " " + body;
  }
  if (kind === "ol") {
    if (/^\s*\d+[.)]\s/.test(body)) return body;
    return (n.dataset.indent || "") + (n.dataset.num || "1.") + " " + body;
  }
  if (kind === "nest") {
    return (n.dataset.indent || "  ") + body;
  }
  if (kind === "empty") return "";
  return body;
}

function readPaper() {
  const dump = $("dump");
  return dump ? dump.value : "";
}

function caretOffset(root) {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return 0;
  const r = sel.getRangeAt(0);
  const pre = document.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(r.startContainer, r.startOffset);
  return pre.toString().length;
}

function placeCaret(root, offset) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n, count = 0;
  const sel = window.getSelection();
  while ((n = walker.nextNode())) {
    const len = n.nodeValue.length;
    if (count + len >= offset) {
      const range = document.createRange();
      range.setStart(n, Math.max(0, offset - count));
      range.collapse(true);
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    count += len;
  }
  const range = document.createRange();
  range.selectNodeContents(root);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}

let painting = false;
let keepPaperFocus = false;
let keepPaperFocusGen = 0;
const paperHistory = makePaperHistory();
let paperCaret = { line: 0, caret: 0 };
function paperLines() {
  const paper = $("paper");
  return paper ? [...paper.querySelectorAll(".md-line")] : [];
}

function lineIndexOfCaret() {
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return -1;
  const node = sel.anchorNode;
  if (!node) return -1;
  const el = node.nodeType === 1 ? node : node.parentElement;
  const line = el && el.closest ? el.closest(".md-line") : null;
  if (!line) return -1;
  return paperLines().indexOf(line);
}

function lineMarkdown(el) {
  if (!el) return "";
  const dump = $("dump");
  const idx = paperLines().indexOf(el);
  const dumpLine = (dump && idx >= 0) ? dump.value.split("\n")[idx] : null;
  if (el.classList && el.classList.contains("is-source")) {
    const raw = (el.innerText != null ? el.innerText : (el.textContent || ""));
    return stripAccidentalBulletSpace(String(raw).replace(/\n/g, "").replace(/\u00a0/g, " "));
  }
  if (dumpLine != null) {
    if (el.dataset && el.dataset.kind === "task" && /^\s*[-*+]\s+\[[ xX]\]/.test(dumpLine)) {
      const on = el.classList.contains("done");
      const was = /\[[xX]\]/.test(dumpLine);
      if (on !== was) {
        return on ? dumpLine.replace(/\[ \]/, "[x]") : dumpLine.replace(/\[[xX]\]/, "[ ]");
      }
    }
    return dumpLine;
  }
  const src = el.getAttribute && el.getAttribute("data-src");
  if (src != null && src !== "") return src;
  return dumpLine == null ? "" : dumpLine;
}

function writeDumpLine(idx, text) {
  if (applyingHistory) return $("dump");
  const dump = $("dump");
  if (!dump || idx == null || idx < 0) return dump;
  const lines = dump.value.split("\n");
  while (lines.length <= idx) lines.push("");
  lines[idx] = stripAccidentalBulletSpace(text);
  dump.value = lines.join("\n");
  if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
  return dump;
}

function flushActiveLineToDump() {
  const idx = state.activeLine >= 0 ? state.activeLine : lineIndexOfCaret();
  const el = paperLines()[idx];
  if (idx < 0 || !el) return $("dump");
  return writeDumpLine(idx, lineMarkdown(el));
}

function syncDumpFromPaper() {
  const dump = $("dump");
  if (!dump) return dump;
  let idx = lineIndexOfCaret();
  if (idx < 0) idx = state.activeLine;
  if (idx < 0) return dump;
  const el = paperLines()[idx];
  if (!el) return dump;
  const lines = dump.value.split("\n");
  while (lines.length <= idx) lines.push("");
  if (el.classList && el.classList.contains("is-source")) {
    lines[idx] = stripAccidentalBulletSpace((el.innerText || "").replace(/\n/g, "").replace(/\u00a0/g, " "));
  } else if (el.dataset && el.dataset.kind === "task" && /^\s*[-*+]\s+\[[ xX]\]/.test(lines[idx] || "")) {
    const on = el.classList.contains("done");
    const was = /\[[xX]\]/.test(lines[idx]);
    if (on !== was) {
      lines[idx] = on ? lines[idx].replace(/\[ \]/, "[x]") : lines[idx].replace(/\[[xX]\]/, "[ ]");
    }
  }
  dump.value = lines.join("\n");
  if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
  return dump;
}

function paintPaper() {
  const paper = $("paper");
  const dump = $("dump");
  if (!paper || !dump) return;
  painting = true;
  paper.innerHTML = formatPaper(dump.value);
  paper.classList.toggle("is-empty", !String(dump.value || "").trim());
  state.activeLine = -1;
  painting = false;
}

function paintPaperAt(activeIndex, caretInLine) {
  const paper = $("paper");
  const dump = $("dump");
  if (!paper || !dump) return;
  keepPaperFocus = true;
  const gen = ++keepPaperFocusGen;
  painting = true;
  paper.innerHTML = formatPaper(dump.value, activeIndex);
  paper.classList.toggle("is-empty", !String(dump.value || "").trim());
  state.activeLine = activeIndex;
  paper.focus();
  const el = paperLines()[activeIndex];
  if (el) {
    const md = serializeLine(el);
    const pos = caretInLine == null ? md.length : Math.max(0, Math.min(md.length, caretInLine));
    placeCaret(el, pos);
    rememberPaperCaret(activeIndex, pos);
  }
  painting = false;
  setTimeout(() => { if (gen === keepPaperFocusGen) keepPaperFocus = false; }, 0);
}

function activateLine(idx, caretInVisible) {
  if (idx == null || idx < 0) return;
  const paper = $("paper");
  if (!paper) return;
  painting = true;
  try {
    const lines = paperLines();
    if (state.activeLine >= 0 && state.activeLine !== idx) {
      const prev = lines[state.activeLine];
      if (prev && prev.classList.contains("is-source")) {
        writeDumpLine(state.activeLine, lineMarkdown(prev));
        const md = ($("dump").value.split("\n")[state.activeLine]) ?? lineMarkdown(prev);
        const tmp = document.createElement("div");
        tmp.innerHTML = formatOneLine(md, false, state.activeLine < frontmatterLineCount($("dump") ? $("dump").value : ""));
        if (tmp.firstElementChild) prev.replaceWith(tmp.firstElementChild);
      }
    }
    const fresh = paperLines();
    const el = fresh[idx];
    if (!el) { state.activeLine = -1; return; }
    if (!el.classList.contains("is-source")) {
      const body = lineBody(el);
      const dumpLines = $("dump") ? $("dump").value.split("\n") : [];
      const md = dumpLines[idx] != null ? dumpLines[idx] : (el.getAttribute("data-src") || "");
      let prefix = 0;
      if (body && md.indexOf(body) >= 0) prefix = md.indexOf(body);
      const tmp = document.createElement("div");
      tmp.innerHTML = formatOneLine(md, true, idx < frontmatterLineCount($("dump") ? $("dump").value : ""));
      const next = tmp.firstElementChild;
      if (next) {
        el.replaceWith(next);
        const pos = caretInVisible == null ? md.length : Math.max(0, Math.min(md.length, prefix + caretInVisible));
        placeCaret(next, pos);
      }
    }
    state.activeLine = idx;
  } finally {
    painting = false;
  }
}

function revealActiveLine() {
  if (applyingHistory || painting || keepPaperFocus) return;
  const paper = $("paper");
  if (!paper) return;
  const sel = window.getSelection();
  if (!sel || !sel.rangeCount) return;
  if (!paper.contains(sel.anchorNode) && sel.anchorNode !== paper) return;
  if (!sel.isCollapsed) return;
  const idx = lineIndexOfCaret();
  if (idx < 0) {
    if (!paperLines().length && document.activeElement === paper) {
      painting = true;
      paper.innerHTML = formatOneLine("", true);
      state.activeLine = 0;
      placeCaret(paperLines()[0], 0);
      painting = false;
    }
    return;
  }
  const el = paperLines()[idx];
  if (idx === state.activeLine && el && el.classList.contains("is-source")) return;
  let visible = 0;
  try { visible = caretOffset(el); } catch (e) {}
  activateLine(idx, visible);
}

function paperFocused() {
  const a = document.activeElement;
  return a && (a.id === "paper" || a.id === "dump" || (a.closest && a.closest("#paper")));
}

function setStatus(msg, kind = "") {
  const el = $("status");
  if (!el) return;
  el.textContent = msg || "\u00a0";
  el.className = "status" + (kind ? " " + kind : "");
}

async function api(path, opts = {}) {
  const rest = { ...opts };
  delete rest.timeoutMs;
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    ...rest,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

function dayMarkdown(day) {
  if (!day) return "";
  if (typeof day.paper === "string") return day.paper;
  if (typeof day.markdown === "string") return day.markdown;
  if (typeof day.raw === "string") return day.raw;
  return "";
}

function isNoteDoc() {
  return !!(state.doc && state.doc.kind === "note");
}

function notePaperTitle(doc) {
  const rel = String((doc && doc.path) || "").replace(/\\/g, "/");
  return wikiNoteTitle(rel);
}

async function leaveCurrentPaper() {
  flushActiveLineToDump();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  await saveDay();
}

async function loadWeek(start) {
  state.weekStart = start;
  state.week = await api("/api/week?start=" + start);
  const want = state.selectedDate || todayIso();
  const inWeek = state.week.days.some((d) => d.date === want);
  if (inWeek) await openDay(want, { silent: true });
  else await openDay(state.week.days[0].date, { silent: true });
}

function renderWeek() {
  const daysEl = $("days");
  if (!daysEl || !state.week) return;
  daysEl.innerHTML = "";
  const today = todayIso();
  state.week.days.forEach((d, i) => {
    const btn = document.createElement("button");
    btn.type = "button";
    const classes = ["day-card"];
    if (d.date === today) classes.push("is-today");
    if (d.date === state.selectedDate) classes.push("selected");
    btn.className = classes.join(" ");
    btn.setAttribute("role", "listitem");
    btn.setAttribute("aria-pressed", d.date === state.selectedDate ? "true" : "false");
    btn.innerHTML =
      "<span class=\"dow\">" + DOW_FULL[i] + "</span>" +
      "<span class=\"dom\">" + d.date.slice(8) + "</span>" +
      "<span class=\"moy\">" + escapeHtml(formatCardMonth(d.date)) + "</span>";
    btn.addEventListener("click", () => openDay(d.date));
    daysEl.appendChild(btn);
  });
}

function putRawDay(date, markdown, mtime) {
  return fetch("/api/day?date=" + date, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ date, paper: markdown, markdown, mtime: Number(mtime) || 0 }),
  });
}

async function openDay(date, { silent = false } = {}) {
  const gen = ++state.openDayGen;
  flushActiveLineToDump();
  const dump = $("dump");
  const oldDate = state.day && state.day.date;
  const oldMd = dump ? dump.value : (state.day ? dayMarkdown(state.day) : "");
  const oldMtime = state.day ? state.day.mtime : 0;
  const leavingDay = !isNoteDoc() && oldDate && oldDate !== date;
  if (isNoteDoc()) leaveCurrentPaper().catch(() => {});
  try {
    const day = await api("/api/day?date=" + date);
    if (gen !== state.openDayGen) return;
    state.doc = null;
    state.day = {
      date: day.date || date,
      markdown: dayMarkdown(day),
      mtime: Number(day.mtime) || 0,
    };
    state.selectedDate = date;
    resetPaperHistory(paperHistory);
    try { sessionStorage.setItem("aidanos-date", date); } catch (e) {}
    renderDay();
    if (!silent) setStatus("");
    const weekStart = mondayOf(parseDate(date));
    if (!state.week || state.weekStart !== weekStart) {
      state.weekStart = weekStart;
      const days = [];
      for (let i = 0; i < 7; i++) days.push({ date: addDays(weekStart, i) });
      state.week = { week_start: weekStart, days: days, exists: false };
      renderWeek();
      api("/api/week?start=" + weekStart).then((week) => {
        if (gen !== state.openDayGen) return;
        state.week = week;
        renderWeek();
      }).catch(() => {});
    } else {
      renderWeek();
    }
    if (state.monthShown) {
      const viewed = parseDate(date);
      state.monthView = { year: viewed.getFullYear(), month: viewed.getMonth() + 1 };
    }
    await renderMonth();
    if (leavingDay) putRawDay(oldDate, oldMd, oldMtime).catch(() => {});
  } catch (e) {
    if (gen !== state.openDayGen) return;
    if (!silent) setStatus(String(e.message || e), "error");
  }
}

function renderDay() {
  const d = state.day;
  if (!d) return;
  document.body.classList.remove("doc-note");
  $("paper-title").textContent = formatPaperTitle(d.date);
  $("rail-date").textContent = formatRailDate(d.date);
  const dump = $("dump");
  dump.value = dayMarkdown(d).split("\n").map(stripAccidentalBulletSpace).join("\n");
  paintPaper();
  renderRail();
}

function renderRail() {
  const root = $("timeline");
  if (!root) return;
  if (!state.day || isNoteDoc()) {
    root.innerHTML = "";
    return;
  }
  const blocks = parseBlocks($("dump").value, state.day);
  root.innerHTML = "";
  const byTime = {};
  for (const b of blocks) {
    (byTime[b.time] || (byTime[b.time] = [])).push(b);
  }
  const times = daySlots().slice();
  for (const extra of Object.keys(byTime)) {
    if (!times.includes(extra)) times.push(extra);
  }
  times.sort();
  for (const time of times) {
    const slot = document.createElement("div");
    slot.className = "slot" + (time.endsWith(":30") ? " half" : "");
    slot.dataset.time = time;
    const label = time.endsWith(":00") ? time : "";
    const lane = document.createElement("div");
    lane.className = "slot-lane";
    for (const b of (byTime[time] || [])) {
      const block = document.createElement("div");
      block.className = "block" + (b.bound ? " bound" : "");
      block.textContent = b.text;
      if (!b.bound) {
        block.draggable = false;
        block.dataset.raw = b.raw || b.text;
        block.addEventListener("pointerdown", (e) => {
          if (e.button) return;
          e.stopPropagation();
          if (e.cancelable) e.preventDefault();
          try { block.setPointerCapture(e.pointerId); } catch (err) {}
          slotDrag.armed = true;
          slotDrag.active = false;
          slotDrag.text = block.dataset.raw;
          slotDrag.x = e.clientX;
          slotDrag.y = e.clientY;
          slotDrag.slot = null;
        });
        block.addEventListener("dragstart", (e) => {
          e.preventDefault();
        });
      }
      lane.appendChild(block);
    }
    slot.innerHTML = "<span class=\"slot-time\">" + escapeHtml(label) + "</span>";
    slot.appendChild(lane);
    slot.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
      slot.classList.add("drop");
    });
    slot.addEventListener("dragleave", () => slot.classList.remove("drop"));
    slot.addEventListener("drop", (e) => {
      e.preventDefault();
      slot.classList.remove("drop");
      const text = (slotDrag.text || (e.dataTransfer && e.dataTransfer.getData("text/plain")) || "").trim();
      if (text) applyWhen(text, time);
    });
    root.appendChild(slot);
  }
}

function applyWhenToMarkdown(md, raw, hhmm) {
  const time = normalizeTime(hhmm);
  if (!time) return md;
  const rawLine = String(raw || "").split("\n")[0];
  const needle = stripWhen(rawLine);
  const lines = String(md || "").split("\n");
  let idx = -1;
  if (rawLine) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] === rawLine) { idx = i; break; }
    }
  }
  if (idx < 0 && needle) {
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].trim()) continue;
      if (stripWhen(lines[i]) === needle) { idx = i; break; }
    }
  }
  if (idx < 0) {
    if (!needle) return md;
    lines.push("- [ ] " + needle + " @" + time);
    return lines.join("\n");
  }
  const line = lines[idx];
  if (WHEN_RE.test(line)) lines[idx] = line.replace(WHEN_RE, "@" + time);
  else lines[idx] = line.replace(/\s+$/, "") + " @" + time;
  return lines.join("\n");
}

function applyWhen(raw, hhmm) {
  if (!state.day) return;
  const dump = $("dump");
  if (!dump) return;
  if (!String(dump.value || "").trim()) return;
  const before = dump.value;
  const beforeLines = before.split("\n");
  const rawLine = String(raw || "").split("\n")[0];
  const needle = stripWhen(rawLine);
  let line = (slotDrag && slotDrag.line >= 0 && beforeLines[slotDrag.line] === rawLine) ? slotDrag.line : -1;
  if (line < 0 && rawLine) {
    for (let i = 0; i < beforeLines.length; i++) {
      if (beforeLines[i] === rawLine) { line = i; break; }
    }
  }
  if (line < 0 && needle) {
    for (let i = 0; i < beforeLines.length; i++) {
      if (!beforeLines[i].trim()) continue;
      if (stripWhen(beforeLines[i]) === needle) { line = i; break; }
    }
  }
  if (line < 0) line = beforeLines.length;
  const cur = currentPaperSnap();
  pushPaperHistory(paperHistory, paperSnap(before, line, cur.caret), { kind: "when" });
  applyingDragSave = true;
  dump.value = applyWhenToMarkdown(dump.value, raw, hhmm);
  if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
  state.dirty = true;
  const afterLines = dump.value.split("\n");
  if (line < 0 || line >= afterLines.length) line = Math.max(0, afterLines.length - 1);
  paintPaperAt(line, afterLines[line] != null ? afterLines[line].length : 0);
  renderRail();
  restorePaperFocus(line, afterLines[line] != null ? afterLines[line].length : 0);
  saveDay().then(() => { applyingDragSave = false; }).catch(() => { applyingDragSave = false; });
}

function makePaperHistory() {
  return { past: [], future: [], coalesce: { kind: "", line: -1, at: 0 } };
}

let applyingHistory = false;
let applyingDragSave = false;

function paperSnap(markdown, line, caret) {
  return {
    markdown: String(markdown ?? ""),
    line: line == null || line < 0 ? 0 : line | 0,
    caret: caret == null || caret < 0 ? 0 : caret | 0,
  };
}

function resetPaperHistory(hist) {
  if (!hist) return hist;
  hist.past = [];
  hist.future = [];
  hist.coalesce = { kind: "", line: -1, at: 0 };
  return hist;
}

const PAPER_HISTORY_MAX = 200;
const PAPER_HISTORY_IDLE = 400;

function pushPaperHistory(hist, snap, opts) {
  if (!hist) return false;
  if (applyingHistory) return false;
  opts = opts || {};
  const now = opts.now != null ? opts.now : Date.now();
  const kind = String(opts.kind || "");
  const idleMs = opts.idleMs != null ? opts.idleMs : PAPER_HISTORY_IDLE;
  const s = paperSnap(snap && snap.markdown, snap && snap.line, snap && snap.caret);
  if (hist.past.length && hist.past[hist.past.length - 1].markdown === s.markdown) {
    return false;
  }
  if (
    opts.coalesce &&
    kind === "type" &&
    hist.coalesce &&
    hist.coalesce.kind === "type" &&
    hist.coalesce.line === s.line &&
    now - hist.coalesce.at <= idleMs &&
    hist.past.length
  ) {
    hist.coalesce.at = now;
    hist.future = [];
    return false;
  }
  hist.past.push(s);
  if (hist.past.length > PAPER_HISTORY_MAX) {
    hist.past.splice(0, hist.past.length - PAPER_HISTORY_MAX);
  }
  hist.future = [];
  hist.coalesce = { kind: kind, line: s.line, at: now };
  return true;
}

function undoPaperHistory(hist, current) {
  if (!hist || !hist.past.length) return null;
  const cur = paperSnap(current && current.markdown, current && current.line, current && current.caret);
  while (hist.past.length && hist.past[hist.past.length - 1].markdown === cur.markdown) {
    hist.past.pop();
  }
  if (!hist.past.length) {
    hist.coalesce = { kind: "", line: -1, at: 0 };
    return null;
  }
  const prev = hist.past.pop();
  hist.future.push(cur);
  hist.coalesce = { kind: "", line: -1, at: 0 };
  return prev;
}

function redoPaperHistory(hist, current) {
  if (!hist || !hist.future.length) return null;
  const cur = paperSnap(current && current.markdown, current && current.line, current && current.caret);
  while (hist.future.length && hist.future[hist.future.length - 1].markdown === cur.markdown) {
    hist.future.pop();
  }
  if (!hist.future.length) {
    hist.coalesce = { kind: "", line: -1, at: 0 };
    return null;
  }
  const next = hist.future.pop();
  hist.past.push(cur);
  hist.coalesce = { kind: "", line: -1, at: 0 };
  return next;
}

function paperUndoKey(e) {
  if (!e || e.altKey) return "";
  if (!(e.metaKey || e.ctrlKey)) return "";
  const k = e.key;
  if (k === "z" || k === "Z") return e.shiftKey ? "redo" : "undo";
  if ((k === "y" || k === "Y") && !e.shiftKey) return "redo";
  return "";
}

function rememberPaperCaret(line, caret) {
  const s = paperSnap("", line, caret);
  paperCaret = { line: s.line, caret: s.caret };
  return paperCaret;
}

function currentPaperSnap() {
  const dump = $("dump");
  let line = state.activeLine >= 0 ? state.activeLine : lineIndexOfCaret();
  let caret = paperCaret.caret;
  const el = line >= 0 ? paperLines()[line] : null;
  if (el) {
    try { caret = caretOffset(el); } catch (err) {}
  } else if (line < 0) {
    line = paperCaret.line;
  }
  return paperSnap(dump ? dump.value : "", line, caret);
}

function paperHistoryFocusTarget() {
  return "paper";
}

function restorePaperFocus(line, caret) {
  function go() {
    if (slotDrag && slotDrag.active) return;
    const paper = $(paperHistoryFocusTarget());
    if (!paper) return;
    paper.focus();
    const idx = line == null || line < 0
      ? (state.activeLine >= 0 ? state.activeLine : paperCaret.line)
      : line;
    const el = paperLines()[idx];
    if (el) {
      const md = serializeLine(el);
      const pos = caret == null ? md.length : Math.max(0, Math.min(md.length, caret));
      placeCaret(el, pos);
      rememberPaperCaret(idx, pos);
    }
  }
  go();
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
  setTimeout(go, 0);
}

function applyPaperHistorySnap(snap) {
  const dump = $("dump");
  if (!dump || !snap) return;
  applyingHistory = true;
  dump.value = snap.markdown;
  if (state.day) {
    state.day.paper = dump.value;
    state.day.markdown = dump.value;
  }
  rememberPaperCaret(snap.line, snap.caret);
  paintPaperAt(snap.line, snap.caret);
  renderRail();
  restorePaperFocus(snap.line, snap.caret);
  const paper = $("paper");
  const ae = document.activeElement;
  if (ae && paper && ae !== paper && ae.closest && ae.closest(".timeline, .today-rail, .slot-lane, .block, .slot")) {
    restorePaperFocus(snap.line, snap.caret);
  }
  scheduleSave();
  let left = 2;
  const release = () => {
    left -= 1;
    if (left <= 0) applyingHistory = false;
  };
  if (typeof requestAnimationFrame === "function") {
    requestAnimationFrame(() => { setTimeout(release, 0); });
  } else {
    setTimeout(release, 0);
  }
  setTimeout(release, 0);
}

function handlePaperUndoKey(e) {
  if (!e) return false;
  const action = paperUndoKey(e);
  if (!action) return false;
  if (e._paperUndoHandled) return true;
  if (askOpen()) return false;
  const active = document.activeElement;
  const tag = active && active.tagName;
  if ((tag === "INPUT" || tag === "TEXTAREA") && active.id !== "dump") return false;
  const dump = $("dump");
  if (!dump) return false;
  const current = currentPaperSnap();
  const snap = action === "redo"
    ? redoPaperHistory(paperHistory, current)
    : undoPaperHistory(paperHistory, current);
  if (!snap) return false;
  e._paperUndoHandled = true;
  e.preventDefault();
  if (typeof e.stopPropagation === "function") e.stopPropagation();
  applyPaperHistorySnap(snap);
  restorePaperFocus(snap.line, snap.caret);
  return true;
}

let monthRenderSeq = 0;

function shiftMonth(delta) {
  if (!state.monthView) {
    const selected = state.selectedDate || todayIso();
    const d = parseDate(selected);
    state.monthView = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  let year = state.monthView.year;
  let month = state.monthView.month + Number(delta || 0);
  while (month < 1) {
    month += 12;
    year -= 1;
  }
  while (month > 12) {
    month -= 12;
    year += 1;
  }
  state.monthView = { year, month };
  renderMonth();
}

async function renderMonth() {
  const grid = $("month-grid");
  if (!grid) return;
  if (!state.monthShown) {
    grid.classList.add("hidden");
    grid.setAttribute("hidden", "");
    grid.innerHTML = "";
    return;
  }
  grid.classList.remove("hidden");
  grid.removeAttribute("hidden");
  if (!state.monthView) {
    const selected = state.selectedDate || todayIso();
    const d = parseDate(selected);
    state.monthView = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  const year = state.monthView.year;
  const monthIndex = state.monthView.month - 1;
  const first = new Date(year, monthIndex, 1, 12);
  const startPad = (first.getDay() + 6) % 7;
  const lastDate = new Date(year, monthIndex + 1, 0, 12).getDate();
  const today = todayIso();
  const selected = state.selectedDate || today;
  const label = first.toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const seq = ++monthRenderSeq;
  let noted = [];
  try {
    const data = await api("/api/month?year=" + year + "&month=" + state.monthView.month);
    if (data && Array.isArray(data.days)) noted = data.days;
  } catch (e) {
    noted = [];
  }
  if (seq !== monthRenderSeq || !state.monthShown) return;
  if (!state.monthView || state.monthView.year !== year || state.monthView.month !== monthIndex + 1) return;
  const notedSet = new Set(noted);
  let html = "<p class=\"month-label\">";
  html += "<button type=\"button\" class=\"month-shift\" data-delta=\"-1\" aria-label=\"Previous month\">&#8249;</button>";
  html += "<span class=\"month-name\">" + escapeHtml(label) + "</span>";
  html += "<button type=\"button\" class=\"month-shift\" data-delta=\"1\" aria-label=\"Next month\">&#8250;</button>";
  html += "</p>";
  html += "<div class=\"month-dows\">" + DOW.map((x) => "<span>" + x + "</span>").join("") + "</div>";
  html += "<div class=\"month-cells\">";
  for (let i = 0; i < startPad; i++) html += "<span class=\"month-cell empty\"></span>";
  for (let day = 1; day <= lastDate; day++) {
    const date = iso(new Date(year, monthIndex, day, 12));
    const cls = ["month-cell"];
    if (date === today) cls.push("is-today");
    if (date === selected) cls.push("selected");
    if (notedSet.has(date)) cls.push("has-note");
    html += "<button type=\"button\" class=\"" + cls.join(" ") + "\" data-date=\"" + date + "\">" + day + "</button>";
  }
  html += "</div>";
  grid.innerHTML = html;
  grid.querySelectorAll("button[data-date]").forEach((btn) => {
    btn.addEventListener("click", () => openDay(btn.dataset.date));
  });
  grid.querySelectorAll("button.month-shift").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      shiftMonth(Number(btn.dataset.delta));
    });
  });
}

function scheduleSave() {
  if (applyingDragSave) return;
  state.dirty = true;
  setStatus("Saving");
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveDay, 350);
}

function applyRemoteDay(day) {
  if (!day) return;
  if (isNoteDoc()) return;
  const date = day.date || (state.day && state.day.date);
  if (state.selectedDate && date && date !== state.selectedDate) return;
  const markdown = typeof day.markdown === "string" ? day.markdown : dayMarkdown(day);
  const dump = $("dump");
  const cleaned = String(markdown || "").split("\n").map(stripAccidentalBulletSpace).join("\n");
  if (dump) dump.value = cleaned;
  if (state.day && (!date || state.day.date === date)) {
    state.day.markdown = cleaned;
    state.day.paper = cleaned;
    state.day.mtime = Number(day.mtime) || 0;
  } else {
    state.day = {
      date: date,
      markdown: cleaned,
      paper: cleaned,
      mtime: Number(day.mtime) || 0,
    };
  }
  state.dirty = false;
  resetPaperHistory(paperHistory);
  paintPaper();
  renderRail();
}

let dayWatch = null;
function stopDayWatch() {
  if (!dayWatch) return;
  try { dayWatch.close(); } catch (e) {}
  dayWatch = null;
}
function startDayWatch() {
  if (typeof EventSource !== "function") return;
  if (dayWatch && dayWatch.readyState !== 2) return;
  stopDayWatch();
  try {
    dayWatch = new EventSource("/api/day-watch");
    dayWatch.onmessage = (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); } catch (e) { return; }
      onDayFileChanged(payload);
    };
  } catch (e) {}
}
async function onDayFileChanged(payload) {
  if (isNoteDoc()) return;
  const date = payload && payload.date;
  const mtime = Number(payload && payload.mtime) || 0;
  if (!date || date !== state.selectedDate) return;
  const seen = Number(state.day && state.day.mtime) || 0;
  if (!(mtime > seen)) return;
  if (applyingHistory) return;
  if (applyingDragSave || state.dirty) return;
  try {
    const day = await api("/api/day?date=" + date);
    if (date !== state.selectedDate) return;
    if (applyingHistory) return;
    if (applyingDragSave || state.dirty) return;
    applyRemoteDay(day);
  } catch (e) {}
}

function flushOnLeave() {
  flushActiveLineToDump();
  clearTimeout(state.saveTimer);
  state.saveTimer = null;
  if (!state.day && !isNoteDoc()) return;
  saveDay({ keepalive: true });
}

function applyRemoteNote(body) {
  if (!isNoteDoc()) return;
  const path = body && body.path ? String(body.path).replace(/\\/g, "/") : state.doc.path;
  if (path && state.doc.path && path !== state.doc.path) return;
  const markdown = typeof (body && body.markdown) === "string" ? body.markdown : "";
  const cleaned = String(markdown || "").split("\n").map(stripAccidentalBulletSpace).join("\n");
  const dump = $("dump");
  if (dump) dump.value = cleaned;
  state.doc.markdown = cleaned;
  if (path) state.doc.path = path;
  state.doc.mtime = Number(body && body.mtime) || 0;
  state.dirty = false;
  resetPaperHistory(paperHistory);
  paintPaper();
}

let saveChain = Promise.resolve();
async function saveDay({ keepalive = false } = {}) {
  const run = async () => {
    if (isNoteDoc()) {
      const doc = state.doc;
      if (!doc) {
        setStatus("");
        return;
      }
      const path = doc.path;
      const dump = $("dump");
      const markdown = dump ? dump.value : String(doc.markdown || "");
      doc.markdown = markdown;
      const mtime = Number(doc.mtime) || 0;
      try {
        const res = await fetch("/api/file?path=" + encodeURIComponent(path), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, paper: markdown, markdown, mtime }),
          keepalive: !!keepalive,
        });
        if (res.status === 409) {
          const body = await res.json().catch(() => ({}));
          applyRemoteNote(body);
          setStatus("");
          return;
        }
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || res.statusText);
        }
        const out = await res.json().catch(() => ({}));
        if (isNoteDoc() && state.doc.path === path) {
          if (out && out.mtime != null) state.doc.mtime = Number(out.mtime) || 0;
          if (dump && dump.value === markdown) state.dirty = false;
        }
        if (keepalive) return;
        setStatus("Saved", "saved");
        setTimeout(() => { if ($("status").textContent === "Saved") setStatus(""); }, 1500);
      } catch (e) {
        if (!keepalive) setStatus(String(e.message), "error");
      }
      return;
    }
    if (!state.day && !isNoteDoc()) { setStatus(""); return; }
    if (!state.day) {
      setStatus("");
      return;
    }
    const date = state.day.date;
    const dump = $("dump");
    const markdown = dump ? dump.value : dayMarkdown(state.day);
    state.day.markdown = markdown;
    const mtime = Number(state.day.mtime) || 0;
    try {
      let res = await fetch("/api/day?date=" + date, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, paper: markdown, markdown, mtime }),
        keepalive: !!keepalive,
      });
      if (res.status === 409) {
        const body = await res.json().catch(() => ({}));
        if (applyingDragSave) {
          const retry = await fetch("/api/day?date=" + date, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date,
              paper: dump ? dump.value : markdown,
              markdown: dump ? dump.value : markdown,
              mtime: Number(body.mtime) || 0,
            }),
            keepalive: !!keepalive,
          });
          if (retry.ok) {
            res = retry;
          } else {
            applyRemoteDay({
              date: body.date || date,
              markdown: typeof body.markdown === "string" ? body.markdown : "",
              mtime: Number(body.mtime) || 0,
            });
            setStatus("");
            return;
          }
        } else {
          applyRemoteDay({
            date: body.date || date,
            markdown: typeof body.markdown === "string" ? body.markdown : "",
            mtime: Number(body.mtime) || 0,
          });
          setStatus("");
          return;
        }
      }
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || res.statusText);
      }
      const out = await res.json().catch(() => ({}));
      if (state.day && state.day.date === date) {
        if (out && out.mtime != null) state.day.mtime = Number(out.mtime) || 0;
        state.dirty = false;
      }
      if (keepalive) return;
      setStatus("Saved", "saved");
      if (state.weekStart) {
        api("/api/week?start=" + state.weekStart).then((week) => {
          state.week = week;
          renderWeek();
        }).catch(() => {});
      }
      setTimeout(() => { if ($("status").textContent === "Saved") setStatus(""); }, 1500);
    } catch (e) {
      if (!keepalive) setStatus(String(e.message), "error");
    }
  };
  saveChain = saveChain.then(run, run);
  return saveChain;
}

function currentView() {
  let h = (location.hash || "").replace(/^#/, "");
  if (h === "day") return "today";
  if (h === "plan") return "plan";
  if (h === "today") return "today";
  return "door";
}

function showView(view) {
  if (!PAGE_VIEWS.includes(view)) view = "door";
  document.body.className = "day-page view-" + view + (isNoteDoc() ? " doc-note" : "");
  PAGE_VIEWS.forEach((v) => {
    const el = $("view-" + v);
    if (!el) return;
    if (v === view) el.removeAttribute("hidden");
    else el.setAttribute("hidden", "");
  });
  document.title = view === "door" ? "AidanOS" : view === "today" ? "Today · AidanOS" : "Plan · AidanOS";
  if (view === "plan") {
    renderPlan();
    setStatus("");
  }
  if (view === "today") {
    startDayWatch();
    if (!state.selectedDate) openDay(todayIso());
  } else stopDayWatch();
  if (view === "door") {
    const input = $("door-input");
    if (input) setTimeout(() => input.focus(), 0);
  }
}

function route() {
  showView(currentView());
}

function planScreenTitle(h) {
  const raw = String((h && h.title) || "").trim();
  if (!raw || /\bhorse\b/i.test(raw)) return "Plan";
  return raw;
}

function renderPlan() {
  const h = state.plan || {};
  if ($("plan-title")) $("plan-title").textContent = planScreenTitle(h);
  if ($("plan-why")) $("plan-why").textContent = h.why || "";
  const ol = $("plan-steps");
  if (ol) {
    ol.innerHTML = "";
    (h.steps || []).forEach((step) => {
      const li = document.createElement("li");
      li.textContent = typeof step === "string" ? step : (step.text || "");
      if (step && step.done) li.classList.add("done");
      ol.appendChild(li);
    });
  }
  const ul = $("plan-parked");
  if (ul) {
    ul.innerHTML = "";
    (h.parked || []).forEach((item) => {
      const li = document.createElement("li");
      li.textContent = typeof item === "string" ? item : (item.text || "");
      ul.appendChild(li);
    });
  }
}

async function loadPlan() {
  try {
    const data = await api("/api/plan");
    if (data.plan) state.plan = data.plan;
    if (currentView() === "plan") renderPlan();
  } catch (e) {}
}

function openAsk() {
  const modal = $("ask-modal");
  modal.classList.remove("hidden");
  modal.removeAttribute("hidden");
  $("ask-q").value = "";
  $("ask-hits").innerHTML = "";
  state.folderDir = "";
  $("ask-q").focus();
  runAsk("");
}

function closeAsk() {
  const modal = $("ask-modal");
  modal.classList.add("hidden");
  modal.setAttribute("hidden", "");
  state.folderDir = "";
}

function askKicker(hits, label) {
  const li = document.createElement("li");
  li.className = "ask-kicker";
  li.textContent = label;
  hits.appendChild(li);
}

function askFileName(path) {
  const p = String(path || "").replace(/\\/g, "/");
  const base = (p.split("/").filter(Boolean).pop() || "");
  const stem = base.replace(/\.md$/i, "");
  if (/^TODAY$/i.test(stem)) return "";
  const day = p.match(/^log\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (day) return day[1];
  if (p === "aidanos/active-horse.md") return "Plan";
  if (/\.md$/i.test(base)) return stem;
  return stem || "note";
}
function askSnippet(text) {
  return String(text || "")
    .replace(/^\s+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^- \[[ xX]\]\s*/, "")
    .replace(/^[-*+]\s+\[[ xX]\]\s*/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
}
function vaultHitLabel(h) {
  const name = askFileName(h && h.path);
  if (!name) return "";
  const snippet = askSnippet(h && h.text);
  return snippet ? name + " · " + snippet : name;
}
function askHiddenPath(path) {
  const base = String(path || "").replace(/\\/g, "/").split("/").pop() || "";
  return /^TODAY\.md$/i.test(base);
}

function flashPaperLine(line) {
  const dump = $("dump");
  if (!dump) return;
  const n = dump.value.split("\n").length;
  const idx = Math.max(0, Math.min(n - 1, Number(line) || 0));
  paintPaperAt(idx, 0);
  const el = paperLines()[idx];
  if (el) {
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    el.classList.add("is-flash");
    setTimeout(() => el.classList.remove("is-flash"), 900);
  }
}

async function openTaskHit(date, line) {
  closeAsk();
  await openDay(date);
  flashPaperLine(line);
}

function renderNote() {
  const doc = state.doc;
  if (!doc || doc.kind !== "note") return;
  document.body.classList.add("doc-note");
  const title = notePaperTitle(doc);
  if ($("paper-title")) $("paper-title").textContent = title;
  if ($("rail-date")) $("rail-date").textContent = title;
  const dump = $("dump");
  const md = String(doc.markdown || "").split("\n").map(stripAccidentalBulletSpace).join("\n");
  if (dump) dump.value = md;
  paintPaper();
  renderRail();
}

async function openVaultNote(rel) {
  const path = String(rel || "").replace(/\\/g, "/");
  const day = path.match(/^log\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (day) {
    closeAsk();
    await openDay(day[1]);
    return;
  }
  closeAsk();
  if (currentView() !== "today") {
    if (location.hash !== "#today") location.hash = "today";
    else showView("today");
  }
  setStatus("Loading");
  const same = isNoteDoc() && state.doc.path === path;
  if (!same) await leaveCurrentPaper();
  const data = await api("/api/file?path=" + encodeURIComponent(path));
  state.day = null;
  state.doc = {
    kind: "note",
    path: String(data.path || path).replace(/\\/g, "/"),
    markdown: typeof data.markdown === "string" ? data.markdown : "",
    mtime: Number(data.mtime) || 0,
  };
  resetPaperHistory(paperHistory);
  renderNote();
  renderWeek();
  setStatus("");
}

async function openVaultSearchHit(rel, line) {
  const path = String(rel || "").replace(/\\/g, "/");
  const day = path.match(/^log\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (day) {
    await openTaskHit(day[1], line);
    return;
  }
  closeAsk();
  await openVaultNote(path);
  flashPaperLine(line);
}

function openVaultPath(rel) {
  const path = String(rel || "").replace(/\\/g, "/");
  const day = path.match(/^log\/(\d{4}-\d{2}-\d{2})\.md$/);
  if (day) {
    closeAsk();
    openDay(day[1]);
    return;
  }
  if (path === "aidanos/active-horse.md") {
    closeAsk();
    location.hash = "plan";
    return;
  }
  openVaultNote(path);
}

function applyLandedDay(date, markdown, mtime) {
  if (!state.day || state.day.date !== date || isNoteDoc()) return;
  const dump = $("dump");
  if (dump) dump.value = markdown;
  state.day.paper = markdown;
  state.day.markdown = markdown;
  if (mtime != null) state.day.mtime = Number(mtime) || 0;
  state.dirty = false;
  paintPaper();
  renderRail();
}

async function landMapNextSteps(paths) {
  const maps = workMapPathsFromHits((paths || []).map((p) => ({ path: p })));
  if (!maps.length) return false;
  const mapMarkdowns = [];
  for (const rel of maps) {
    try {
      const data = await api("/api/file?path=" + encodeURIComponent(rel));
      mapMarkdowns.push(typeof data.markdown === "string" ? data.markdown : "");
    } catch (e) {}
  }
  if (!mapMarkdowns.length) return false;
  const date = todayIso();
  const viewing = !!(state.day && state.day.date === date && !isNoteDoc());
  let existing = "";
  let mtime = 0;
  if (viewing) {
    flushActiveLineToDump();
    const dump = $("dump");
    existing = dump ? dump.value : dayMarkdown(state.day);
    mtime = Number(state.day.mtime) || 0;
  } else {
    const body = await api("/api/day?date=" + date);
    existing = typeof body.markdown === "string" ? body.markdown : "";
    mtime = Number(body.mtime) || 0;
  }
  const next = landedDayMarkdown(existing, mapMarkdowns);
  if (next === existing) return false;
  let res = await fetch("/api/day?date=" + date, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    cache: "no-store",
    body: JSON.stringify({ date, paper: next, markdown: next, mtime }),
  });
  let written = next;
  if (res.status === 409) {
    const body = await res.json().catch(() => ({}));
    written = landedDayMarkdown(typeof body.markdown === "string" ? body.markdown : "", mapMarkdowns);
    res = await fetch("/api/day?date=" + date, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({
        date,
        paper: written,
        markdown: written,
        mtime: Number(body.mtime) || 0,
      }),
    });
  }
  if (!res.ok) return false;
  const out = await res.json().catch(() => ({}));
  if (viewing) applyLandedDay(date, written, out && out.mtime);
  return true;
}

async function runAsk(q) {
  const gen = ++state.askGen;
  const hits = $("ask-hits");
  hits.innerHTML = "";
  const needle = String(q || "").trim().toLowerCase();

  const add = (row) => {
    const li = document.createElement("li");
    if (row.kind === "kicker") {
      li.className = "ask-kicker";
      li.textContent = row.text;
      hits.appendChild(li);
      return;
    }
    const a = document.createElement("button");
    a.type = "button";
    a.className = "text-link";
    a.textContent = row.text;
    if (row.kind === "day") {
      a.addEventListener("click", () => { closeAsk(); openDay(row.date); });
    } else if (row.kind === "task") {
      a.addEventListener("click", () => openTaskHit(row.date, row.line));
    } else if (row.kind === "plan") {
      a.addEventListener("click", () => { closeAsk(); location.hash = "plan"; });
    } else if (row.kind === "folder") {
      a.addEventListener("click", () => {
        state.folderDir = row.path;
        $("ask-q").value = "";
        runAsk("");
      });
    } else if (row.kind === "folder-up") {
      a.addEventListener("click", () => {
        state.folderDir = "";
        runAsk($("ask-q").value);
      });
    } else if (row.kind === "file") {
      a.addEventListener("click", () => openVaultPath(row.path));
    } else if (row.kind === "vault") {
      a.addEventListener("click", () => openVaultSearchHit(row.path, row.line));
    } else if (row.kind === "paper") {
      a.addEventListener("click", () => {
        closeAsk();
        flashPaperLine(row.line);
      });
    } else {
      li.textContent = row.text;
      hits.appendChild(li);
      return;
    }
    li.appendChild(a);
    hits.appendChild(li);
  };

  if (state.folderDir) {
    add({ kind: "kicker", text: state.folderDir });
    add({ kind: "folder-up", text: "Back" });
    try {
      const data = await api("/api/tree?dir=" + encodeURIComponent(state.folderDir));
      if (gen !== state.askGen) return;
      for (const file of data.files || []) {
        if (askHiddenPath(file)) continue;
        if (needle && !file.toLowerCase().includes(needle)) continue;
        const name = askFileName(file);
        if (!name) continue;
        add({ kind: "file", text: name, path: file });
      }
    } catch (e) {}
    if (gen !== state.askGen) return;
    if (!hits.querySelector("button")) {
      const li = document.createElement("li");
      li.textContent = "Nothing here.";
      hits.appendChild(li);
    }
    return;
  }

  if (needle) {
    const paperName = isNoteDoc() ? askFileName(state.doc.path) : askFileName("log/" + (state.selectedDate || todayIso()) + ".md");
    const dumpLines = ($("dump").value || "").split("\n");
    for (let i = 0; i < dumpLines.length; i++) {
      const line = dumpLines[i];
      if (!line.toLowerCase().includes(needle) || !paperName) continue;
      const snippet = askSnippet(line);
      add({ kind: "paper", text: snippet ? paperName + " · " + snippet : paperName, line: i });
    }
    if (state.week) {
      for (const d of state.week.days) {
        const label = formatPaperTitle(d.date);
        if (label.toLowerCase().includes(needle) || d.date.includes(needle)) {
          add({ kind: "day", text: label, date: d.date });
        }
      }
    }
    const planTitle = (state.plan && state.plan.title) || "Plan";
    if (planTitle.toLowerCase().includes(needle) || needle === "plan") {
      add({ kind: "plan", text: "Plan · " + planTitle });
    }
    try {
      const data = await api("/api/search?q=" + encodeURIComponent(String(q || "").trim()));
      if (gen !== state.askGen) return;
      const vaultHits = data.hits || [];
      const openPath = isNoteDoc()
        ? String(state.doc.path || "").replace(/\\/g, "/")
        : ("log/" + (state.selectedDate || todayIso()) + ".md");
      const visible = [];
      for (const h of vaultHits) {
        const p = String(h.path || "").replace(/\\/g, "/");
        if (p === openPath) continue;
        if (askHiddenPath(h.path) || !vaultHitLabel(h)) continue;
        visible.push(h);
      }
      if (visible.length) {
        add({ kind: "kicker", text: "Vault" });
        visible.forEach((h) => {
          add({ kind: "vault", text: vaultHitLabel(h), path: h.path, line: h.line });
        });
      }
      const mapPaths = workMapPathsFromHits(vaultHits);
      if (mapPaths.length) {
        try {
          await landMapNextSteps(mapPaths);
        } catch (e) {}
        if (gen !== state.askGen) return;
      }
    } catch (e) {
      if (gen !== state.askGen) return;
      const li = document.createElement("li");
      li.className = "ask-miss";
      const msg = e && e.message ? String(e.message).slice(0, 80) : "";
      li.textContent = msg ? "Couldn't search. " + msg : "Couldn't search.";
      hits.appendChild(li);
      console.error(e);
    }
    if (gen !== state.askGen) return;
  }

  try {
    const data = await api("/api/open-tasks");
    if (gen !== state.askGen) return;
    const tasks = data.items || [];
    const shown = needle
      ? tasks.filter((t) => (t.text || "").toLowerCase().includes(needle) || String(t.date).includes(needle))
      : tasks;
    if (shown.length) {
      add({ kind: "kicker", text: "Open" });
      shown.slice(0, 16).forEach((t) => {
        add({ kind: "task", text: t.date + " · " + t.text, date: t.date, line: t.line });
      });
    }
  } catch (e) {}

  const wantFolders = !needle || needle === "folder" || needle === "folders" || needle === "vault" || needle.length < 12;
  if (wantFolders) {
    try {
      const data = await api("/api/folders");
      if (gen !== state.askGen) return;
      const KERNEL = { log: 1, tasks: 1, aidanos: 1 };
      let folders = (data.folders || []).filter((f) => !KERNEL[(f.name || f.path || "").split("/")[0]]);
      if (needle && needle !== "folder" && needle !== "folders" && needle !== "vault") {
        folders = folders.filter((f) => f.name.toLowerCase().includes(needle));
      }
      if (folders.length) {
        add({ kind: "kicker", text: "Folders" });
        folders.forEach((f) => add({ kind: "folder", text: f.path, path: f.path }));
      }
    } catch (e) {}
  }

  if (gen !== state.askGen) return;
  if (!hits.querySelector("button") && !hits.querySelector(".ask-miss")) {
    const li = document.createElement("li");
    li.textContent = needle ? "Nothing here." : "Nothing open.";
    hits.appendChild(li);
  }
}


$("prev-week").addEventListener("click", () => loadWeek(addDays(state.weekStart, -7)));
$("next-week").addEventListener("click", () => loadWeek(addDays(state.weekStart, 7)));

function shiftDay(n) {
  flushActiveLineToDump();
  const from = state.selectedDate || todayIso();
  openDay(addDays(from, n));
}

$("prev-day").addEventListener("click", () => shiftDay(-1));
$("next-day").addEventListener("click", () => shiftDay(1));

function syncPaperFromEdit(e) {
  if (applyingHistory || painting || slotDrag.active) return;
  if (applyingDragSave) return;
  if (e && e.isComposing) {
    flushActiveLineToDump();
    scheduleSave();
    return;
  }
  const idx = state.activeLine >= 0 ? state.activeLine : lineIndexOfCaret();
  const el = paperLines()[idx];
  let caret = 0;
  if (el) {
    try { caret = caretOffset(el); } catch (err) {}
  }
  const dump = $("dump");
  if (!dump) return;
  pushPaperHistory(paperHistory, {
    markdown: dump.value,
    line: idx >= 0 ? idx : paperCaret.line,
    caret: paperCaret.caret,
  }, { kind: "type", coalesce: true });
  if (idx >= 0 && el) writeDumpLine(idx, lineMarkdown(el));
  scheduleSave();
  renderRail();
  if (idx >= 0) paintPaperAt(idx, caret);
}

$("paper").addEventListener("input", syncPaperFromEdit);
$("paper").addEventListener("focus", () => {
  if (!paperLines().length) {
    painting = true;
    $("paper").innerHTML = formatOneLine("", true);
    $("paper").classList.remove("is-empty");
    state.activeLine = 0;
    placeCaret(paperLines()[0], 0);
    painting = false;
    return;
  }
  revealActiveLine();
});
$("paper").addEventListener("blur", () => {
  if (keepPaperFocus || applyingHistory) {
    const paper = $("paper");
    if (paper) paper.focus();
    return;
  }
  if (painting || slotDrag.armed || slotDrag.active) return;
  flushActiveLineToDump();
  paintPaper();
  if (state.dirty) saveDay();
});
$("paper").addEventListener("beforeinput", (e) => {
  if (painting || slotDrag.active) return;
  if (e.isComposing) return;
  const idx = state.activeLine >= 0 ? state.activeLine : lineIndexOfCaret();
  const el = paperLines()[idx];
  if (idx >= 0 && el) {
    try { rememberPaperCaret(idx, caretOffset(el)); } catch (err) {}
  }
});
$("paper").addEventListener("keydown", handlePaperUndoKey, true);
$("paper").addEventListener("keydown", (e) => {
  if (e.isComposing || e.keyCode === 229) return;
  if (handlePaperUndoKey(e)) return;
  const idxNow = lineIndexOfCaret();
  const elNow = paperLines()[idxNow];
  if (idxNow >= 0 && elNow) {
    try { rememberPaperCaret(idxNow, caretOffset(elNow)); } catch (err) {}
  }
  if (e.key === "Tab") {
    e.preventDefault();
    const idx = lineIndexOfCaret();
    const el = paperLines()[idx];
    const off = el ? caretOffset(el) : 0;
    if (idx < 0 || !el) return;
    writeDumpLine(idx, lineMarkdown(el));
    const dump = $("dump");
    const lines = dump.value.split("\n");
    const text = lines[idx] != null ? lines[idx] : "";
    const next = e.shiftKey ? outdentDumpLine(text) : indentDumpLine(text);
    if (next === text) return;
    pushPaperHistory(paperHistory, { markdown: dump.value, line: idx, caret: off }, { kind: e.shiftKey ? "outdent" : "indent" });
    writeDumpLine(idx, next);
    const caret = Math.max(0, off + (next.length - text.length));
    scheduleSave();
    paintPaperAt(idx, caret);
    return;
  }
  if (e.key === "Enter") {
    e.preventDefault();
    // Enter path cannot call paintPaper() (all-rendered) synchronously from
    // this keydown handler. innerHTML in paintPaperAt blurs #paper; keepPaperFocus
    // holds until focus + caret are restored on the new source line.
    const idx = lineIndexOfCaret();
    const el = paperLines()[idx];
    const off = el ? caretOffset(el) : 0;
    if (idx >= 0 && el) writeDumpLine(idx, lineMarkdown(el));
    const dump = $("dump");
    const lines = dump.value.split("\n");
    if (idx < 0) {
      pushPaperHistory(paperHistory, { markdown: dump.value, line: 0, caret: 0 }, { kind: "enter" });
      dump.value = dump.value ? dump.value + "\n" : "";
      if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
      scheduleSave();
      paintPaperAt(dump.value.split("\n").length - 1, 0);
      renderRail();
      return;
    }
    pushPaperHistory(paperHistory, { markdown: dump.value, line: idx, caret: off }, { kind: "enter" });
    const text = lines[idx] != null ? lines[idx] : lineMarkdown(el);
    if (emptyListPrefix(text)) {
      writeDumpLine(idx, "");
      scheduleSave();
      paintPaperAt(idx, 0);
      renderRail();
      return;
    }
    const split = splitDumpLine(text, off);
    lines.splice(idx, 1, split.left, split.right);
    dump.value = lines.join("\n");
    if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
    scheduleSave();
    paintPaperAt(idx + 1, split.caret);
    renderRail();
    return;
  }
  if (e.key === "Backspace" && !e.altKey && !e.metaKey && !e.ctrlKey) {
    const idx = lineIndexOfCaret();
    const el = paperLines()[idx];
    if (idx > 0 && el && caretOffset(el) === 0) {
      e.preventDefault();
      if (el) writeDumpLine(idx, lineMarkdown(el));
      const dump = $("dump");
      pushPaperHistory(paperHistory, { markdown: dump.value, line: idx, caret: 0 }, { kind: "backspace" });
      const lines = dump.value.split("\n");
      const prevLen = lines[idx - 1].length;
      lines[idx - 1] += lines[idx];
      lines.splice(idx, 1);
      dump.value = lines.join("\n");
      if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
      scheduleSave();
      paintPaperAt(idx - 1, prevLen);
      renderRail();
    }
  }
});
function wikiCreatePath(name) {
  let n = String(name || "").trim().replace(/\\/g, "/");
  n = n.replace(/\.md$/i, "").replace(/^\/+/, "");
  if (!n) return "";
  const KERNEL = { log: 1, tasks: 1, aidanos: 1 };
  if (n.includes("/")) {
    const parts = n.split("/").filter((p) => p && p !== ".");
    if (!parts.length || parts.some((p) => p === "..")) return "";
    if (KERNEL[parts[0].toLowerCase()]) return "";
    return parts.join("/") + ".md";
  }
  if (n === ".." || n === "." || n.includes("\0")) return "";
  return n + ".md";
}

function wikiNoteTitle(name) {
  let n = String(name || "").trim().replace(/\\/g, "/").replace(/\.md$/i, "");
  const parts = n.split("/").filter(Boolean);
  const last = (parts.length ? parts[parts.length - 1] : n) || "note";
  if (/active-horse$/i.test(last) || /\bhorse\b/i.test(last)) return "Plan";
  return last;
}

async function openWiki(name) {
  const n = String(name || "").trim();
  if (!n) return;
  if (/^\d{4}-\d{2}-\d{2}$/.test(n)) {
    closeAsk();
    await openDay(n);
    return;
  }
  if (/^plan$/i.test(n)) {
    closeAsk();
    location.hash = "plan";
    return;
  }
  try {
    const data = await api("/api/tree?dir=.");
    const files = data.files || [];
    const lower = n.toLowerCase().replace(/\.md$/, "");
    const hit = files.find((f) => {
      const base = f.replace(/\.md$/i, "").split("/").pop().toLowerCase();
      const pathNo = f.replace(/\.md$/i, "").toLowerCase();
      return base === lower || pathNo === lower || f.toLowerCase() === lower + ".md";
    });
    if (hit) {
      openVaultPath(hit);
      return;
    }
  } catch (err) {}
  const rel = wikiCreatePath(n);
  if (!rel) return;
  const title = wikiNoteTitle(n);
  const markdown = "# " + title + "\n";
  closeAsk();
  try {
    const res = await fetch("/api/file?path=" + encodeURIComponent(rel), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown, paper: markdown, mtime: 0 }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setStatus(String(err.error || res.statusText), "error");
      return;
    }
  } catch (e) {
    setStatus(String(e.message || e), "error");
    return;
  }
  await openVaultNote(rel);
}

function wikiNameAtPoint(x, y) {
  const paper = $("paper");
  if (!paper) return "";
  for (const link of paper.querySelectorAll(".md-link")) {
    for (const r of link.getClientRects()) {
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        return (link.getAttribute("data-name") || "").trim();
      }
    }
  }
  return "";
}

$("paper").addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest && e.target.closest(".md-box")) {
    e.preventDefault();
    return;
  }
  const name = wikiNameAtPoint(e.clientX, e.clientY);
  if (!name) return;
  e.preventDefault();
  e.stopPropagation();
  openWiki(name);
}, true);

$("paper").addEventListener("click", (e) => {
  const name = wikiNameAtPoint(e.clientX, e.clientY);
  if (name) {
    e.preventDefault();
    e.stopPropagation();
    openWiki(name);
    return;
  }
  const box = e.target.closest(".md-box");
  if (!box) return;
  e.preventDefault();
  const lineEl = box.closest(".md-line");
  const idx = paperLines().indexOf(lineEl);
  const dump = $("dump");
  const lines = dump.value.split("\n");
  if (!lines[idx] || !/^\s*[-*+]\s+\[[ xX]\]/.test(lines[idx])) return;
  pushPaperHistory(paperHistory, { markdown: dump.value, line: idx < 0 ? 0 : idx, caret: 0 }, { kind: "box" });
  lines[idx] = /\[[xX]\]/.test(lines[idx])
    ? lines[idx].replace(/\[[xX]\]/, "[ ]")
    : lines[idx].replace(/\[ \]/, "[x]");
  dump.value = lines.join("\n");
  if (state.day) { state.day.paper = dump.value; state.day.markdown = dump.value; }
  scheduleSave();
  paintPaper();
  renderRail();
});

function selectionText() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) return "";
  return sel.toString().replace(/\u00a0/g, " ").trim();
}

function pointInSelection(x, y) {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return false;
  for (const r of sel.getRangeAt(0).getClientRects()) {
    if (x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) return true;
  }
  return false;
}

function ensureGhost() {
  let g = $("slot-ghost");
  if (!g) {
    g = document.createElement("div");
    g.id = "slot-ghost";
    g.className = "slot-ghost hidden";
    document.body.appendChild(g);
  }
  return g;
}

const slotDrag = { armed: false, active: false, text: "", x: 0, y: 0, slot: null, line: -1 };

function slotIndexAtY(rects, y) {
  if (!rects || !rects.length) return -1;
  if (y < rects[0].top) return 0;
  if (y >= rects[rects.length - 1].bottom) return rects.length - 1;
  for (let i = 0; i < rects.length; i++) {
    if (y >= rects[i].top && y < rects[i].bottom) return i;
  }
  return -1;
}
function slotAtPoint(x, y) {
  const slots = [...document.querySelectorAll("#timeline .slot")];
  if (!slots.length) return null;
  const rects = slots.map((s) => s.getBoundingClientRect());
  const left = Math.min.apply(null, rects.map((r) => r.left));
  const right = Math.max.apply(null, rects.map((r) => r.right));
  if (x < left || x >= right) return null;
  const i = slotIndexAtY(rects, y);
  return i >= 0 ? slots[i] : null;
}
function paintSlotGhost(slot, text) {
  document.querySelectorAll(".slot-lane .block.ghost").forEach((n) => n.remove());
  if (!slot || !text) return;
  const lane = slot.querySelector(".slot-lane");
  if (!lane) return;
  const g = document.createElement("div");
  g.className = "block ghost";
  g.textContent = stripWhen(text) || text;
  g.style.pointerEvents = "none";
  lane.appendChild(g);
}
function clearSlotGhost() {
  document.querySelectorAll(".slot-lane .block.ghost").forEach((n) => n.remove());
}

function highlightSlotAt(x, y) {
  const slot = slotAtPoint(x, y);
  document.querySelectorAll(".slot.drop").forEach((n) => { if (n !== slot) n.classList.remove("drop"); });
  if (slot) slot.classList.add("drop");
  paintSlotGhost(slot, slotDrag.text);
  slotDrag.slot = slot;
}

function endSlotDrag(e) {
  const was = slotDrag.active;
  const text = slotDrag.text;
  clearSlotGhost();
  let slot = slotDrag.slot;
  if (e) {
    slot = slotAtPoint(e.clientX, e.clientY) || slot;
  }
  const g = $("slot-ghost");
  if (g) g.classList.add("hidden");
  document.body.classList.remove("is-slot-drag");
  document.querySelectorAll(".slot.drop").forEach((n) => n.classList.remove("drop"));
  if (was && slot && slot.dataset.time && text) applyWhen(text, slot.dataset.time);
  slotDrag.armed = false;
  slotDrag.active = false;
  slotDrag.text = "";
  slotDrag.slot = null;
  slotDrag.line = -1;
}

$("paper").addEventListener("mouseup", () => {
  const text = selectionText();
  if (text) state.lastPaperSelection = text;
});
$("paper").addEventListener("pointerdown", (e) => {
  if (e.target.closest && e.target.closest(".md-box")) {
    slotDrag.armed = false;
    return;
  }
  const dump = $("dump");
  if (!dump || !String(dump.value || "").trim()) {
    slotDrag.armed = false;
    return;
  }
  const line = e.target.closest ? e.target.closest(".md-line") : null;
  const idx = line ? paperLines().indexOf(line) : -1;
  const fromDump = (dump && idx >= 0 && dump.value.split("\n")[idx] != null) ? dump.value.split("\n")[idx] : "";
  const fromSrc = line ? (line.getAttribute("data-src") || "") : "";
  const text = fromDump || fromSrc;
  if (line && text) {
    slotDrag.armed = true;
    slotDrag.active = false;
    slotDrag.text = text;
    slotDrag.line = idx;
    slotDrag.x = e.clientX;
    slotDrag.y = e.clientY;
    slotDrag.slot = null;
  } else {
    slotDrag.armed = false;
    slotDrag.line = -1;
  }
});
window.addEventListener("pointermove", (e) => {
  if (!slotDrag.armed && !slotDrag.active) return;
  const dx = e.clientX - slotDrag.x;
  const dy = e.clientY - slotDrag.y;
  if (!slotDrag.active && Math.hypot(dx, dy) >= 8) {
    slotDrag.active = true;
    const g = ensureGhost();
    g.textContent = slotDrag.text;
    g.classList.remove("hidden");
    g.style.left = (e.clientX + 12) + "px";
    g.style.top = (e.clientY + 8) + "px";
    document.body.classList.add("is-slot-drag");
  }
  if (slotDrag.active) {
    if (e.cancelable) e.preventDefault();
    const g = ensureGhost();
    g.style.left = (e.clientX + 12) + "px";
    g.style.top = (e.clientY + 8) + "px";
    highlightSlotAt(e.clientX, e.clientY);
  }
}, { passive: false });
window.addEventListener("pointerup", endSlotDrag);
window.addEventListener("pointercancel", endSlotDrag);
const todayRail = document.querySelector(".today-rail");
if (todayRail) {
  todayRail.addEventListener("focusin", (e) => {
    if (slotDrag.active || slotDrag.armed) return;
    const t = e.target;
    if (t && t.closest && t.closest(".rail-head") && t.closest("button, a, input, select, textarea")) return;
    restorePaperFocus(paperCaret.line, paperCaret.caret);
  });
}
$("paper").addEventListener("dragstart", (e) => {
  const line = e.target && e.target.closest ? e.target.closest(".md-line") : null;
  if (!line) { e.preventDefault(); return; }
  const idx = paperLines().indexOf(line);
  const dump = $("dump");
  const fromDump = dump && idx >= 0 ? dump.value.split("\n")[idx] : "";
  const text = String(fromDump || line.getAttribute("data-src") || "").trim();
  if (!text) { e.preventDefault(); return; }
  e.dataTransfer.setData("text/plain", text);
  e.dataTransfer.setData("text/markdown", text);
  e.dataTransfer.effectAllowed = "copy";
  state.lastPaperSelection = text;
  slotDrag.text = text;
  slotDrag.line = idx;
  e.preventDefault();
});
$("paper").addEventListener("dragend", () => {
  slotDrag.active = false;
  slotDrag.armed = false;
  if (state.activeLine >= 0) paintPaperAt(state.activeLine);
  else paintPaper();
});
$("paper").addEventListener("dragover", (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
});
$("paper").addEventListener("drop", (e) => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener("selectionchange", () => {
  if (painting || keepPaperFocus || slotDrag.active) return;
  if (!paperFocused()) return;
  revealActiveLine();
});

function proposeDoorLines(sentence) {
  const raw = String(sentence == null ? "" : sentence).trim();
  if (!raw) return [];
  const lines = [];
  raw.split(/\s+and\s+|[,;]/i).forEach((part) => {
    const piece = part.trim();
    if (!piece) return;
    lines.push("- [ ] " + piece);
  });
  return lines;
}

function taskKey(line) {
  const item = parseTaskLine(line);
  if (!item) return "";
  return stripWhen(item.text).toLowerCase();
}

function appendDoorTasks(markdown, lines) {
  const seen = new Set();
  const tasks = [];
  for (const line of (Array.isArray(lines) ? lines : [])) {
    const s = String(line);
    if (!/^- \[ \] /.test(s)) continue;
    const key = taskKey(s);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    tasks.push(s);
  }
  const existing = markdown == null ? "" : String(markdown);
  if (!tasks.length) return existing;
  const have = new Set();
  for (const line of existing.split("\n")) {
    const key = taskKey(line);
    if (key) have.add(key);
  }
  const fresh = tasks.filter((line) => !have.has(taskKey(line)));
  if (!fresh.length) return existing;
  const block = fresh.join("\n") + "\n";
  if (!existing.trim()) return block;
  if (existing.endsWith("\n\n")) return existing + block;
  if (existing.endsWith("\n")) return existing + "\n" + block;
  return existing + "\n\n" + block;
}

function isWorkMapPath(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  if (!p.startsWith("maps/") || !/\.md$/i.test(p)) return false;
  const rest = p.slice(5);
  if (!rest || rest.includes("/")) return false;
  if (/^the-/i.test(rest)) return false;
  return true;
}

function nextStepTaskLines(markdown) {
  const lines = String(markdown || "").split("\n");
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^##\s+Next steps\s*$/i.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s+/.test(lines[i])) break;
    const line = lines[i].replace(/\r$/, "");
    if (/^- \[ \] /.test(line)) out.push(line);
  }
  return out;
}

function workMapPathsFromHits(hits) {
  const out = [];
  const seen = new Set();
  for (const h of hits || []) {
    const p = String((h && h.path) || "").replace(/\\/g, "/");
    if (!isWorkMapPath(p) || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out;
}

function landedDayMarkdown(existing, mapMarkdowns) {
  const tasks = [];
  for (const md of mapMarkdowns || []) {
    for (const line of nextStepTaskLines(md)) tasks.push(line);
  }
  return appendDoorTasks(existing, tasks);
}

let doorProposed = [];

function hideDoorProposals() {
  doorProposed = [];
  const box = $("door-proposals");
  if (box) {
    box.textContent = "";
    box.setAttribute("hidden", "");
  }
  const decide = $("door-decide");
  if (decide) decide.setAttribute("hidden", "");
}

function paintDoorProposals(lines) {
  const box = $("door-proposals");
  if (!box) return;
  const list = lines || [];
  doorProposed = list.slice();
  box.textContent = list.join("\n");
  const decide = $("door-decide");
  if (list.length) {
    box.removeAttribute("hidden");
    if (decide) decide.removeAttribute("hidden");
  } else {
    box.setAttribute("hidden", "");
    if (decide) decide.setAttribute("hidden", "");
  }
}

function goToday() {
  state.doc = null;
  if (location.hash !== "#today") location.hash = "today";
  showView("today");
  openDay(todayIso());
}
document.querySelectorAll("a[href='#today']").forEach((a) => {
  a.addEventListener("click", (e) => {
    e.preventDefault();
    goToday();
  });
});
$("door-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const input = $("door-input");
  const lines = proposeDoorLines(input ? input.value : "");
  if (lines.length) {
    paintDoorProposals(lines);
    return;
  }
  if (input) input.value = "";
  hideDoorProposals();
  goToday();
});
$("door-skip").addEventListener("click", () => {
  const input = $("door-input");
  if (input) input.value = "";
  hideDoorProposals();
  goToday();
});
$("door-accept").addEventListener("click", async () => {
  if (!doorProposed.length) return;
  const date = todayIso();
  const got = await fetch("/api/day?date=" + date);
  const body = await got.json().catch(() => ({}));
  if (!got.ok) {
    goToday();
    openDay(date);
    return;
  }
  const next = appendDoorTasks(body.markdown || "", doorProposed);
  const res = await fetch("/api/day?date=" + date, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ date, paper: next, markdown: next, mtime: body.mtime || 0 }),
  });
  if (res.status === 409) {
    goToday();
    openDay(date);
    return;
  }
  if (!res.ok) return;
  const input = $("door-input");
  if (input) input.value = "";
  hideDoorProposals();
  goToday();
  openDay(date);
});
$("door-reject").addEventListener("click", () => {
  const input = $("door-input");
  if (input) input.value = "";
  hideDoorProposals();
});

$("toggle-month").addEventListener("click", () => {
  state.monthShown = !state.monthShown;
  $("toggle-month").classList.toggle("is-on", state.monthShown);
  if (state.monthShown) {
    const selected = state.selectedDate || todayIso();
    const d = parseDate(selected);
    state.monthView = { year: d.getFullYear(), month: d.getMonth() + 1 };
  }
  renderMonth();
});

$("ask-open").addEventListener("click", openAsk);
$("ask-close").addEventListener("click", closeAsk);
$("ask-modal").addEventListener("click", (e) => {
  if (e.target === $("ask-modal")) closeAsk();
});
$("ask-form").addEventListener("submit", (e) => {
  e.preventDefault();
  runAsk($("ask-q").value);
});
$("ask-q").addEventListener("input", () => {
  clearTimeout(state.askTimer);
  const q = $("ask-q").value;
  state.askTimer = setTimeout(() => runAsk(q), 140);
});

function askOpen() {
  const modal = $("ask-modal");
  return modal && !modal.classList.contains("hidden") && !modal.hasAttribute("hidden");
}

document.addEventListener("keydown", handlePaperUndoKey, true);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAsk();
  if (askOpen()) return;
  if (handlePaperUndoKey(e)) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const inPaper = paperFocused();
  const chord = e.altKey || e.metaKey;
  if (inPaper && !chord) return;
  e.preventDefault();
  shiftDay(e.key === "ArrowLeft" ? -1 : 1);
});

window.addEventListener("hashchange", route);
window.addEventListener("pagehide", flushOnLeave);
window.addEventListener("beforeunload", flushOnLeave);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushOnLeave();
});

route();
state.weekStart = mondayOf(state.selectedDate ? parseDate(state.selectedDate) : new Date());
loadPlan().catch(() => {});
if (currentView() === "today") {
  loadWeek(state.weekStart).catch((e) => setStatus(String(e.message), "error"));
}
