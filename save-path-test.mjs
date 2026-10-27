#!/usr/bin/env node
// The note writer refuses a link. Nothing is written through it.
// These checks call the writer directly, in both save modes.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNotePlanFolder, noteSaveStyle, reportRecoveryFiles, writeNoteText } from "./editor/note-save.mjs";
import { aclListingFault, ancestorFault, createExclusive, directoryBackend, groupWritableHelperMessage, installFaultText, openCheckedDirectory, unlinkIfSame, unlinkOpenedFile } from "./editor/dirfd.mjs";
import { ensureRecoverExcluded, isRecoverPath } from "./editor/vault-exclude.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
if (!process.env.NODE_ENV) process.env.NODE_ENV = "test";

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
  assert(!fs.readdirSync(dir).some((entry) => entry.endsWith(".recover")), "a successful restore left the recovery file");
});

await check("a new file created through a swapped parent is removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-create-"));
  const notes = path.join(dir, "notes");
  const outside = path.join(dir, "outside");
  const real = path.join(dir, "notes-real");
  fs.mkdirSync(notes);
  fs.mkdirSync(outside);
  const note = path.join(notes, "page.md");
  const error = await rejects(() => writeNoteText(note, "NEW\n", {
    swapInRequested: false,
    beforeOpen() {
      fs.renameSync(notes, real);
      fs.symlinkSync(outside, notes);
    },
    afterOpen() {
      const refused = new Error("parent changed");
      refused.code = "PARENT";
      throw refused;
    },
  }));
  assert(error.code === "PARENT", error.message);
  assert(!fs.existsSync(path.join(outside, "page.md")), "an empty file was left outside");
  assert(!fs.existsSync(path.join(real, "page.md")), "the create landed in the real folder");
});

await check("a failed restore keeps the recovery file and logs its name", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-recover-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, "day.md");
  await writeNoteText(note, "original-text\n", { swapInRequested: false, vaultRoot: vault });
  assert(!fs.readdirSync(notes).some((entry) => entry.endsWith(".recover")), "a successful save left the recovery file");
  const logged = [];
  const previous = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const error = await rejects(() => writeNoteText(note, "NEW-TEXT-THAT-DIFFERS\n", {
      swapInRequested: false,
      vaultRoot: vault,
      failAfterBytes: 4,
      failRestore() {
        throw new Error("restore failed");
      },
    }));
    assert(error.message === "write failed", error.message);
  } finally {
    console.error = previous;
  }
  const recovery = fs.readdirSync(notes).filter((entry) => entry.endsWith(".recover"));
  assert(recovery.length === 1, "the recovery file was removed or duplicated: " + recovery.join(","));
  assert(fs.readFileSync(path.join(notes, recovery[0]), "utf8") === "original-text\n", "the recovery file is not the old text");
  assert(fs.readFileSync(note, "utf8").startsWith("NEW-"), "the failed restore rewrote the note");
  const line = logged.find((entry) => entry.startsWith("restore failed: "));
  assert(line === "restore failed: notes/" + recovery[0], "restore log was " + logged.join(" | "));
  assert(!line.includes(dir), "restore log included a filesystem path");
});

await check("a parent swapped after the recovery file is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-recover-swap-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  const outside = path.join(dir, "outside");
  const real = path.join(dir, "notes-real");
  fs.mkdirSync(notes, { recursive: true });
  fs.mkdirSync(outside);
  const note = path.join(notes, "page.md");
  await writeNoteText(note, "original\n", { swapInRequested: false, vaultRoot: vault });
  const error = await rejects(() => writeNoteText(note, "pwned\n", {
    swapInRequested: false,
    vaultRoot: vault,
    afterRecovery() {
      fs.renameSync(notes, real);
      fs.symlinkSync(outside, notes);
    },
  }));
  assert(error.code === "BAD_PATH", error.code + " " + error.message);
  assert(fs.readdirSync(outside).length === 0, "a recovery file was left outside: " + fs.readdirSync(outside).join(","));
  assert(fs.readFileSync(path.join(real, "page.md"), "utf8") === "original\n", "the note changed");
  assert(!fs.readdirSync(real).some((entry) => entry.endsWith(".recover")), "the recovery file stayed in the vault");
});

await check("a failed sync keeps the recovery file and logs its path", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-sync-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, "day.md");
  await writeNoteText(note, "original-text\n", { swapInRequested: false, vaultRoot: vault });
  const logged = [];
  const previous = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    const error = await rejects(() => writeNoteText(note, "NEW-TEXT\n", {
      swapInRequested: false,
      vaultRoot: vault,
      failSync() {
        throw new Error("sync failed");
      },
    }));
    assert(error.message === "sync failed", error.message);
  } finally {
    console.error = previous;
  }
  const recovery = fs.readdirSync(notes).filter((entry) => entry.endsWith(".recover"));
  assert(recovery.length === 1, "the recovery file was removed: " + recovery.join(","));
  assert(fs.readFileSync(path.join(notes, recovery[0]), "utf8") === "original-text\n", "the recovery file is not the old text");
  const line = logged.find((entry) => entry.startsWith("sync failed: "));
  assert(line === "sync failed: notes/" + recovery[0], "sync log was " + logged.join(" | "));
  assert(!line.includes(dir), "sync log included a filesystem path");
});

