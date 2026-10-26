#!/usr/bin/env node
// The note writer refuses a link. Nothing is written through it.
// These checks call the writer directly, in both save modes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNotePlanFolder, noteSaveStyle, writeNoteText } from "./editor/note-save.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

async function rejects(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected a refusal");
}

function check(name, run) {
  return Promise.resolve()
    .then(run)
    .then(() => console.log("pass  " + name))
    .catch((err) => {
      console.log("FAIL  " + name + "  " + (err && err.message || err));
      process.exitCode = 1;
    });
}

const shapes = [
  ["iCloud", ["iCloud~co~noteplan~NotePlan3", "Documents", "log", "day.md"]],
  ["Containers", ["Library", "Containers", "co.noteplan.NotePlan3", "Data", "Documents", "log", "day.md"]],
  ["iCloud Setapp", ["iCloud~co~noteplan~NotePlan-setapp", "Documents", "log", "day.md"]],
  ["Containers Setapp", ["Library", "Containers", "co.noteplan.NotePlan-setapp", "Data", "Documents", "log", "day.md"]],
];

await check("real NotePlan paths save in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-np-"));
  for (const [label, parts] of shapes) {
    const file = path.join(dir, ...parts);
    assert(isNotePlanFolder(file), label + " was not recognized");
    assert(noteSaveStyle(file, true) === "in-place", label + " allowed swap-in");
    const style = await writeNoteText(file, "one\n", { style: "swap-in", swapInRequested: true });
    assert(style === "in-place", label + " style " + style);
    const inode = fs.statSync(file).ino;
    const again = await writeNoteText(file, "two\n", { style: "swap-in", swapInRequested: true });
    assert(again === "in-place", label + " again " + again);
    assert(fs.statSync(file).ino === inode, label + " replaced the file");
    assert(fs.readFileSync(file, "utf8") === "two\n", label + " text");
  }
  const upper = path.join(dir, "Library", "Containers", "CO.NotePlan.NotePlan3", "Data", "day.md");
  assert(isNotePlanFolder(upper), "the match is case-insensitive");
  assert(!isNotePlanFolder(path.join(dir, "NotePlan", "log", "day.md")), "a folder named NotePlan counted");
  assert(!isNotePlanFolder(path.join(dir, "co.noteplan", "day.md")), "the container prefix needs its dot");
  assert(!isNotePlanFolder(path.join(dir, "iCloud~co~noteplan", "day.md")), "the iCloud prefix needs its tilde");

  const real = path.join(dir, "iCloud~co~noteplan~NotePlan3", "Documents");
  const link = path.join(dir, "linked-vault");
  fs.symlinkSync(real, link);
  assert(isNotePlanFolder(path.join(link, "log", "day.md")), "realpath of the vault");

  const plain = path.join(dir, "plain", "day.md");
  assert(!isNotePlanFolder(plain), "a plain folder was treated as NotePlan");
  assert(noteSaveStyle(plain, true, { AIDANOS_VAULT_KIND: "noteplan" }) === "in-place", "vault kind");
  const forced = await writeNoteText(plain, "one\n", {
    style: "swap-in",
    swapInRequested: true,
    env: { AIDANOS_VAULT_KIND: "noteplan" },
  });
  assert(forced === "in-place", forced);
  const inode = fs.statSync(plain).ino;
  const forcedAgain = await writeNoteText(plain, "two\n", {
    style: "swap-in",
    swapInRequested: true,
    env: { AIDANOS_VAULT_KIND: "NotePlan" },
  });
  assert(forcedAgain === "in-place", forcedAgain);
  assert(fs.statSync(plain).ino === inode, "vault kind replaced the file");
  assert(fs.readFileSync(plain, "utf8") === "two\n", "vault kind text");
});

function attack(name, setup) {
  return check(name, async () => {
    for (const swapInRequested of [false, true]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-atk-"));
      const vault = path.join(dir, "vault");
      fs.mkdirSync(vault);
      const ctx = setup(dir, vault);
      const error = await rejects(() => writeNoteText(ctx.note, "pwned\n", {
        swapInRequested,
        style: "swap-in",
      }));
      assert(error && error.code === "BAD_PATH", "mode " + swapInRequested + " " + (error && error.message));
      ctx.assertUntouched();
      const names = fs.readdirSync(path.dirname(ctx.note));
      assert(!names.some((entry) => entry.includes(".tmp")), "a temp file was left behind");
    }
  });
}

