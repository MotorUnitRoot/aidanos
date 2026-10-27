// Scrub secrets before anything is printed. The git token and the relay
// token must never appear in a log line.
import { closeSync, constants as fsConstants, createWriteStream, fchmodSync, fstatSync, ftruncateSync, lstatSync, openSync, writeSync } from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatWithOptions } from "node:util";
import { GH_APP_TOKEN_BYTES, GH_APP_TOKEN_SOURCE, GH_PAT_TOKEN_SOURCE } from "./github-tokens.mjs";

// This file lives at relay/src. A stack frame under that tree is shown
// repo-relative. A vault path that only looks like relay/src is not.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const SLASH_ALLOW = new Set(["HTTP/1.1", "KB/s", "MB/s", "application/json", "text/plain"]);
const NOTE_EXTS = ["markdown", "mdx", "txt", "md"];
const SHIELD = "\uE000";
// After secrets are masked, paths and note names are scrubbed on that
// window, then the line is cut here. The cut is the raw byte offset.
// Measuring it after [path] replacement skips the cut when a path
// collapses, and a secret sliced at the first edge stays in plain text.
// Scrubbing after the cut leaves a spaced note name that crossed 64 KB
// as a fragment. A note name over 255 bytes is trimmed back to the start
// of the name. A space is inside the name, so the last space would keep
// the words ahead of it. Any other partial token is trimmed back to the
// last break, and the kept text is scrubbed again.
export const REDACT_INPUT_CAP = 64 * 1024;
// How far a cut walks back to finish a token. A line with no break in this
// window keeps the character boundary instead of collapsing to the marker.
// 256 or more non-break characters before a secret used to keep the
// secret's head. The whole text is masked before this cut, and any
// trailing piece that still begins a listed secret is then dropped.
const CAP_BREAK_WINDOW = 256;
// The mask window is 64 KB plus a margin measured in UTF-8 bytes, not
// UTF-16 units. A 30 MB adversarial line is one pass over that window,
// under 100 ms. The tail past the window is never read.
// A Node stack frame we may show. A builtin module, or a node:internal
// path whose every segment is a known Node name. A user directory under
// a known prefix, such as node:internal/fs/users/colby, is not a frame.
const NODE_FRAME = /^node:[a-z0-9_./]+(?:\.js)?:\d+:\d+$/;
const NODE_INTERNAL_FRAME = /^node:internal\/[a-z_/]+(?:\.js)?:\d+:\d+$/;
const NODE_INTERNAL_PREFIXES = new Set([
  "assert", "async_hooks", "blob", "bootstrap", "buffer", "child_process",
  "cluster", "console", "constants", "crypto", "data_url", "debugger",
  "deps", "dgram", "dns", "encoding", "errors", "event_target", "events",
  "fixed_queue", "fs", "http", "inspector", "inspector_async_hook",
  "linkedlist", "main", "mime", "modules", "net", "options", "perf",
  "priority_queue", "process", "querystring", "readline", "repl",
  "source_map", "streams", "test", "timers", "tls", "trace_events", "tty",
  "url", "util", "v8", "validators", "vm", "wasi", "watch_mode", "webidl",
  "webstreams", "worker",
]);
// Segments that follow a known prefix. The first segment still has to be
// a prefix: cjs alone is not a Node entry point. modules/cjs/loader is.
const NODE_INTERNAL_SEGMENTS = new Set([
  ...NODE_INTERNAL_PREFIXES,
  "cjs", "esm", "loader", "utils", "promises", "module_job", "translators",
  "run_main", "run_main_module", "get_format", "hooks", "load", "resolve",
  "formats", "module_map", "helpers", "package_json_reader",
  "customization_hooks", "shared_constants", "create_dynamic_module",
]);
const NODE_BUILTINS = new Set(builtinModules.map((name) => name.startsWith("node:") ? name.slice(5) : name));

// Byte length without a Buffer. The cut stays on a code point, same as
// walking a UTF-8 continuation byte back to its lead. A code unit is at
// most 3 UTF-8 bytes, so a short string fits without a walk. A longer
// string stops at the cap and does not read the tail.
function utf8PrefixEnd(text, cap) {
  if (text.length * 3 <= cap) return text.length;
  let bytes = 0;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const code = text.codePointAt(i);
    const width = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    if (bytes + width > cap) return i;
    bytes += width;
    i += code > 0xffff ? 2 : 1;
  }
  return i;
}

function utf8ByteLength(text) {
  let bytes = 0;
  for (let i = 0; i < text.length;) {
    const code = text.codePointAt(i);
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
    i += code > 0xffff ? 2 : 1;
  }
  return bytes;
}

// Bytes, not UTF-16 code units. A listed secret and its encoded form are
// both counted. GH_APP_TOKEN_BYTES is only a margin floor: gh[pousr]_ and
// github_pat_ have no upper bound, so a body that starts in this window
// is masked to the end of that run. The raw cut drops whatever remains
// past 64 KB.
function maskMarginBytes(secrets) {
  let span = GH_APP_TOKEN_BYTES;
  for (let i = 0; i < secrets.length; i += 1) {
    const secret = secrets[i];
    const bytes = utf8ByteLength(secret);
    if (bytes > span) span = bytes;
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) {
      const encodedBytes = utf8ByteLength(encoded);
      if (encodedBytes > span) span = encodedBytes;
    }
  }
  return span;
}