await check("startup lists a leftover recovery file and leaves it in place", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-startup-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const recovery = path.join(notes, "day.md.leftover.recover");
  fs.writeFileSync(recovery, "only copy\n");
  fs.symlinkSync(notes, path.join(vault, "linked"));
  const logged = [];
  const found = await reportRecoveryFiles(vault, (line) => logged.push(line));
  assert(found.length === 1 && found[0] === "notes/day.md.leftover.recover", found.join(","));
  assert(logged[0] === "recovery file: notes/day.md.leftover.recover", logged.join(" | "));
  assert(fs.readFileSync(recovery, "utf8") === "only copy\n", "startup removed the only copy");
});

await check("a recovery name is removed only when it is still the created file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-unlinkat-"));
  const folder = await openCheckedDirectory(dir);
  try {
    const backends = process.platform === "linux" ? ["proc", "helper"] : ["helper"];
    for (const backend of backends) {
      const name = backend + ".recover";
      const created = await createExclusive(folder, name, Buffer.from("old\n"), backend);
      const kept = path.join(dir, name + ".kept");
      fs.renameSync(path.join(dir, name), kept);
      fs.writeFileSync(path.join(dir, name), "other\n");
      const removed = await unlinkIfSame(folder, name, created, backend);
      assert(removed === false, backend + " unlinked a different file");
      assert(fs.readFileSync(path.join(dir, name), "utf8") === "other\n", backend + " replaced the other file");
      assert(fs.readFileSync(kept, "utf8") === "old\n", backend + " removed the created file by the new name");
      const removedKept = await unlinkIfSame(folder, name + ".kept", created, backend);
      assert(removedKept === true, backend + " left the created file");
      assert(!fs.existsSync(kept), backend + " did not unlink the created inode");
    }
  } finally {
    await folder.close();
  }
});

await check("the vault repo excludes a recovery file from status", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-exclude-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "aidanos@local"], { cwd: dir, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "AidanOS"], { cwd: dir, stdio: "ignore" });
  fs.writeFileSync(path.join(dir, "day.md"), "today\n");
  fs.writeFileSync(path.join(dir, "day.md.1.abc.recover"), "secret\n");
  await ensureRecoverExcluded(dir);
  const exclude = fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8");
  assert(exclude.split(/\r?\n/).some((line) => line.trim() === "*.recover"), exclude);
  const status = execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: dir, encoding: "utf8" });
  assert(status.includes("day.md"), status);
  assert(!status.includes(".recover"), status);
  assert(isRecoverPath("notes/day.md.1.abc.recover") === true);
  assert(isRecoverPath("notes/day.md") === false);
});

await check("the opened inode is removed through the directory descriptor", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-opened-"));
  const file = path.join(dir, "page.md");
  fs.writeFileSync(file, "created\n");
  const handle = await fs.promises.open(file, "r+");
  try {
    fs.renameSync(file, file + ".kept");
    fs.writeFileSync(file, "other\n");
    const removed = await unlinkOpenedFile(handle, "helper");
    assert(removed === true, "the opened inode was left behind");
    assert(fs.readFileSync(file, "utf8") === "other\n", "a different file was removed");
    assert(!fs.existsSync(file + ".kept"), "the opened inode is still linked");
  } finally {
    await handle.close();
  }
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
  const recoveryAt = place.indexOf("createExclusive");
  const helperAt = place.indexOf("openDirectoryHelper");
  const openAt = place.indexOf("fs.open");
  const recheckAt = place.indexOf("recheckParents");
  assert(helperAt !== -1 && openAt !== -1 && helperAt < openAt, "the helper is not checked before the note is created");
  assert((place.match(/openDirectoryHelper/g) || []).length === 1, "the helper is opened more than once per save");
  assert(place.includes("{ tool }"), "the recovery file does not reuse the checked handle");
  assert((place.match(/, tool\)/g) || []).length >= 3, "later helper calls do not reuse the checked handle");
  const helperSrc = fs.readFileSync(path.join(root, "editor", "dirfd.mjs"), "utf8");
  const callStart = helperSrc.indexOf("function callHelper");
  const callEnd = helperSrc.indexOf("async function createWithHelper");
  const call = helperSrc.slice(callStart, callEnd);
  assert(call.includes("borrowed ? Promise.resolve(borrowed) : openTrustedHelper()"), "a borrowed handle is opened again");
  assert(call.includes("if (borrowed)"), "a borrowed handle is closed after one call");
  assert(checkedAt !== -1 && writeAt !== -1 && checkedAt < writeAt, "the opened file is checked before the first byte");
  assert(recoveryAt !== -1 && recheckAt > recoveryAt && recheckAt < writeAt, "parents are rechecked after the recovery file and before the first byte");
  assert(place.includes("restoreOpened"), "a failed write does not put the previous text back");
  assert(place.includes("expectFile"), "the opened file is not compared with the vault file");
  assert(fn.includes("parents: seen"), "the server passes the parent chain into the save");
});