await attack("a note linked at .git/config is refused", (_dir, vault) => {
  fs.mkdirSync(path.join(vault, ".git"));
  const config = path.join(vault, ".git", "config");
  fs.writeFileSync(config, "original\n");
  const note = path.join(vault, "note.md");
  fs.symlinkSync(config, note);
  return {
    note,
    assertUntouched() {
      assert(fs.readFileSync(config, "utf8") === "original\n", "config was written");
      assert(fs.lstatSync(note).isSymbolicLink(), "the link was replaced");
    },
  };
});

await attack("a dangling link does not create a hook", (_dir, vault) => {
  const hook = path.join(vault, ".git", "hooks", "post-commit");
  fs.mkdirSync(path.dirname(hook), { recursive: true });
  const note = path.join(vault, "note.md");
  fs.symlinkSync(hook, note);
  return {
    note,
    assertUntouched() {
      assert(!fs.existsSync(hook), "post-commit was created");
    },
  };
});

await attack("a dangling link does not create an outside file", (dir, vault) => {
  const outside = path.join(dir, "outside-missing.md");
  const note = path.join(vault, "note.md");
  fs.symlinkSync(outside, note);
  return {
    note,
    assertUntouched() {
      assert(!fs.existsSync(outside), "the outside file was created");
    },
  };
});

await attack("a log note linked outside is refused", (dir, vault) => {
  const outside = path.join(dir, "outside.md");
  fs.writeFileSync(outside, "keep\n");
  const note = path.join(vault, "log", "2026-10-25.md");
  fs.mkdirSync(path.dirname(note), { recursive: true });
  fs.symlinkSync(outside, note);
  return {
    note,
    assertUntouched() {
      assert(fs.readFileSync(outside, "utf8") === "keep\n", "the outside file was written");
      assert(fs.lstatSync(note).isSymbolicLink(), "the log link was replaced");
    },
  };
});

await check("a link swapped in before the write is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-race-"));
  const secret = path.join(dir, "secret.txt");
  fs.writeFileSync(secret, "SECRET\n");

  const note = path.join(dir, "note.md");
  await writeNoteText(note, "one\n", { swapInRequested: false });
  const error = await rejects(() => writeNoteText(note, "pwned\n", {
    swapInRequested: false,
    style: "swap-in",
    async beforeOpen() {
      fs.unlinkSync(note);
      fs.symlinkSync(secret, note);
    },
  }));
  assert(error.code === "BAD_PATH", error.message);
  assert(fs.readFileSync(secret, "utf8") === "SECRET\n", "in-place wrote the secret");
  assert(fs.lstatSync(note).isSymbolicLink(), "in-place replaced the link");

  const swapped = path.join(dir, "swap.md");
  await writeNoteText(swapped, "one\n", { swapInRequested: true });
  const renamed = await rejects(() => writeNoteText(swapped, "pwned\n", {
    swapInRequested: true,
    async beforeRename() {
      fs.unlinkSync(swapped);
      fs.symlinkSync(secret, swapped);
    },
  }));
  assert(renamed.code === "BAD_PATH", renamed.message);
  assert(fs.readFileSync(secret, "utf8") === "SECRET\n", "swap-in wrote the secret");
  assert(fs.lstatSync(swapped).isSymbolicLink(), "swap-in replaced the link");
  assert(!fs.readdirSync(dir).some((entry) => entry.includes(".tmp")), "a temp file was left behind");
});

await check("beforeRename can stop a swap-in", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-rename-"));
  const note = path.join(dir, "note.md");
  await writeNoteText(note, "one\n", { swapInRequested: true });
  const inode = fs.statSync(note).ino;
  let ran = false;
  const error = await rejects(() => writeNoteText(note, "two\n", {
    swapInRequested: true,
    beforeRename() {
      ran = true;
      throw new Error("recheck");
    },
  }));
  assert(ran, "beforeRename did not run");
  assert(error.message === "recheck", error.message);
  assert(fs.readFileSync(note, "utf8") === "one\n", "the note changed");
  assert(fs.statSync(note).ino === inode, "the file was replaced");
  assert(!fs.readdirSync(dir).some((entry) => entry.includes(".tmp")), "a temp file was left behind");
});