// After a cut, a suffix that is only the start of a listed secret is the
// head the 256-character window used to keep. Drop that piece. A full
// secret is already masked, so only a proper prefix is removed.
function dropSecretTail(text, secrets) {
  if (!text || !secrets || !secrets.length) return text;
  let drop = 0;
  for (let s = 0; s < secrets.length; s += 1) {
    const secret = secrets[s];
    if (!secret || secret.length < 2) continue;
    const max = Math.min(text.length, secret.length - 1);
    for (let len = max; len > drop; len -= 1) {
      if (text.endsWith(secret.slice(0, len))) {
        drop = len;
        break;
      }
    }
  }
  return drop ? text.slice(0, -drop) : text;
}

// A replacement before the raw cut shifts the cut. A match that straddles
// the cut is kept whole, as ***, because the secret began inside the line
// we keep. A match that starts at the cut or after it is discarded with
// the tail.
function replaceTracked(text, re, replacement, cutAt) {
  let out = "";
  let last = 0;
  let mapped = cutAt;
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    const start = match.index;
    const end = start + match[0].length;
    out += text.slice(last, start) + replacement;
    if (end <= cutAt) mapped += replacement.length - (end - start);
    else if (start < cutAt) mapped = out.length;
    last = end;
    if (match[0].length === 0) {
      re.lastIndex += 1;
      if (re.lastIndex > text.length) break;
    }
  }
  out += text.slice(last);
  return { text: out, cutAt: mapped };
}

function maskLiteralTracked(text, needle, replacement, cutAt) {
  if (!needle) return { text, cutAt };
  let out = "";
  let last = 0;
  let mapped = cutAt;
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf(needle, from);
    if (at === -1) break;
    const end = at + needle.length;
    out += text.slice(last, at) + replacement;
    if (end <= cutAt) mapped += replacement.length - needle.length;
    else if (at < cutAt) mapped = out.length;
    last = end;
    from = end;
  }
  out += text.slice(last);
  return { text: out, cutAt: mapped };
}

// One pass. The marker is a private-use character that the input no longer
// contains, so a frame is put back without scanning the line once per frame.
export function restoreShields(text, kept) {
  return String(text).replace(/\uE000([0-9a-f]+)\uE000/g, (_marker, hex) => {
    const value = kept[parseInt(hex, 16)];
    return value ?? "";
  });
}

export function redact(text, secrets) {
  // Strip the shield marker before any scrubbing so a log line cannot forge
  // a kept frame. Mask first, on a window of 64 KB plus a byte margin, so a
  // secret that straddles the cut is whole when it is replaced. Then scrub
  // paths and note names on that window. Then cut at the raw 64 KB point
  // and drop a listed prefix the cut still sliced. Collapsing a path to
  // [path] must not pull a sliced secret back under 64 KB and skip the cut.
  // The kept text is scrubbed again. A note name over 255 bytes is
  // trimmed back to the start of the name. Any other partial token on
  // the cut is trimmed back to the last break.
  const list = [];
  for (const secret of secrets || []) {
    const value = String(secret || "").trim();
    if (value && !list.includes(value)) list.push(value);
  }
  const raw = String(text ?? "").replace(/\uE000/g, "");
  const margin = maskMarginBytes(list);
  const cut = utf8PrefixEnd(raw, REDACT_INPUT_CAP);
  const windowEnd = utf8PrefixEnd(raw, REDACT_INPUT_CAP + margin);
  const state = {
    text: windowEnd >= raw.length ? raw : raw.slice(0, windowEnd),
    cutAt: cut,
    tails: [],
  };
  const maskNeedle = (needle) => {
    const next = maskLiteralTracked(state.text, needle, "***", state.cutAt);
    state.text = next.text;
    state.cutAt = next.cutAt;
    state.tails.push(needle);
  };
  for (const secret of list) {
    maskNeedle(secret);
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) maskNeedle(encoded);
  }
  const maskPattern = (source, flags, replacement) => {
    const next = replaceTracked(state.text, new RegExp(source, flags), replacement, state.cutAt);
    state.text = next.text;
    state.cutAt = next.cutAt;
  };
  maskPattern("x-access-token:[^@\\s]+", "gi", "x-access-token:***");
  maskPattern(GH_APP_TOKEN_SOURCE, "g", "***");
  maskPattern(GH_PAT_TOKEN_SOURCE, "g", "***");
  maskPattern("Bearer\\s+\\S+", "gi", "Bearer ***");
  maskPattern("Authorization:\\s*Basic\\s+\\S+", "gi", "Authorization: Basic ***");
  maskPattern("AIDANOS_(?:RELAY|VAULT_GIT)_TOKEN=\\S+", "g", "AIDANOS_TOKEN=***");
  maskPattern("https?:\\/\\/[^\\s]+", "gi", "[url]");
  const kept = [];
  const scrubbed = scrubWindowTracked(state.text, state.cutAt, kept);
  state.text = scrubbed.text;
  state.cutAt = scrubbed.cutAt;
  let out = state.text.slice(0, state.cutAt);
  if (cut < raw.length) {
    // The window scrub already replaced a name whose extension was in
    // the margin. This pass catches a name that is whole in the kept
    // text. A spaced name over 255 bytes, whose extension is still past
    // the window, is trimmed back to the start of that name. A sliced
    // token the raw cut still ends on is then dropped.
    out = scrubLocations(out, kept);
    out = trimPartialLocation(out, state.text, state.cutAt);
    out = dropSecretTail(out, state.tails);
  }
  // Same scrub for stderr and fatal.log. A vault path or a note file name
  // must not land in either. Document ids have neither a slash nor a .md suffix.
  // The 8 KB cap still runs after the scrub, so a path or a spaced note name
  // that crosses 8 KB is already [path] or [note], not a leftover prefix.
  out = out.replace(/file:\/\/\S+/gi, "[url]");
  out = restoreShields(out, kept);
  return capLocations(out, state.tails);
}

