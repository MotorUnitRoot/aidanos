import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import * as Automerge from "@automerge/automerge";
import { writeNoteText } from "../../editor/note-save.mjs";
import { noteMirror } from "./index-trace.mjs";
import { logSafe } from "./redact.mjs";
import { prepareNoteFile, safeNotePath } from "./paths.mjs";

function yieldNow() {
  return new Promise((resolve) => setImmediate(resolve));
}

function plainDoc(doc) {
  try {
    return JSON.parse(JSON.stringify(doc));
  } catch {
    return null;
  }
}

function noteText(doc) {
  const plain = plainDoc(doc);
  if (!plain || plain.kind !== "note") return null;
  if (typeof plain.text === "string") return plain.text;
  if (plain.text == null) return "";
  return null;
}

function changes(before, after) {
  const oldText = String(before);
  const newText = String(after);
  let prefix = 0;
  const limit = Math.min(oldText.length, newText.length);
  while (prefix < limit && oldText[prefix] === newText[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < oldText.length - prefix &&
    suffix < newText.length - prefix &&
    oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const oldMid = oldText.slice(prefix, oldText.length - suffix);
  const newMid = newText.slice(prefix, newText.length - suffix);
  if (!oldMid && !newMid) return [];
  if (oldMid && newMid.includes(oldMid)) {
    const at = newMid.indexOf(oldMid);
    const edits = [];
    if (at > 0) edits.push({ start: prefix, delete: 0, insert: newMid.slice(0, at) });
    const tail = newMid.slice(at + oldMid.length);
    if (tail) edits.push({ start: prefix + oldMid.length, delete: 0, insert: tail });
    return edits;
  }
  if (newMid && oldMid.includes(newMid)) {
    const at = oldMid.indexOf(newMid);
    const edits = [];
    if (at > 0) edits.push({ start: prefix, delete: at, insert: "" });
    const tail = oldMid.length - (at + newMid.length);
    if (tail > 0) edits.push({ start: prefix + at + newMid.length, delete: tail, insert: "" });
    return edits;
  }
  return [{ start: prefix, delete: oldMid.length, insert: newMid }];
}

function mapEdit(edit, remotes) {
  let delta = 0;
  for (const remote of remotes) {
    if (remote.start + remote.delete < edit.start) delta += remote.insert.length - remote.delete;
  }
  return { start: edit.start + delta, delete: edit.delete, insert: edit.insert };
}

function sameEdit(left, right) {
  return left.start === right.start && left.delete === right.delete && left.insert === right.insert;
}

function applyEdits(text, edits) {
  let result = text;
  let shift = 0;
  for (const edit of edits) {
    const start = Math.max(0, Math.min(result.length, edit.start + shift));
    const del = Math.max(0, Math.min(edit.delete, result.length - start));
    result = result.slice(0, start) + edit.insert + result.slice(start + del);
    shift += edit.insert.length - del;
  }
  return result;
}

function spliceToward(doc, next) {
  const current = typeof doc.text === "string" ? doc.text : "";
  if (current === next) return;
  let prefix = 0;
  const limit = Math.min(current.length, next.length);
  while (prefix < limit && current[prefix] === next[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < next.length - prefix &&
    current[current.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const del = current.length - prefix - suffix;
  const insert = next.slice(prefix, next.length - suffix);
  Automerge.splice(doc, ["text"], prefix, del, insert);
}

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function createMirror({ repo, vault, debounceMs = 400, secrets = [] }) {
  const lastWritten = new Map();
  const incorporated = new Map();
  let records = null;
  let timer = null;
  let chain = Promise.resolve();
  const recordFile = path.join(vault, ".aidanos", "written.json");

  async function hashes() {
    if (records) return records;
    try {
      const parsed = JSON.parse(await fs.readFile(recordFile, "utf8"));
      records = parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      records = {};
    }
    return records;
  }

  async function saveHashes() {
    const body = JSON.stringify(records || {});
    await fs.mkdir(path.dirname(recordFile), { recursive: true });
    await writeNoteText(recordFile, body, { swapInRequested: false, vaultRoot: vault });
  }

  function indexPaths() {
    const paths = {};
    for (const handle of Object.values(repo.handles)) {
      let doc;
      try {
        doc = handle.doc();
      } catch {
        continue;
      }
      const plain = plainDoc(doc);
      if (!plain || plain.kind !== "index" || !plain.paths || typeof plain.paths !== "object") continue;
      for (const [notePath, docId] of Object.entries(plain.paths)) {
        if (typeof docId === "string" && safeNotePath(notePath)) paths[notePath] = docId;
      }
    }
    return paths;
  }

  async function foldOutside() {
    const known = await hashes();
    const paths = indexPaths();
    for (const [notePath, docId] of Object.entries(paths)) {
      await yieldNow();
      const handle = repo.handles[docId];
      if (!handle) continue;
      const file = await prepareNoteFile(vault, notePath);
      if (!file) continue;
      let fileText;
      try {
        fileText = await fs.readFile(file, "utf8");
      } catch {
        continue;
      }
      const fileHash = digest(fileText);
      if (incorporated.get(notePath) === fileHash) continue;
      if (known[notePath] === fileHash) {
        lastWritten.set(notePath, fileText);
        incorporated.set(notePath, fileHash);
        continue;
      }
      if (lastWritten.get(notePath) === fileText) {
        incorporated.set(notePath, fileHash);
        continue;
      }
      let current;
      try {
        current = noteText(handle.doc());
      } catch {
        continue;
      }
      if (current == null || current === fileText) {
        lastWritten.set(notePath, fileText);
        known[notePath] = fileHash;
        incorporated.set(notePath, fileHash);
        continue;
      }
      try {
        // The file is compared with the last text this relay wrote. Only that
        // difference is applied, so a device edit that arrived in the same
        // moment stays in the history instead of being replaced by the file.
        const baseline = lastWritten.has(notePath) ? lastWritten.get(notePath) : current;
        const docEdits = changes(baseline, current);
        const fileEdits = changes(baseline, fileText).filter(
          (edit) => !docEdits.some((other) => sameEdit(edit, other)),
        );
        const merged = applyEdits(current, fileEdits.map((edit) => mapEdit(edit, docEdits)));
        if (merged !== current) {
          handle.change((doc) => {
            if (typeof doc.text !== "string") doc.text = "";
            spliceToward(doc, merged);
          });
        }
        lastWritten.set(notePath, merged);
        incorporated.set(notePath, fileHash);
      } catch (error) {
        logSafe(secrets, "fold-in failed for", notePath, error instanceof Error ? error.message : error);
      }
      await yieldNow();
    }
  }

  async function writeNotes() {
    const known = await hashes();
    const paths = indexPaths();
    let changed = false;
    for (const [notePath, docId] of Object.entries(paths)) {
      await yieldNow();
      const handle = repo.handles[docId];
      if (!handle) continue;
      let text;
      try {
        text = noteText(handle.doc());
      } catch {
        continue;
      }
      if (text == null) continue;
      const file = await prepareNoteFile(vault, notePath);
      if (!file) {
        const candidate = path.join(vault, ...notePath.split("/"));
        try {
          const info = await fs.lstat(candidate);
          if (info.isSymbolicLink()) logSafe(secrets, "mirror write refused", notePath);
        } catch {
          // A missing file is not a refusal. The path itself was unsafe.
        }
        await yieldNow();
        continue;
      }
      let existing = null;
      try {
        existing = await fs.readFile(file, "utf8");
      } catch {
        existing = null;
      }
      if (existing === text) {
        lastWritten.set(notePath, text);
        if (known[notePath] !== digest(text)) {
          known[notePath] = digest(text);
          changed = true;
        }
        await yieldNow();
        continue;
      }
      try {
        await writeNoteText(file, text, { swapInRequested: false, vaultRoot: vault });
      } catch {
        logSafe(secrets, "mirror write refused", notePath);
        await yieldNow();
        continue;
      }
      lastWritten.set(notePath, text);
      known[notePath] = digest(text);
      changed = true;
      await yieldNow();
    }
    if (changed) await saveHashes();
  }

  async function syncDisk() {
    chain = chain.then(async () => {
      const started = performance.now();
      try {
        await foldOutside();
        await writeNotes();
      } finally {
        noteMirror(performance.now() - started);
      }
    }).catch((error) => {
      logSafe(secrets, "mirror failed:", error instanceof Error ? error.message : error);
    });
    return chain;
  }

  function schedule() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      syncDisk();
    }, debounceMs);
    if (timer.unref) timer.unref();
  }

  const poll = setInterval(schedule, Math.max(debounceMs, 200));
  if (poll.unref) poll.unref();

  return {
    schedule,
    async now() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      await syncDisk();
    },
    // Wait for a write that has already started. Does not start another one.
    async idle() {
      await chain;
    },
    stop() {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