function shippedHelper() {
  const osName = process.platform === "linux" ? "linux" : process.platform === "darwin" ? "darwin" : "";
  const arch = process.arch === "x64" || process.arch === "arm64" ? process.arch : "";
  return path.join(root, "editor", "bin", "dirfd-tool-" + osName + "-" + arch);
}

async function withHelperEnv(extra, run) {
  const keys = ["AIDANOS_DIRFD_TOOL", "AIDANOS_DIRFD_BACKEND", "AIDANOS_DIRFD_FAIL_AFTER"];
  const prev = {};
  for (const key of keys) prev[key] = process.env[key];
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, extra);
  try {
    return await run();
  } finally {
    for (const key of keys) {
      if (prev[key] === undefined) delete process.env[key];
      else process.env[key] = prev[key];
    }
  }
}

await check("the directory helper is pinned and is not built at runtime", async () => {
  const src = fs.readFileSync(path.join(root, "editor", "dirfd.mjs"), "utf8");
  assert(!src.includes("compileHelper"), "the server still compiles a helper");
  assert(!src.includes('spawn("cc"'), "the server still runs cc");
  assert(!src.includes("tmpdir"), "the server still caches a helper in the temp directory");
  const shipped = shippedHelper();
  assert(fs.existsSync(shipped), "the pinned helper is missing: " + path.basename(shipped));
  const digest = createHash("sha256").update(fs.readFileSync(shipped)).digest("hex");
  assert(src.includes(digest), "the source pin does not match the shipped helper");
  const mode = fs.statSync(shipped).mode & 0o777;
  assert((mode & 0o022) === 0, "the shipped helper is group or world writable");
});

await check("the directory helper reads no environment and only its arguments", async () => {
  const c = fs.readFileSync(path.join(root, "editor", "dirfd-tool.c"), "utf8");
  assert(!/\bgetenv\b/.test(c), "the helper calls getenv");
  assert(!/\benviron\b/.test(c), "the helper reads environ");
  const js = fs.readFileSync(path.join(root, "editor", "dirfd.mjs"), "utf8");
  assert(js.includes("env: {}"), "the helper inherits the process environment");
  assert(!js.includes('"/dev/fd/4"'), "macOS still executes /dev/fd");
  assert(js.includes('"/proc/self/fd/4"'), "Linux does not execute the checked descriptor");
  assert(js.includes("tool.path"), "macOS does not recheck the helper path");
  const shipped = shippedHelper();
  const symbols = execFileSync("nm", ["-u", shipped], { encoding: "utf8" });
  assert(!symbols.includes("getenv"), "the shipped helper references getenv");
  assert(!/\benviron\b/.test(symbols), "the shipped helper references environ");
  function status(args) {
    return spawnSync(shipped, args, { encoding: "utf8" }).status;
  }
  assert(status(["creat"]) === 2, "a short command ran");
  assert(status(["creat", "name", "0", "extra"]) === 2, "creat accepted an extra argument");
  assert(status(["creat", "name", "-1"]) === 2, "creat accepted a negative limit");
  assert(status(["stat", "name", "extra"]) === 2, "stat accepted an extra argument");
  assert(status(["unlink", "name", "1", "2", "extra"]) === 2, "unlink accepted an extra argument");
  assert(status(["unlink-self", "name"]) === 2, "unlink-self accepted a name");
  assert(status(["nope", "name"]) === 2, "an unknown command ran");
});

