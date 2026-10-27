#!/usr/bin/env node
// The note writer refuses a link. Nothing is written through it.
// These checks call the writer directly, in both save modes.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isNotePlanFolder, noteSaveStyle, reportRecoveryFiles, writeNoteText } from "./editor/note-save.mjs";
import { createExclusive, openCheckedDirectory, unlinkIfSame, unlinkOpenedFile } from "./editor/dirfd.mjs";
import { ensureRecoverExcluded, isRecoverPath } from "./editor/vault-exclude.mjs";

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
    for (const backend of ["proc", "helper"]) {
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
  const recheckAt = place.indexOf("recheckParents");
  assert(checkedAt !== -1 && writeAt !== -1 && checkedAt < writeAt, "the opened file is checked before the first byte");
  assert(recoveryAt !== -1 && recheckAt > recoveryAt && recheckAt < writeAt, "parents are rechecked after the recovery file and before the first byte");
  assert(place.includes("restoreOpened"), "a failed write does not put the previous text back");
  assert(place.includes("expectFile"), "the opened file is not compared with the vault file");
  assert(fn.includes("parents: seen"), "the server passes the parent chain into the save");
});

if (process.exitCode) process.exit(process.exitCode);
console.log("save-path-test ok");
