#!/usr/bin/env node
// The note writer refuses a link. Nothing is written through it.
// These checks call the writer directly, in both save modes.
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
});

if (process.exitCode) process.exit(process.exitCode);
console.log("save-path-test ok");