await check("a hard link to an outside file is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-hard-"));
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "keep\n");
  const note = path.join(dir, "notes", "day.md");
  fs.mkdirSync(path.dirname(note));
  fs.linkSync(outside, note);
  const error = await rejects(() => writeNoteText(note, "pwned\n", { swapInRequested: false, style: "swap-in" }));
  assert(error.code === "BAD_PATH", error.message);
  assert(fs.readFileSync(outside, "utf8") === "keep\n", "the outside file was written");
  assert(fs.readFileSync(note, "utf8") === "keep\n", "the note was written");
  assert(fs.statSync(note).nlink > 1, "the hard link was replaced");
});

await check("a file that appears before create is left alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-excl-"));
  const note = path.join(dir, "day.md");
  const error = await rejects(() => writeNoteText(note, "pwned\n", {
    swapInRequested: false,
    beforeOpen() {
      fs.writeFileSync(note, "kept\n");
    },
  }));
  assert(error.code === "BAD_PATH", error.message);
  assert(fs.readFileSync(note, "utf8") === "kept\n", "the new file was overwritten");
});

await check("a fifo named as a note is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-fifo-"));
  const note = path.join(dir, "day.md");
  execFileSync("mkfifo", [note]);
  const error = await rejects(() => writeNoteText(note, "pwned\n", { swapInRequested: false }));
  assert(error.code === "BAD_PATH", error.message);
  assert(fs.lstatSync(note).isFIFO(), "the fifo was replaced");

  const raced = path.join(dir, "raced.md");
  await writeNoteText(raced, "original\n", { swapInRequested: false });
  const racedError = await rejects(() => writeNoteText(raced, "pwned\n", {
    swapInRequested: false,
    beforeOpen() {
      fs.unlinkSync(raced);
      execFileSync("mkfifo", [raced]);
    },
  }));
  assert(racedError.code === "BAD_PATH", racedError.message);
  assert(fs.lstatSync(raced).isFIFO(), "the swapped fifo was replaced");
});

await check("a failure before any byte leaves the existing note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-fail-"));
  const note = path.join(dir, "day.md");
  await writeNoteText(note, "original-text\n", { swapInRequested: false });
  const inode = fs.statSync(note).ino;
  const error = await rejects(() => writeNoteText(note, "new\n", {
    swapInRequested: false,
    failWrite() {
      throw new Error("disk full");
    },
  }));
  assert(error.message === "disk full", error.message);
  assert(fs.readFileSync(note, "utf8") === "original-text\n", "the note was emptied");
  assert(fs.statSync(note).ino === inode, "the note was replaced");
});

await check("a write that fails partway puts the original text back", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-partial-"));
  const note = path.join(dir, "day.md");
  await writeNoteText(note, "original-text\n", { swapInRequested: false });
  const inode = fs.statSync(note).ino;
  const error = await rejects(() => writeNoteText(note, "NEW-TEXT-THAT-DIFFERS\n", {
    swapInRequested: false,
    failAfterBytes: 4,
  }));
  assert(error.message === "write failed", error.message);
  assert(fs.readFileSync(note, "utf8") === "original-text\n", "a partial write left mixed text");
  assert(fs.statSync(note).ino === inode, "a partial write replaced the note");
});

await check("an empty env overlay keeps the vault kind", async () => {
  const previous = process.env.AIDANOS_VAULT_KIND;
  process.env.AIDANOS_VAULT_KIND = "noteplan";
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-env-"));
    const file = path.join(dir, "plain", "day.md");
    const style = await writeNoteText(file, "one\n", {
      env: {},
      style: "swap-in",
      swapInRequested: true,
    });
    assert(style === "in-place", style);
    const inode = fs.statSync(file).ino;
    const again = await writeNoteText(file, "two\n", { env: {}, swapInRequested: true });
    assert(again === "in-place", again);
    assert(fs.statSync(file).ino === inode, "the overlay replaced the file");
    assert(fs.readFileSync(file, "utf8") === "two\n", "the new text was dropped");
  } finally {
    if (previous === undefined) delete process.env.AIDANOS_VAULT_KIND;
    else process.env.AIDANOS_VAULT_KIND = previous;
  }
});

