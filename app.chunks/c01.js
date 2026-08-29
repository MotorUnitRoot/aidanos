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