// A replacement before the raw cut shifts the cut. A path or note name
// that straddles the cut is kept whole, as [path] or [note]. Plain text
// that straddles is cut at the raw point. A match that starts at the cut
// or after it is discarded with the tail.
function trackPiece(state, start, end, replacement, keepWhole) {
  state.parts.push(replacement);
  const before = state.outLen;
  state.outLen += replacement.length;
  if (end <= state.cutAt) state.mapped += replacement.length - (end - start);
  else if (start < state.cutAt) state.mapped = keepWhole ? state.outLen : before + (state.cutAt - start);
}

// A quote, colon, slash, newline, or a masked star ends a note name.
// A space does not.
function isNoteEdge(code) {
  return code === 10 || code === 34 || code === 39 || code === 42 || code === 47 || code === 58 || code === 96;
}

// The run that crosses the cut, from its left edge through the margin.
// The cut is unchanged when it is not inside a spaced name longer than
// 255 bytes.
function crossingNoteStart(text, cutAt) {
  if (cutAt <= 0 || cutAt > text.length) return cutAt;
  let start = cutAt;
  while (start > 0 && !isNoteEdge(text.charCodeAt(start - 1))) start -= 1;
  let end = cutAt;
  while (end < text.length && !isNoteEdge(text.charCodeAt(end))) end += 1;
  if (start >= cutAt) return cutAt;
  const run = text.slice(start, end);
  let spaced = false;
  for (let i = 0; i < run.length; i += 1) {
    if (run.charCodeAt(i) <= 32) {
      spaced = true;
      break;
    }
  }
  if (!spaced || utf8ByteLength(run) <= 255 || run.includes("*")) return cutAt;
  return start;
}

// The raw cut can end in the middle of a token. A spaced note name longer
// than 255 bytes is dropped back to the start of the name. The last space
// would keep the words ahead of it. Any other token is dropped back to the
// last break. No break in the last 256 bytes keeps the character boundary.
// A trailing *** is a masked secret and stays.
function trimPartialLocation(text, windowText, windowCut) {
  let kept = text;
  if (typeof windowText === "string" && windowText.slice(0, windowCut) === text) {
    const nameAt = crossingNoteStart(windowText, windowCut);
    if (nameAt < windowCut) kept = text.slice(0, nameAt);
  }
  let end = kept.length;
  const floor = Math.max(0, end - CAP_BREAK_WINDOW);
  while (end > floor && !isBreak(kept.charCodeAt(end - 1))) end -= 1;
  if (end === kept.length || end <= floor) return kept;
  if (kept.slice(end).includes("*")) return kept;
  return kept.slice(0, end);
}

// One log line, then the marker. The cut is applied to text that is already
// scrubbed, and the last partial token is dropped so the marker does not
// keep the start of a path.
export const LOG_LINE_CAP = 8 * 1024;

function shield(kept, text) {
  const token = SHIELD + kept.length.toString(16) + SHIELD;
  kept.push(text);
  return token;
}

// Token boundaries. A slash stays inside the token so /a/b and a/b are one path.
function isBreak(code) {
  return code <= 32 || code === 34 || code === 39 || code === 40 || code === 41
    || code === 58 || code === 60 || code === 61 || code === 62 || code === 91
    || code === 93 || code === 96;
}

function isDigit(code) {
  return code >= 48 && code <= 57;
}

function isRatio(token) {
  let slash = -1;
  for (let i = 0; i < token.length; i += 1) {
    const code = token.charCodeAt(i);
    if (code === 47) {
      if (slash !== -1 || i === 0 || i + 1 === token.length) return false;
      slash = i;
      continue;
    }
    if (!isDigit(code)) return false;
  }
  return slash !== -1;
}

// :line:col after a path. Returns the index just past the column, or 0.
function stackTail(line, i) {
  const n = line.length;
  if (i >= n || line.charCodeAt(i) !== 58) return 0;
  let j = i + 1;
  if (j >= n || !isDigit(line.charCodeAt(j))) return 0;
  while (j < n && isDigit(line.charCodeAt(j))) j += 1;
  if (j >= n || line.charCodeAt(j) !== 58) return 0;
  j += 1;
  if (j >= n || !isDigit(line.charCodeAt(j))) return 0;
  while (j < n && isDigit(line.charCodeAt(j))) j += 1;
  return j;
}

