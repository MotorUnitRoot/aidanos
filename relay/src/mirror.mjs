import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as Automerge from "@automerge/automerge";
import { logSafe } from "./redact.mjs";
import { prepareNoteFile, safeNotePath } from "./paths.mjs";

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

function digest(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

export function createMirror({ repo, vault, debounceMs = 400, secrets = [] }) {
  const lastWritten = new Map();
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
    const tmp = recordFile + "." + process.pid + ".tmp";
    await fs.writeFile(tmp, body);
    await fs.rename(tmp, recordFile);
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
      if (known[notePath] === digest(fileText)) {
        lastWritten.set(notePath, fileText);
        continue;
      }
      if (lastWritten.get(notePath) === fileText) continue;
      let current;
      try {
        current = noteText(handle.doc());
      } catch {
        continue;
      }
      if (current == null || current === fileText) {
        lastWritten.set(notePath, fileText);
        known[notePath] = digest(fileText);
        continue;
      }
      try {
        handle.change((doc) => {
          if (doc.text == null) doc.text = "";
          Automerge.updateText(doc, ["text"], fileText);
        });
        lastWritten.set(notePath, fileText);
        known[notePath] = digest(fileText);
      } catch (error) {
        logSafe(secrets, "fold-in failed for", notePath, error instanceof Error ? error.message : error);
      }
    }
  }

  async function writeNotes() {
    const known = await hashes();
    const paths = indexPaths();
    let changed = false;
    for (const [notePath, docId] of Object.entries(paths)) {
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
      if (!file) continue;
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
        continue;
      }
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file);
      lastWritten.set(notePath, text);
      known[notePath] = digest(text);
      changed = true;
    }
    if (changed) await saveHashes();
  }

  async function syncDisk() {
    chain = chain.then(async () => {
      await foldOutside();
      await writeNotes();
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
    stop() {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
    },
  };
}