await check("a planted, replaced, or writable helper is refused", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-tool-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-tool-vault-"));
  const marker = path.join(dir, "marker");
  const planted = path.join(dir, "planted");
  fs.writeFileSync(planted, "#!/bin/sh\nprintf pwned > '" + marker + "'\n");
  fs.chmodSync(planted, 0o755);
  const folder = await openCheckedDirectory(vault);
  try {
    const plantedError = await withHelperEnv({ AIDANOS_DIRFD_TOOL: planted, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      rejects(() => createExclusive(folder, "planted.recover", Buffer.from("x\n"), "helper")));
    assert(plantedError.code === "DIRFD", plantedError.code + " " + plantedError.message);
    assert(plantedError.message === "directory helper unavailable", plantedError.message);
    assert(!fs.existsSync(marker), "a planted helper ran");
    assert(!fs.existsSync(path.join(vault, "planted.recover")), "a planted helper created a file");

    const copy = path.join(dir, "copy");
    fs.copyFileSync(shippedHelper(), copy);
    fs.chmodSync(copy, 0o755);
    await withHelperEnv({ AIDANOS_DIRFD_TOOL: copy, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      createExclusive(folder, "ok.recover", Buffer.from("ok\n"), "helper"));
    assert(fs.readFileSync(path.join(vault, "ok.recover"), "utf8") === "ok\n", "a trusted copy did not run");
    fs.rmSync(path.join(vault, "ok.recover"));
    fs.rmSync(copy);
    fs.symlinkSync(planted, copy);
    const linked = await withHelperEnv({ AIDANOS_DIRFD_TOOL: copy, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      rejects(() => createExclusive(folder, "linked.recover", Buffer.from("x\n"), "helper")));
    assert(linked.code === "DIRFD", linked.code);
    assert(!fs.existsSync(marker), "a replaced symlink helper ran");
    assert(!fs.existsSync(path.join(vault, "linked.recover")), "a symlink helper created a file");
    fs.unlinkSync(copy);

    fs.copyFileSync(shippedHelper(), copy);
    fs.chmodSync(copy, 0o666);
    const writableFile = await withHelperEnv({ AIDANOS_DIRFD_TOOL: copy, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      rejects(() => createExclusive(folder, "mode.recover", Buffer.from("x\n"), "helper")));
    assert(writableFile.code === "DIRFD", writableFile.code);
    assert(!fs.existsSync(path.join(vault, "mode.recover")), "a group-writable helper ran");

    fs.chmodSync(copy, 0o755);
    fs.chmodSync(dir, 0o777);
    const writableDir = await withHelperEnv({ AIDANOS_DIRFD_TOOL: copy, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      rejects(() => createExclusive(folder, "dir.recover", Buffer.from("x\n"), "helper")));
    assert(writableDir.code === "DIRFD", writableDir.code);
    assert(!fs.existsSync(path.join(vault, "dir.recover")), "a helper in a writable folder ran");
    fs.chmodSync(dir, 0o700);

    const again = await withHelperEnv({ AIDANOS_DIRFD_TOOL: copy, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      createExclusive(folder, "again.recover", Buffer.from("again\n"), "helper"));
    assert(again && fs.readFileSync(path.join(vault, "again.recover"), "utf8") === "again\n", "a refused helper stayed refused");
  } finally {
    await folder.close();
  }
});

await check("a helper EEXIST or ELOOP is a bad path and leaves the file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-eexist-"));
  const outside = path.join(dir, "outside.txt");
  fs.writeFileSync(outside, "outside-secret\n");
  const folder = await openCheckedDirectory(dir);
  try {
    const created = await createExclusive(folder, "note.recover", Buffer.from("kept\n"), "helper");
    const again = await rejects(() => createExclusive(folder, "note.recover", Buffer.from("other\n"), "helper"));
    assert(again.code === "BAD_PATH" && again.message === "bad path", again.code + " " + again.message);
    assert(fs.readFileSync(path.join(dir, "note.recover"), "utf8") === "kept\n", "the second create replaced the file");
    assert(created.ino === String(fs.statSync(path.join(dir, "note.recover")).ino), "the original inode was replaced");
    fs.symlinkSync(outside, path.join(dir, "link.recover"));
    const loop = await rejects(() => createExclusive(folder, "link.recover", Buffer.from("pwned\n"), "helper"));
    assert(loop.code === "BAD_PATH" && loop.message === "bad path", loop.code + " " + loop.message);
    assert(fs.readFileSync(outside, "utf8") === "outside-secret\n", "a symlink create wrote the target");
    assert(fs.lstatSync(path.join(dir, "link.recover")).isSymbolicLink(), "the symlink was replaced");
  } finally {
    await folder.close();
  }
});

await check("a partial recovery file is removed", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-partial-helper-"));
  const folder = await openCheckedDirectory(dir);
  try {
    const empty = await rejects(() => createExclusive(folder, "empty.recover", Buffer.from("hello\n"), "helper", { failAfterBytes: 0 }));
    assert(empty.code === "EIO", empty.code);
    assert(!fs.existsSync(path.join(dir, "empty.recover")), "a create that failed immediately left a file");
    const mid = await rejects(() => createExclusive(folder, "mid.recover", Buffer.from("hello\n"), "helper", { failAfterBytes: 2 }));
    assert(mid.code === "EIO", mid.code);
    assert(!fs.existsSync(path.join(dir, "mid.recover")), "a short write left a recovery file");
    process.env.AIDANOS_DIRFD_FAIL_AFTER = "0";
    try {
      const created = await createExclusive(folder, "kept.recover", Buffer.from("safe\n"), "helper");
      assert(fs.readFileSync(path.join(dir, "kept.recover"), "utf8") === "safe\n", "an inherited fail-after broke the save");
      await unlinkIfSame(folder, "kept.recover", created, "helper");
    } finally {
      delete process.env.AIDANOS_DIRFD_FAIL_AFTER;
    }
  } finally {
    await folder.close();
  }
});

await check("a failure after the recovery file removes that file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-after-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, "day.md");
  const backends = process.platform === "linux" ? [undefined, "helper"] : ["helper"];
  for (const backend of backends) {
    await writeNoteText(note, "original-text\n", { swapInRequested: false, vaultRoot: vault });
    const error = await withHelperEnv(backend ? { AIDANOS_DIRFD_BACKEND: backend } : {}, () => rejects(() => writeNoteText(note, "NEW\n", {
      swapInRequested: false,
      vaultRoot: vault,
      afterRecovery() {
        throw new Error("after recovery");
      },
    })));
    assert(error.message === "after recovery", error.message);
    assert(!fs.readdirSync(notes).some((entry) => entry.endsWith(".recover")), backend + " left a recovery file");
    assert(fs.readFileSync(note, "utf8") === "original-text\n", backend + " changed the note");
  }
});