function repoFrame(absPath) {
  if (!absPath || absPath.includes("\0")) return "";
  const abs = path.resolve(absPath);
  const root = REPO_ROOT.endsWith(path.sep) ? REPO_ROOT : REPO_ROOT + path.sep;
  if (!abs.startsWith(root)) return "";
  const rel = path.relative(REPO_ROOT, abs).split(path.sep).join("/");
  if (!rel.startsWith("relay/") || rel.split("/").includes("..") || rel.split("/").includes("")) return "";
  return rel;
}

function fileUrlFrame(url) {
  const lower = url.slice(0, 7).toLowerCase();
  if (lower !== "file://") return "";
  let body = url.slice(7);
  const tailAt = body.lastIndexOf(":");
  if (tailAt <= 0) return "";
  const lineAt = body.lastIndexOf(":", tailAt - 1);
  if (lineAt <= 0) return "";
  const tail = stackTail(body, lineAt);
  if (tail !== body.length) return "";
  const abs = body.slice(0, lineAt);
  const shown = repoFrame(abs);
  if (!shown) return "";
  return shown + body.slice(lineAt);
}

function capScrubbed(line, secrets) {
  const end = utf8PrefixEnd(line, LOG_LINE_CAP);
  if (end >= line.length) return line;
  let head = line.slice(0, end);
  const floor = Math.max(0, head.length - CAP_BREAK_WINDOW);
  let cut = head.length;
  while (cut > floor && !isBreak(head.charCodeAt(cut - 1))) cut -= 1;
  // A break in the last 256 bytes ends the line on that token, which drops
  // a partial path. No break: keep the character-boundary cut, about 8 KB,
  // then drop a trailing piece that still begins a listed secret.
  if (cut > floor) head = head.slice(0, cut);
  head = dropSecretTail(head, secrets);
  // '[' is a break, so a cut inside [[path]] keeps the brackets and the
  // marker would read [[truncated]. Drop every leftover bracket.
  head = head.replace(/\[+$/, "");
  return head + "[truncated]";
}

function nodeFrameEnd(line, i) {
  if (!line.startsWith("node:", i)) return 0;
  let j = i + 5;
  let end = 0;
  const n = line.length;
  while (j < n) {
    const code = line.charCodeAt(j);
    if (code === 58) {
      const tail = stackTail(line, j);
      if (!tail) return 0;
      end = tail;
      break;
    }
    if (isBreak(code)) return 0;
    j += 1;
  }
  if (!end) return 0;
  const frame = line.slice(i, end);
  if (!nodeBuiltinFrame(frame)) return 0;
  return end;
}

function nodeBuiltinFrame(frame) {
  if (!NODE_FRAME.test(frame) || frame.includes("..")) return false;
  const pathPart = frame.slice(5).replace(/(?:\.js)?:\d+:\d+$/, "");
  if (pathPart !== pathPart.toLowerCase()) return false;
  for (const ext of NOTE_EXTS) {
    if (pathPart.endsWith("." + ext) || pathPart.includes("." + ext + "/")) return false;
  }
  if (pathPart === "internal" || pathPart.startsWith("internal/")) {
    if (!NODE_INTERNAL_FRAME.test(frame)) return false;
    const rest = pathPart.slice("internal/".length).replace(/\.js$/, "");
    if (!/^[a-z_]+(?:\/[a-z_]+)*$/.test(rest)) return false;
    const segments = rest.split("/");
    if (!NODE_INTERNAL_PREFIXES.has(segments[0])) return false;
    for (let i = 0; i < segments.length; i += 1) {
      if (!NODE_INTERNAL_SEGMENTS.has(segments[i])) return false;
    }
    return true;
  }
  return NODE_BUILTINS.has(pathPart);
}

// One forward pass. Each character is copied or skipped once, so a line of
// '(a/' or 'a/a/a/' cannot blow up the way a nested quantifier did.
// cutAt is an index in this line. The returned cutAt is where that same
// raw point lands after replacements.
function scrubPathsTracked(line, cutAt, kept) {
  const n = line.length;
  const state = { parts: [], outLen: 0, mapped: cutAt, cutAt };
  let i = 0;
  while (i < n) {
    const start = i;
    while (i < n && isBreak(line.charCodeAt(i))) i += 1;
    if (i > start) trackPiece(state, start, i, line.slice(start, i), false);
    if (i >= n) break;
    if (line.startsWith("file://", i)) {
      let j = i + 7;
      while (j < n && line.charCodeAt(j) > 32 && line.charCodeAt(j) !== 41) j += 1;
      const url = line.slice(i, j);
      const shown = fileUrlFrame(url);
      trackPiece(state, i, j, shown ? shield(kept, shown) : url, true);
      i = j;
      continue;
    }
    const nodeEnd = nodeFrameEnd(line, i);
    if (nodeEnd) {
      trackPiece(state, i, nodeEnd, shield(kept, line.slice(i, nodeEnd)), true);
      i = nodeEnd;
      continue;
    }
    if (driveAt(line, i)) {
      const tokenStart = i;
      i += 2;
      while (i < n && !isBreak(line.charCodeAt(i))) i += 1;
      const token = line.slice(tokenStart, i);
      trackPiece(state, tokenStart, i, token.length ? "[path]" : "", true);
      continue;
    }
    const tokenStart = i;
    let slash = false;
    let encoded = false;
    while (i < n && !isBreak(line.charCodeAt(i))) {
      const code = line.charCodeAt(i);
      if (code === 47 || code === 92) slash = true;
      if (code === 37 && i + 2 < n && line.charCodeAt(i + 1) === 50) {
        const hex = line.charCodeAt(i + 2);
        if (hex === 70 || hex === 102) encoded = true;
      }
      i += 1;
    }
    const token = line.slice(tokenStart, i);
    const tail = stackTail(line, i);
    if (tail && (token.startsWith("/") || token.startsWith("\\"))) {
      const shown = repoFrame(token);
      if (shown) {
        trackPiece(state, tokenStart, tail, shield(kept, shown + line.slice(i, tail)), true);
        i = tail;
        continue;
      }
    }
    if (SLASH_ALLOW.has(token) || isRatio(token)) {
      trackPiece(state, tokenStart, i, token, false);
      continue;
    }
    trackPiece(state, tokenStart, i, slash || encoded ? "[path]" : token, Boolean(slash || encoded));
  }
  return { text: state.parts.join(""), cutAt: state.mapped };
}

function scrubPaths(line, kept) {
  return scrubPathsTracked(line, line.length, kept).text;
}

function driveAt(line, i) {
  if (i + 2 >= line.length) return false;
  const code = line.charCodeAt(i);
  const letter = (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  if (!letter || line.charCodeAt(i + 1) !== 58) return false;
  const sep = line.charCodeAt(i + 2);
  return sep === 92 || sep === 47;
}

function matchNoteExt(line, i) {
  if (i >= line.length || line.charCodeAt(i) !== 46) return 0;
  for (const ext of NOTE_EXTS) {
    const after = i + 1 + ext.length;
    if (after > line.length) continue;
    let ok = true;
    for (let k = 0; k < ext.length; k += 1) {
      let code = line.charCodeAt(i + 1 + k);
      if (code >= 65 && code <= 90) code += 32;
      if (code !== ext.charCodeAt(k)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    if (after < line.length) {
      const code = line.charCodeAt(after);
      const word = (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95;
      if (word) continue;
    }
    return after;
  }
  return 0;
}

// A note name may contain spaces. The left edge is the line start, a quote,
// a colon, or a slash. Walking stops at a span already claimed, so the pass
// stays linear. .md, .txt, .markdown, and .mdx match in either case.
function scrubNotesTracked(line, cutAt) {
  const n = line.length;
  const drop = new Uint8Array(n);
  let i = 0;
  while (i < n) {
    const ext = matchNoteExt(line, i);
    if (!ext) {
      i += 1;
      continue;
    }
    let start = i;
    while (start > 0 && !drop[start - 1]) {
      const c = line.charCodeAt(start - 1);
      if (c === 39 || c === 34 || c === 96 || c === 58 || c === 47 || c === 10) break;
      start -= 1;
    }
    for (let k = start; k < ext; k += 1) drop[k] = 1;
    i = ext;
  }
  const state = { parts: [], outLen: 0, mapped: cutAt, cutAt };
  let k = 0;
  while (k < n) {
    if (!drop[k]) {
      const start = k;
      while (k < n && !drop[k]) k += 1;
      trackPiece(state, start, k, line.slice(start, k), false);
      continue;
    }
    const start = k;
    while (k < n && drop[k]) k += 1;
    trackPiece(state, start, k, "[note]", true);
  }
  return { text: state.parts.join(""), cutAt: state.mapped };
}

function scrubNotes(line) {
  return scrubNotesTracked(line, line.length).text;
}

// Paths and note names on the masked window. cutAt is the raw 64 KB point
// in that window. Lines after the cut are still scrubbed so a name whose
// extension sits in the margin is whole before the slice.
function scrubWindowTracked(text, cutAt, kept) {
  const lines = String(text).split("\n");
  const outLines = [];
  let src = 0;
  let mapped = 0;
  let placed = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const localCut = cutAt - src;
    const paths = scrubPathsTracked(line, localCut, kept);
    const notes = scrubNotesTracked(paths.text, paths.cutAt);
    outLines.push(notes.text);
    if (!placed) {
      if (localCut <= 0) placed = true;
      else if (localCut < line.length) {
        mapped += notes.cutAt;
        placed = true;
      } else mapped += notes.text.length;
    }
    src += line.length;
    if (i + 1 < lines.length) {
      if (!placed) {
        if (cutAt > src) mapped += 1;
        else placed = true;
      }
      src += 1;
    }
  }
  const joined = outLines.join("\n");
  if (!placed) mapped = joined.length;
  return replaceTracked(joined, /file:\/\/\S+/gi, "[url]", mapped);
}

function scrubLine(line, kept) {
  return scrubNotes(scrubPaths(line, kept));
}

function scrubLocations(text, kept) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) lines[i] = scrubLine(lines[i], kept);
  return lines.join("\n");
}

function capLocations(text, secrets) {
  const lines = String(text).split("\n");
  for (let i = 0; i < lines.length; i += 1) lines[i] = capScrubbed(lines[i], secrets);
  return lines.join("\n");
}

export function stampLine(line, now = new Date()) {
  return now.toISOString() + " " + String(line);
}

function formatParts(secrets, parts) {
  const line = parts
    .map((part) => {
      if (part instanceof Error) return part.stack || part.message || "error";
      return String(part);
    })
    .join(" ");
  return redact(line, secrets);
}

export function logSafe(secrets, ...parts) {
  console.error(stampLine(formatParts(secrets, parts)));
}

// A startup refusal calls process.exit on the next line. The async file
// log drops that line, and any line still queued ahead of it, when the
// process ends. writeSync lands them before the exit. A full non-blocking
// pipe answers EAGAIN; that must not throw past the exit.
let fileLogFd = null;
let fileLogStream = null;
// Bytes accepted by console.error whose write callback has not run.
// A finished write drops its buffer here, so a later flush cannot write
// that line again. Held bytes stay under the same cap as the stream.
let fileLogPending = [];
let fileLogPendingBytes = 0;
let takeDropNotice = () => "";
// Last resort for a fatal line when stderr stays full. The relay sets this
// to its own state directory before it can exit.
let fatalFallbackDir = null;
const fatalWait = new Int32Array(new SharedArrayBuffer(4));

function isAgain(error) {
  return !!error && (error.code === "EAGAIN" || error.code === "EWOULDBLOCK");
}

function chunkBytes(item) {
  if (!item || item.chunk == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(item.chunk)) return item.chunk;
  return Buffer.from(String(item.chunk), item.encoding || "utf8");
}

function pendingSize(item) {
  if (!item) return 0;
  if (typeof item.size === "number") return item.size;
  if (typeof item.length === "number") return item.length;
  return 0;
}

// The hot path keeps the string and its byte length. A Buffer is built
// only if a fatal flush has to write the line itself.
function rememberPending(item) {
  fileLogPending.push(item);
  fileLogPendingBytes += pendingSize(item);
}

function forgetPending(item) {
  const index = fileLogPending.indexOf(item);
  if (index === -1) return;
  fileLogPending.splice(index, 1);
  fileLogPendingBytes -= pendingSize(item);
  if (fileLogPendingBytes < 0) fileLogPendingBytes = 0;
}

function setPending(buffers) {
  fileLogPending = buffers;
  fileLogPendingBytes = 0;
  for (const bytes of buffers) fileLogPendingBytes += bytes.length;
}

function heldLogBytes(stream) {
  const queued = stream && typeof stream.writableLength === "number" ? stream.writableLength : 0;
  return Math.max(fileLogPendingBytes, queued);
}

function writeSyncSome(fd, buffer) {
  try {
    const wrote = writeSync(fd, buffer, 0, buffer.length);
    return wrote > 0 ? wrote : 0;
  } catch (error) {
    if (isAgain(error)) return -1;
    throw error;
  }
}

function itemBytes(item) {
  if (Buffer.isBuffer(item)) return item;
  if (item && typeof item.text === "string") return Buffer.from(item.text);
  return chunkBytes(item);
}

function writeBounded(fd, parts, maxBytes, asStreamItem) {
  const kept = [];
  const done = [];
  let length = 0;
  let budget = Number(maxBytes) > 0 ? Number(maxBytes) : FILE_LOG_CAP;
  let stopped = false;
  for (const item of parts) {
    const bytes = itemBytes(item);
    if (stopped || budget <= 0) {
      kept.push(asStreamItem ? item : bytes);
      length += bytes.length;
      continue;
    }
    const slice = bytes.length > budget ? bytes.subarray(0, budget) : bytes;
    const wrote = slice.length === 0 ? 0 : writeSyncSome(fd, slice);
    if (wrote < 0) {
      stopped = true;
      kept.push(asStreamItem ? item : bytes);
      length += bytes.length;
      continue;
    }
    budget -= wrote;
    if (wrote < bytes.length) {
      stopped = true;
      const rest = bytes.subarray(wrote);
      kept.push(asStreamItem ? { chunk: rest, encoding: "buffer", callback: item.callback } : rest);
      length += rest.length;
      continue;
    }
    if (asStreamItem && typeof item.callback === "function") done.push(item.callback);
  }
  for (const callback of done) {
    try { callback(); } catch { /* a queued callback must not block the exit */ }
  }
  return { kept, length };
}

// Write the lines still sitting in the async stream, up to the cap.
// Stop when the pipe is full. Clearing the queue keeps the stream from
// writing those bytes again on the next turn.
// Node keeps those lines in stream._writableState.buffered. That array
// is not a public API. When it is missing, only the bytes whose write
// callback has not run are written. A line that already drained is not
// in that list, so this path does not write it a second time.
export function flushFileLog(maxBytes = FILE_LOG_CAP) {
  const stream = fileLogStream;
  const fd = fileLogFd == null ? process.stderr.fd : fileLogFd;
  if (typeof fd !== "number" || fd < 0) return;
  const state = stream && stream._writableState;
  if (!state || !Array.isArray(state.buffered)) {
    const drained = writeBounded(fd, fileLogPending, maxBytes, false);
    setPending(drained.kept);
    return;
  }
  const drained = writeBounded(fd, state.buffered, maxBytes, true);
  state.buffered = drained.kept;
  state.length = drained.length;
  if (typeof state.bufferedIndex === "number") state.bufferedIndex = 0;
  setPending(drained.kept.map((item) => chunkBytes(item)));
}

// Keep the next console.error in the queue. An idle stream would otherwise
// hand that line to an async write, where flush can no longer see it.
export function pauseFileLog() {
  const stream = fileLogStream;
  if (!stream || typeof stream.cork !== "function" || stream.destroyed) return;
  try {
    stream.cork();
  } catch { /* the flush still runs */ }
}

// One window for every fatal line in this exit, notice included.
export const FATAL_RETRY_MS = 100;
export const FATAL_FALLBACK_NAME = "fatal.log";

export function setFatalFallbackDir(dir) {
  fatalFallbackDir = dir ? path.resolve(String(dir)) : null;
}

function waitForPipe(ms) {
  if (ms > 0) Atomics.wait(fatalWait, 0, 0, ms);
}

const GROUP_OR_OTHER_WRITE = 0o022;
const STICKY = 0o1000;
const FATAL_RESTART_LINE = "fatal log restarted\n";

// Every directory on the state path, not only the last component. A symlink
// is refused even when root owns it. Other owner rules match the helper walk:
// root or this user, and group or other write only on a sticky root directory.
function stateDirAllowed(dir, uid) {
  if (typeof uid !== "number") return null;
  const abs = path.resolve(dir);
  const parts = abs.split(path.sep).filter(Boolean);
  let cursor = path.parse(abs).root;
  const check = (st) => {
    if (!st || st.isSymbolicLink() || !st.isDirectory()) return false;
    const writable = (st.mode & GROUP_OR_OTHER_WRITE) !== 0;
    const stickyRoot = (st.mode & STICKY) !== 0 && st.uid === 0;
    if (writable && !stickyRoot) return false;
    if (st.uid !== 0 && st.uid !== uid) return false;
    return true;
  };
  let rootStat;
  try {
    rootStat = lstatSync(cursor);
  } catch {
    return null;
  }
  if (!check(rootStat)) return null;
  // The leaf's dev+ino is the one the open must match. A later lstat can
  // name a different directory than the one this walk accepted.
  let recorded = rootStat;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    let st;
    try {
      st = lstatSync(cursor);
    } catch {
      return null;
    }
    if (!check(st)) return null;
    recorded = st;
  }
  if (cursor !== abs) return null;
  return { dev: recorded.dev, ino: recorded.ino };
}

function refuseFatalFallback(stderrFd, bytes) {
  try {
    if (typeof stderrFd === "number" && stderrFd >= 0 && bytes && bytes.length > 0) writeSync(stderrFd, bytes);
  } catch { /* one attempt, then the exit continues */ }
  return false;
}

function fatalPayload(size, bytes) {
  const incoming = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
  if (size + incoming.length <= FILE_LOG_CAP) return { restart: false, bytes: incoming };
  const marker = Buffer.from(FATAL_RESTART_LINE);
  const room = FILE_LOG_CAP - marker.length;
  if (room <= 0) return null;
  const body = incoming.length > room ? incoming.subarray(incoming.length - room) : incoming;
  return { restart: true, bytes: Buffer.concat([marker, body]) };
}

// A full pipe refuses the write with EAGAIN. Retry until the window is
// gone, then append the unread bytes to a fixed file. The state directory
// is opened as a descriptor and walked first: no symlink anywhere on its
// path. The file is opened O_NOFOLLOW|O_APPEND|O_CREAT, then fstat must
// show a regular file, one link, and our uid before any fchmod or write.
// Past 1 MiB the file is truncated and restarted with a marker. A refusal
// skips the file and tries stderr once.
function appendFatalFallback(bytes, stderrFd) {
  if (!fatalFallbackDir || !bytes || bytes.length === 0) return false;
  const nofollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (typeof nofollow !== "number" || typeof directory !== "number") return refuseFatalFallback(stderrFd, bytes);
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const recorded = stateDirAllowed(fatalFallbackDir, uid);
  if (!recorded) return refuseFatalFallback(stderrFd, bytes);
  let dirfd = -1;
  let fd = -1;
  try {
    dirfd = openSync(fatalFallbackDir, fsConstants.O_RDONLY | directory | nofollow);
    const openedDir = fstatSync(dirfd);
    if (
      !openedDir.isDirectory() ||
      openedDir.isSymbolicLink() ||
      openedDir.dev !== recorded.dev ||
      openedDir.ino !== recorded.ino
    ) {
      return refuseFatalFallback(stderrFd, bytes);
    }
    const filePath = process.platform === "linux"
      ? "/proc/self/fd/" + dirfd + "/" + FATAL_FALLBACK_NAME
      : path.join(fatalFallbackDir, FATAL_FALLBACK_NAME);
    fd = openSync(
      filePath,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_APPEND | nofollow,
      0o600,
    );
    const st = fstatSync(fd);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== uid) {
      return refuseFatalFallback(stderrFd, bytes);
    }
    const payload = fatalPayload(st.size, bytes);
    if (!payload) return refuseFatalFallback(stderrFd, bytes);
    fchmodSync(fd, 0o600);
    if (payload.restart) ftruncateSync(fd, 0);
    writeSync(fd, payload.bytes);
    return true;
  } catch {
    return refuseFatalFallback(stderrFd, bytes);
  } finally {
    if (fd >= 0) {
      try { closeSync(fd); } catch { /* the exit still runs */ }
    }
    if (dirfd >= 0) {
      try { closeSync(dirfd); } catch { /* the exit still runs */ }
    }
  }
}

