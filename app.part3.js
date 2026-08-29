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

function appendDoorTasks(markdown, lines) {
  const tasks = (Array.isArray(lines) ? lines : []).filter((line) => /^- \[ \] /.test(String(line)));
  const existing = markdown == null ? "" : String(markdown);
  if (!tasks.length) return existing;
  const block = tasks.join("\n") + "\n";
  if (!existing.trim()) return block;
  if (existing.endsWith("\n\n")) return existing + block;
  if (existing.endsWith("\n")) return existing + "\n" + block;
  return existing + "\n\n" + block;
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