await check("an untrusted helper answers 503 and the server stays up", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-http-helper-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, "day.md");
  fs.writeFileSync(note, "original-text\n");
  const marker = path.join(dir, "marker");
  const planted = path.join(dir, "planted-tool");
  fs.writeFileSync(planted, "#!/bin/sh\nprintf pwned > '" + marker + "'\n");
  fs.chmodSync(planted, 0o755);
  const port = 33000 + Math.floor(Math.random() * 2000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PORT: String(port),
      AIDANOS_HOST: "127.0.0.1",
      AIDANOS_VAULT: vault,
      AIDANOS_VAULT_KIND: "noteplan",
      AIDANOS_VAULT_GIT_URL: "",
      AIDANOS_VAULT_GIT_TOKEN: "",
      AIDANOS_VAULT_GIT_RETRY_MS: "0",
      AIDANOS_DIRFD_BACKEND: "helper",
      AIDANOS_DIRFD_TOOL: planted,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (buf) => { log += String(buf); });
  child.stderr.on("data", (buf) => { log += String(buf); });
  const base = "http://127.0.0.1:" + port;
  try {
    const deadline = Date.now() + 12000;
    let up = false;
    while (Date.now() < deadline) {
      if (child.exitCode != null) throw new Error("server exited " + child.exitCode + " " + log);
      try {
        const health = await fetch(base + "/api/health");
        if (health.ok) { up = true; break; }
      } catch { /* not listening yet */ }
      await new Promise((r) => setTimeout(r, 80));
    }
    assert(up, "health did not come up " + log);
    const saved = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/day.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "pwned\n" }),
    });
    const body = await saved.json();
    assert(saved.status === 503, "status " + saved.status + " " + JSON.stringify(body) + " " + log);
    assert(body.error === "directory helper unavailable", JSON.stringify(body));
    assert(child.exitCode == null, "the server exited after a refused helper");
    assert(fs.readFileSync(note, "utf8") === "original-text\n", "the refused save changed the note");
    assert(!fs.existsSync(marker), "the planted helper ran");
    assert(!fs.readdirSync(notes).some((entry) => entry.endsWith(".recover")), "a refused save left a recovery file");
    const again = await fetch(base + "/api/file?path=" + encodeURIComponent("notes/day.md"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markdown: "pwned-again\n" }),
    });
    assert(again.status === 503, "the second save did not check the helper again");
    const health = await fetch(base + "/api/health");
    assert(health.status === 200, "health failed after the refusal");
    assert(child.exitCode == null, "the server exited after the second refusal");
    assert(!log.includes(planted), "the refusal logged the helper path");
  } finally {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
    const stopBy = Date.now() + 2000;
    while (child.exitCode == null && Date.now() < stopBy) await new Promise((r) => setTimeout(r, 40));
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
});

function chownTo(user, target) {
  return spawnSync("chown", [String(user), target], { encoding: "utf8" }).status === 0;
}

function stickyParent() {
  const fromEnv = os.tmpdir();
  try {
    const st = fs.statSync(fromEnv);
    if (st.isDirectory() && st.uid === 0 && (st.mode & 0o1000) !== 0) return fromEnv;
  } catch {
    // TMPDIR is not a sticky root directory. The real /tmp is the one path
    // that still has to be checked, because macOS reaches it through a symlink.
  }
  return "/tmp";
}

function chownOther(target) {
  return chownTo("nobody", target);
}

