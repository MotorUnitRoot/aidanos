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
