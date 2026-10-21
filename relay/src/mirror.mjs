import fs from "node:fs/promises";
import path from "node:path";
import * as Automerge from "@automerge/automerge";
import { logSafe } from "./redact.mjs";

function safePath(notePath) {
  const parts = String(notePath || "").split("/");
  if (!parts.length || parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts.join("/");
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

export function createMirror({ repo, vault, debounceMs = 400, secrets = [] }) {
  const lastWritten = new Map();
  let timer = null;
  let chain = Promise.resolve();

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
        if (typeof docId === "string" && safePath(notePath)) paths[notePath] = docId;
      }
    }
    return paths;
  }

  async function foldOutside() {
    const paths = indexPaths();
    for (const [notePath, docId] of Object.entries(paths)) {
      const handle = repo.handles[docId];
      if (!handle) continue;
      const file = path.join(vault, ...notePath.split("/"));
      let fileText;
      try {
        fileText = await fs.readFile(file, "utf8");
      } catch {
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
        continue;
      }
      try {
        handle.change((doc) => {
          if (doc.text == null) doc.text = "";
          Automerge.updateText(doc, ["text"], fileText);
        });
        lastWritten.set(notePath, fileText);
      } catch (error) {
        logSafe(secrets, "fold-in failed for", notePath, error instanceof Error ? error.message : error);
      }
    }
  }

  async function writeNotes() {
    const paths = indexPaths();
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
      const file = path.join(vault, ...notePath.split("/"));
      let existing = null;
      try {
        existing = await fs.readFile(file, "utf8");
      } catch {
        existing = null;
      }
      if (existing === text) {
        lastWritten.set(notePath, text);
        continue;
      }
      await fs.mkdir(path.dirname(file), { recursive: true });
      const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.tmp`);
      await fs.writeFile(tmp, text);
      await fs.rename(tmp, file);
      lastWritten.set(notePath, text);
    }
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