function writeFatalLine(fd, line, deadline) {
  if (!line) return;
  const bytes = Buffer.isBuffer(line) ? line : Buffer.from(String(line));
  let offset = 0;
  while (offset < bytes.length) {
    try {
      const wrote = writeSync(fd, bytes, offset, bytes.length - offset);
      if (wrote > 0) {
        offset += wrote;
        continue;
      }
    } catch (error) {
      if (!isAgain(error)) throw error;
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      appendFatalFallback(bytes.subarray(offset), fd);
      return;
    }
    waitForPipe(Math.min(5, left));
  }
}

export function logFatal(secrets, ...parts) {
  pauseFileLog();
  const notice = takeDropNotice();
  try {
    flushFileLog();
  } catch (error) {
    if (!isAgain(error)) throw error;
  }
  const fd = fileLogFd == null ? process.stderr.fd : fileLogFd;
  const deadline = Date.now() + FATAL_RETRY_MS;
  writeFatalLine(fd, notice, deadline);
  writeFatalLine(fd, stampLine(formatParts(secrets, parts)) + "\n", deadline);
}

// Node writes a regular file with writeSync. On the Apple runner those
// writes were the multi-second event-loop gaps: the lag line went out
// through console.error, the write blocked, and the next tick logged a
// longer gap. An async stream on the same fd keeps the bytes in that
// file and returns before the kernel finishes.
// A stalled pipe used to keep every line. One run queued 303 MB in 3s.
// Past this cap, further lines are dropped and one notice is written.
export const FILE_LOG_CAP = 1024 * 1024;
const DROP_NOTICE_RESERVE = 96;