await check("a helper under a bad ancestor is refused, and /tmp is allowed", async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-ancestor-"));
  const vault = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-ancestor-vault-"));
  const folder = await openCheckedDirectory(vault);
  const writable = path.join(base, "group");
  const writableBin = path.join(writable, "bin");
  fs.mkdirSync(writableBin, { recursive: true });
  const writableTool = path.join(writableBin, "dirfd-tool");
  fs.copyFileSync(shippedHelper(), writableTool);
  fs.chmodSync(writableTool, 0o755);
  fs.chmodSync(writableBin, 0o755);
  fs.chmodSync(writable, 0o775);
  const owned = path.join(base, "owned");
  const ownedBin = path.join(owned, "bin");
  fs.mkdirSync(ownedBin, { recursive: true });
  const ownedTool = path.join(ownedBin, "dirfd-tool");
  fs.copyFileSync(shippedHelper(), ownedTool);
  fs.chmodSync(ownedTool, 0o755);
  fs.chmodSync(ownedBin, 0o755);
  fs.chmodSync(owned, 0o755);
  const gave = chownOther(owned);
  let sticky = "";
  try {
    assert(ancestorFault(writable) === "ancestor-writable", ancestorFault(writable));
    assert(installFaultText("ancestor-writable") === "group-writable ancestor", installFaultText("ancestor-writable"));
    const writableError = await withHelperEnv({ AIDANOS_DIRFD_TOOL: writableTool, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      rejects(() => createExclusive(folder, "group.recover", Buffer.from("x\n"), "helper")));
    assert(writableError.code === "DIRFD" && writableError.reason === "ancestor-writable", writableError.reason || writableError.code);
    assert(!fs.existsSync(path.join(vault, "group.recover")), "a group-writable ancestor ran the helper");

    if (!gave) {
      console.log("skip  ancestor owned by another user: chown nobody failed without sudo");
    } else {
      assert(ancestorFault(owned) === "ancestor-owner", ancestorFault(owned));
      const ownedError = await withHelperEnv({ AIDANOS_DIRFD_TOOL: ownedTool, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
        rejects(() => createExclusive(folder, "owned.recover", Buffer.from("x\n"), "helper")));
      assert(ownedError.code === "DIRFD" && ownedError.reason === "ancestor-owner", ownedError.reason || ownedError.code);
      assert(!fs.existsSync(path.join(vault, "owned.recover")), "an ancestor owned by another user ran the helper");
    }

    const real = path.join(base, "real");
    const via = path.join(base, "via");
    fs.mkdirSync(path.join(real, "child"), { recursive: true });
    fs.symlinkSync(real, via);
    assert(ancestorFault(path.join(via, "child")) === "ancestor", "a user-owned symlink ancestor was allowed");

    const stickyRoot = stickyParent();
    if (stickyRoot === "/tmp") {
      const tmpReal = fs.statSync("/tmp");
      assert(tmpReal.isDirectory() && tmpReal.uid === 0 && (tmpReal.mode & 0o1000) !== 0, "/tmp is not a sticky root directory");
    }
    sticky = fs.mkdtempSync(path.join(stickyRoot, "aidanos-sticky-"));
    const stickyTool = path.join(sticky, "dirfd-tool");
    fs.copyFileSync(shippedHelper(), stickyTool);
    fs.chmodSync(stickyTool, 0o755);
    assert(ancestorFault(sticky) === "", ancestorFault(sticky) || "sticky ancestor was refused");
    await withHelperEnv({ AIDANOS_DIRFD_TOOL: stickyTool, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
      createExclusive(folder, "sticky.recover", Buffer.from("ok\n"), "helper"));
    assert(fs.readFileSync(path.join(vault, "sticky.recover"), "utf8") === "ok\n", "a sticky root ancestor was refused");
  } finally {
    await folder.close();
    if (gave) chownTo(process.getuid(), owned);
    fs.chmodSync(writable, 0o755);
    fs.rmSync(base, { recursive: true, force: true });
    fs.rmSync(vault, { recursive: true, force: true });
    if (sticky) fs.rmSync(sticky, { recursive: true, force: true });
  }
});

await check("a refused helper does not leave a new note", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-empty-note-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const planted = path.join(bin, "planted");
  fs.writeFileSync(planted, "#!/bin/sh\nprintf pwned\n");
  fs.chmodSync(planted, 0o755);
  const cases = [];
  cases.push(["planted", planted, () => {}]);
  const linked = path.join(bin, "linked");
  fs.symlinkSync(planted, linked);
  cases.push(["symlink", linked, () => {}]);
  const mode = path.join(bin, "mode");
  fs.copyFileSync(shippedHelper(), mode);
  fs.chmodSync(mode, 0o666);
  cases.push(["writable-file", mode, () => {}]);
  const wide = path.join(dir, "wide");
  fs.mkdirSync(wide);
  const wideTool = path.join(wide, "tool");
  fs.copyFileSync(shippedHelper(), wideTool);
  fs.chmodSync(wideTool, 0o755);
  fs.chmodSync(wide, 0o777);
  cases.push(["writable-dir", wideTool, () => fs.chmodSync(wide, 0o755)]);
  cases.push(["missing", path.join(bin, "missing"), () => {}]);
  const ancestor = path.join(dir, "ancestor");
  const ancestorBin = path.join(ancestor, "bin");
  fs.mkdirSync(ancestorBin, { recursive: true });
  const ancestorTool = path.join(ancestorBin, "tool");
  fs.copyFileSync(shippedHelper(), ancestorTool);
  fs.chmodSync(ancestorTool, 0o755);
  fs.chmodSync(ancestorBin, 0o755);
  fs.chmodSync(ancestor, 0o775);
  cases.push(["ancestor", ancestorTool, () => fs.chmodSync(ancestor, 0o755)]);
  const foreign = path.join(dir, "foreign");
  fs.mkdirSync(foreign);
  const foreignTool = path.join(foreign, "tool");
  fs.copyFileSync(shippedHelper(), foreignTool);
  fs.chmodSync(foreignTool, 0o755);
  const foreignOk = chownOther(foreignTool);
  if (foreignOk) cases.push(["owner", foreignTool, () => {}]);
  else console.log("skip  helper owned by another user: chown nobody failed without sudo");
  assert(cases.length === (foreignOk ? 7 : 6), "refusal cases were " + cases.length);
  try {
    for (const [name, tool, cleanup] of cases) {
      const note = path.join(dir, name + ".md");
      const error = await withHelperEnv({ AIDANOS_DIRFD_TOOL: tool, AIDANOS_DIRFD_BACKEND: "helper" }, () =>
        rejects(() => writeNoteText(note, "NEW\n", { swapInRequested: false })));
      assert(error.code === "DIRFD", name + " " + error.code + " " + (error.reason || ""));
      assert(!fs.existsSync(note), name + " left a note");
      cleanup();
    }
  } finally {
    if (foreignOk) chownTo(process.getuid(), foreignTool);
    fs.chmodSync(wide, 0o755);
    fs.chmodSync(ancestor, 0o755);
  }
});

await check("a cleanup miss logs the recovery file and the save still succeeds", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-cleanup-"));
  const vault = path.join(dir, "vault");
  const notes = path.join(vault, "notes");
  fs.mkdirSync(notes, { recursive: true });
  const note = path.join(notes, "day.md");
  await writeNoteText(note, "original-text\n", { swapInRequested: false, vaultRoot: vault });
  const logged = [];
  const previous = console.error;
  console.error = (...args) => logged.push(args.join(" "));
  try {
    await writeNoteText(note, "NEW-TEXT\n", {
      swapInRequested: false,
      vaultRoot: vault,
      beforeCleanup() {
        const name = fs.readdirSync(notes).find((entry) => entry.endsWith(".recover"));
        fs.renameSync(path.join(notes, name), path.join(notes, name + ".kept"));
        fs.writeFileSync(path.join(notes, name), "other\n");
      },
    });
  } finally {
    console.error = previous;
  }
  assert(fs.readFileSync(note, "utf8") === "NEW-TEXT\n", "the saved note was rolled back");
  const kept = fs.readdirSync(notes).filter((entry) => entry.endsWith(".recover.kept"));
  assert(kept.length === 1, "the old recovery text was removed: " + fs.readdirSync(notes).join(","));
  assert(fs.readFileSync(path.join(notes, kept[0]), "utf8") === "original-text\n", "the kept file is not the old text");
  const line = logged.find((entry) => entry.startsWith("cleanup failed: "));
  const recovery = kept[0].slice(0, -".kept".length);
  assert(line === "cleanup failed: notes/" + recovery, "cleanup log was " + logged.join(" | "));
  assert(!line.includes(dir), "cleanup log included a filesystem path");

  fs.rmSync(path.join(notes, recovery));
  fs.rmSync(path.join(notes, kept[0]));
  await writeNoteText(note, "original-text\n", { swapInRequested: false, vaultRoot: vault });
  const loggedThrow = [];
  console.error = (...args) => loggedThrow.push(args.join(" "));
  try {
    fs.chmodSync(notes, 0o755);
    await writeNoteText(note, "AFTER\n", {
      swapInRequested: false,
      vaultRoot: vault,
      beforeCleanup() {
        fs.chmodSync(notes, 0o555);
      },
    });
  } finally {
    fs.chmodSync(notes, 0o755);
    console.error = previous;
  }
  assert(fs.readFileSync(note, "utf8") === "AFTER\n", "a cleanup error failed the save");
  const left = fs.readdirSync(notes).filter((entry) => entry.endsWith(".recover"));
  assert(left.length === 1, "a helper cleanup error removed the recovery file");
  assert(fs.readFileSync(path.join(notes, left[0]), "utf8") === "original-text\n", "the kept recovery file is not the old text");
  const thrown = loggedThrow.find((entry) => entry.startsWith("cleanup failed: "));
  assert(thrown === "cleanup failed: notes/" + left[0], "throwing cleanup log was " + loggedThrow.join(" | "));
  assert(!thrown.includes(dir), "throwing cleanup log included a filesystem path");
});