await check("writeVaultText in NotePlan mode keeps the note and its new text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-vault-text-"));
  const vault = path.join(dir, "vault");
  fs.mkdirSync(vault);
  const previous = {
    vault: process.env.AIDANOS_VAULT,
    kind: process.env.AIDANOS_VAULT_KIND,
    git: process.env.AIDANOS_VAULT_GIT_URL,
  };
  process.env.AIDANOS_VAULT = vault;
  process.env.AIDANOS_VAULT_KIND = "noteplan";
  process.env.AIDANOS_VAULT_GIT_URL = "";
  try {
    const { writeVaultText } = await import("./server.mjs");
    await writeVaultText("notes/day.md", "old\n");
    const file = path.join(vault, "notes", "day.md");
    const inode = fs.statSync(file).ino;
    await writeVaultText("notes/day.md", "new text\n");
    assert(fs.statSync(file).ino === inode, "the note was replaced");
    assert(fs.readFileSync(file, "utf8") === "new text\n", "the new text was not saved");
    const outside = path.join(dir, "outside.md");
    fs.writeFileSync(outside, "outside-secret\n");
    fs.symlinkSync(outside, path.join(vault, "notes", "link.md"));
    await rejects(() => writeVaultText("notes/link.md", "through-link\n"));
    assert(fs.readFileSync(outside, "utf8") === "outside-secret\n", "a linked save wrote the target");
    assert(fs.lstatSync(path.join(vault, "notes", "link.md")).isSymbolicLink(), "the link was replaced");
    fs.linkSync(file, path.join(vault, "notes", "hard.md"));
    await rejects(() => writeVaultText("notes/hard.md", "through-hard\n"));
    assert(fs.readFileSync(file, "utf8") === "new text\n", "a hard link save changed the note");
    assert(fs.statSync(file).nlink > 1, "the hard link was replaced");
    const pipe = path.join(vault, "notes", "pipe.md");
    execFileSync("mkfifo", [pipe]);
    await rejects(() => writeVaultText("notes/pipe.md", "through-fifo\n"));
    assert(fs.lstatSync(pipe).isFIFO(), "the fifo was replaced");
    fs.mkdirSync(path.join(vault, "notes", "folder.md"));
    let folderMessage = "";
    try {
      await writeVaultText("notes/folder.md", "into-folder\n");
    } catch (error) {
      folderMessage = error && error.message;
    }
    assert(folderMessage === "not a file", "a folder target said " + folderMessage);
    assert(fs.lstatSync(path.join(vault, "notes", "folder.md")).isDirectory(), "the folder was replaced");
    assert(fs.readFileSync(file, "utf8") === "new text\n", "a refused save emptied the note");
  } finally {
    if (previous.vault === undefined) delete process.env.AIDANOS_VAULT;
    else process.env.AIDANOS_VAULT = previous.vault;
    if (previous.kind === undefined) delete process.env.AIDANOS_VAULT_KIND;
    else process.env.AIDANOS_VAULT_KIND = previous.kind;
    if (previous.git === undefined) delete process.env.AIDANOS_VAULT_GIT_URL;
    else process.env.AIDANOS_VAULT_GIT_URL = previous.git;
  }
});

await check("the server passes beforeRename into the save", async () => {
  const src = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  const start = src.indexOf("async function atomicWriteFile");
  const end = src.indexOf("function atomicWriteDay", start);
  const fn = src.slice(start, end);
  assert(fn.includes("beforeRename"), "beforeRename was dropped");
  assert(fn.includes("writeNoteText"), "the save no longer goes through the note writer");
  const save = fs.readFileSync(path.join(root, "editor", "note-save.mjs"), "utf8");
  const renameAt = save.indexOf("fs.rename");
  const hookAt = save.lastIndexOf("beforeRename", renameAt);
  assert(hookAt !== -1 && hookAt < renameAt, "beforeRename does not sit before rename");
  const placeStart = save.indexOf("async function writeInPlace");
  const placeEnd = save.indexOf("async function writeSwapIn", placeStart);
  const place = save.slice(placeStart, placeEnd);
  const checkedAt = place.indexOf("afterOpen");
  const writeAt = place.indexOf("writeOpened");
  assert(checkedAt !== -1 && writeAt !== -1 && checkedAt < writeAt, "the opened file is checked before the first byte");
  assert(place.includes("restoreOpened"), "a failed write does not put the previous text back");
  assert(place.includes("expectFile"), "the opened file is not compared with the vault file");
});

if (process.exitCode) process.exit(process.exitCode);
console.log("save-path-test ok");