export function installFileLog(fd = process.stderr.fd, options = {}) {
  const cap = Number(options.cap) > 0 ? Number(options.cap) : FILE_LOG_CAP;
  const previous = console.error;
  const previousFd = fileLogFd;
  const previousStream = fileLogStream;
  const previousPending = fileLogPending;
  const previousPendingBytes = fileLogPendingBytes;
  const previousNotice = takeDropNotice;
  const previousFallback = fatalFallbackDir;
  fileLogFd = fd;
  setPending([]);
  if (options.fallbackDir) fatalFallbackDir = path.resolve(String(options.fallbackDir));
  const highWaterMark = Math.min(16 * 1024, Math.max(1024, Math.floor(cap / 2)));
  const stream = createWriteStream("", { fd, autoClose: false, highWaterMark });
  stream.on("error", () => {});
  fileLogStream = stream;
  let dropped = 0;
  let announced = false;

  function noticeText() {
    return stampLine(dropped + " lines dropped") + "\n";
  }

  function announce() {
    if (announced || dropped === 0) return;
    const text = noticeText();
    const size = Buffer.byteLength(text);
    if (heldLogBytes(stream) + size > cap) return;
    announced = true;
    const line = { text, size };
    rememberPending(line);
    stream.write(text, () => forgetPending(line));
  }

  // A fatal exit cannot wait for drain. The notice is written after the
  // queued lines and before the fatal line, even when the cap is full.
  takeDropNotice = () => {
    if (announced || dropped === 0) return "";
    announced = true;
    return noticeText();
  };

  stream.on("drain", announce);
  const end = stream.end;
  stream.end = function endAndNote(...args) {
    announce();
    return end.apply(stream, args);
  };

  console.error = (...args) => {
    const text = formatWithOptions({ colors: false }, ...args) + "\n";
    const size = Buffer.byteLength(text);
    const reserve = announced ? 0 : DROP_NOTICE_RESERVE;
    if (heldLogBytes(stream) + size + reserve > cap) {
      dropped += 1;
      return;
    }
    const line = { text, size };
    rememberPending(line);
    stream.write(text, () => forgetPending(line));
  };

  return {
    stream,
    get dropped() {
      return dropped;
    },
    get held() {
      return fileLogPendingBytes;
    },
    restore() {
      console.error = previous;
      fileLogFd = previousFd;
      fileLogStream = previousStream;
      fileLogPending = previousPending;
      fileLogPendingBytes = previousPendingBytes;
      takeDropNotice = previousNotice;
      fatalFallbackDir = previousFallback;
    },
  };
}