await check("directory helper overrides are ignored outside tests", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-env-helper-"));
  const marker = path.join(dir, "marker");
  const planted = path.join(dir, "planted");
  fs.writeFileSync(planted, "#!/bin/sh\nprintf pwned > '" + marker + "'\n");
  fs.chmodSync(planted, 0o755);
  const note = path.join(dir, "day.md");
  await writeNoteText(note, "one\n", { swapInRequested: false });
  const previousNode = process.env.NODE_ENV;
  const previousTool = process.env.AIDANOS_DIRFD_TOOL;
  const previousBackend = process.env.AIDANOS_DIRFD_BACKEND;
  process.env.NODE_ENV = "production";
  process.env.AIDANOS_DIRFD_TOOL = planted;
  process.env.AIDANOS_DIRFD_BACKEND = "helper";
  try {
    assert(directoryBackend() === (process.platform === "linux" ? "proc" : "helper"), directoryBackend());
    await writeNoteText(note, "two\n", { swapInRequested: false });
  } finally {
    if (previousNode === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNode;
    if (previousTool === undefined) delete process.env.AIDANOS_DIRFD_TOOL;
    else process.env.AIDANOS_DIRFD_TOOL = previousTool;
    if (previousBackend === undefined) delete process.env.AIDANOS_DIRFD_BACKEND;
    else process.env.AIDANOS_DIRFD_BACKEND = previousBackend;
  }
  assert(!fs.existsSync(marker), "a planted helper ran outside tests");
  assert(fs.readFileSync(note, "utf8") === "two\n", "the real save did not run");
  assert(directoryBackend({ NODE_ENV: "test", AIDANOS_DIRFD_BACKEND: "proc" }) === "proc", "a test override was ignored");
  assert(directoryBackend({ NODE_ENV: "production", AIDANOS_DIRFD_BACKEND: "helper" }) === (process.platform === "linux" ? "proc" : "helper"), "production honored the override");
});

await check("startup reports a group-writable helper and refuses a bad install location", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-mode-msg-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "dirfd-tool-test"), "");
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(path.join(bin, "dirfd-tool-test"), 0o664);
  assert(groupWritableHelperMessage(bin) === "chmod go-w editor/bin editor/bin/dirfd-tool-*", groupWritableHelperMessage(bin));
  fs.chmodSync(path.join(bin, "dirfd-tool-test"), 0o755);
  assert(groupWritableHelperMessage(bin) === "", "a private helper asked for chmod");
  fs.chmodSync(bin, 0o775);
  assert(groupWritableHelperMessage(bin) === "chmod go-w editor/bin editor/bin/dirfd-tool-*", "a group-writable bin was quiet");
  const src = fs.readFileSync(path.join(root, "server.mjs"), "utf8");
  const boot = src.slice(src.indexOf("async function boot"), src.indexOf("function isMainModule"));
  const faultAt = boot.indexOf("ancestorFault");
  const listenAt = boot.indexOf("server.listen");
  assert(faultAt !== -1 && listenAt !== -1 && faultAt < listenAt, "startup checks the install location after listen");
  assert(boot.includes("groupWritableHelperMessage"), "startup does not check the helper mode");
  assert(boot.includes("console.error(helperMode)"), "startup does not log the helper mode fix");
  assert(boot.includes("refused: bad install location: "), "startup does not name a bad install location");
  const helperSrc = fs.readFileSync(path.join(root, "editor", "dirfd.mjs"), "utf8");
  assert(helperSrc.includes("TODO: once Developer ID signing exists"), "the code-signature TODO is missing");
});

await check("a write ACL for another principal is refused", async () => {
  const clean = [
    "drwxr-xr-x  2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    "",
  ].join("\n");
  const ownerAllow = [
    "drwxr-xr-x+ 2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    " 0: user:501 allow write,append,delete",
    "",
  ].join("\n");
  const otherAllow = [
    "drwxr-xr-x+ 2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    " 0: user:0 allow write,append,delete,delete_child",
    "",
  ].join("\n");
  const namedOther = [
    "drwxr-xr-x+ 2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    " 0: user:root allow writeattr,writesecurity,chown",
    "",
  ].join("\n");
  const readOnly = [
    "drwxr-xr-x+ 2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    " 0: group:20 allow read,readattr",
    " 1: user:0 deny write",
    "",
  ].join("\n");
  const unknown = [
    "drwxr-xr-x+ 2 501  20  64 Oct 27 03:00 /private/tmp/aidanos",
    " not an acl entry",
    "",
  ].join("\n");
  assert(aclListingFault(clean, 501, "me") === "", "a directory with no ACL was refused");
  assert(aclListingFault(ownerAllow, 501, "me") === "", "the owner's write ACL was refused");
  assert(aclListingFault(otherAllow, 501, "me") === "acl", "a write ACL for another uid was allowed");
  assert(aclListingFault(namedOther, 501, "me") === "acl", "a named write ACL for someone else was allowed");
  assert(aclListingFault(readOnly, 501, "me") === "", "a read ACL or a deny was refused");
  assert(aclListingFault(unknown, 501, "me") === "acl", "an unreadable ACL line was allowed");
  assert(installFaultText("ancestor-acl") === "an ACL grants write to someone other than the owner", installFaultText("ancestor-acl"));
  if (process.platform !== "darwin") {
    console.log("skip  live write ACL: not macOS");
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aidanos-acl-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const tool = path.join(bin, "dirfd-tool");
  fs.copyFileSync(shippedHelper(), tool);
  fs.chmodSync(tool, 0o755);
  fs.chmodSync(bin, 0o755);
  fs.chmodSync(dir, 0o755);
  const before = ancestorFault(bin);
  assert(before === "", "the temp path was already refused: " + before);
  const added = spawnSync("chmod", ["+a", "user:root allow write,append,delete,delete_child", dir], { encoding: "utf8" });
  assert(added.status === 0, "chmod +a failed: " + (added.stderr || added.error));
  try {
    assert(ancestorFault(bin) === "ancestor-acl", ancestorFault(bin) || "a write ACL for another principal was allowed");
  } finally {
    spawnSync("chmod", ["-N", dir], { encoding: "utf8" });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

if (process.exitCode) process.exit(process.exitCode);
console.log("save-path-test ok");
