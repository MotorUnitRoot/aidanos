@testable import AidanCore
import Foundation
import XCTest

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

final class LiveNoteEditorTests: XCTestCase {
    func testShapesFollowTheLineReader() {
        let text = "# Harbor\n\n- [ ] Oil the latch\n- a hanging line\n* boxless task\nplain\n"
        let context = ExternalNoteContext.project
        let reading: any NoteLineReading = ExternalFormatLineReading()
        let shapes = reading.shapes(in: text, context: context)
        let note = ExternalFormatReader.read(text, in: context)
        XCTAssertEqual(shapes.count, note.lines.count)
        XCTAssertEqual(shapes.map(\.role), note.lines.map { ExternalFormatLineReading.role(for: $0.kind) })
        XCTAssertEqual(shapes.map(\.source), ["# Harbor", "", "- [ ] Oil the latch", "- a hanging line", "* boxless task", "plain"])
        XCTAssertEqual(NoteLineBreaks.joined(NoteLineBreaks.pieces(text)), text)
    }

    func testTypingKeepsEveryCharacter() {
        var editor = LiveNoteEditor()
        let typed = "Harbor lantern\n- [ ] Oil the latch\n# Evening\n"
        var built = ""
        for character in typed {
            built.append(character)
            XCTAssertEqual(editor.type(built), built)
        }
        XCTAssertEqual(editor.text, typed)
        XCTAssertEqual(editor.undo(), String(typed.dropLast()))
        XCTAssertEqual(editor.redo(), typed)
    }

    func testTickChangesTheBoxAndLeavesTheWords() {
        var editor = LiveNoteEditor(text: "Keep this\n- [ ] Oil the latch\n* later\n- [x] Sweep\n", context: .project)
        XCTAssertEqual(editor.tick(line: 1), "Keep this\n- [x] Oil the latch\n* later\n- [x] Sweep\n")
        XCTAssertEqual(editor.tick(line: 2), "Keep this\n- [x] Oil the latch\n* later\n- [x] Sweep\n")
        XCTAssertEqual(editor.tick(line: 3), "Keep this\n- [x] Oil the latch\n* later\n- [ ] Sweep\n")
        XCTAssertEqual(editor.undo(), "Keep this\n- [x] Oil the latch\n* later\n- [x] Sweep\n")
        let plain = LiveNoteEditor(text: "Just words\n")
        XCTAssertEqual(LiveNoteEditor.ticking("Just words"), "Just words")
        XCTAssertEqual(LiveNoteEditor.ticking("- [X] Count the spare bulbs"), "- [ ] Count the spare bulbs")
        XCTAssertEqual(LiveNoteEditor.ticking("- [-] cancelled words"), "- [-] cancelled words")
        XCTAssertEqual(LiveNoteEditor.ticking("- [>] scheduled words"), "- [>] scheduled words")
        XCTAssertEqual(LiveNoteEditor.checkbox("Oil the latch"), "- [ ] Oil the latch")
        XCTAssertEqual(LiveNoteEditor.checkbox("- hanging line"), "- [ ] hanging line")
        XCTAssertEqual(LiveNoteEditor.checkbox("- [ ] Oil the latch"), "- [x] Oil the latch")
        XCTAssertEqual(LiveNoteEditor.checkbox("# Harbor"), "# Harbor")
        XCTAssertEqual(plain.text, "Just words\n")
    }

    func testANotePlanFolderSavesInPlace() throws {
        let folder = try makeFolder(named: "iCloud~co~noteplan~NotePlan3")
            .appendingPathComponent("Documents", isDirectory: true)
        let file = folder.appendingPathComponent("log").appendingPathComponent("day.md")
        XCTAssertTrue(NoteFolderSave.isNotePlanFolder(file))
        XCTAssertFalse(NoteFolderSave.isNotePlanFolder(try makeFolder(named: "NotePlan").appendingPathComponent("day.md")))
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: true), .inPlace)
        setenv("AIDANOS_SAVE_SWAP_IN", "1", 1)
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        try NoteFolderSave.write(Data("one\n".utf8), to: file)
        let inode = try fileInode(file)
        try NoteFolderSave.write(Data("one\ntwo\n".utf8), to: file)
        XCTAssertEqual(try fileInode(file), inode)
        let names = try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)
        XCTAssertFalse(names.contains { $0.contains(".tmp") })
        let saved = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(saved, "one\ntwo\n")
    }

    func testRealNotePlanPathShapes() throws {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("aidanos-shapes-\(UUID().uuidString)", isDirectory: true)
        let shapes = [
            ["iCloud~co~noteplan~NotePlan3", "Documents", "log", "day.md"],
            ["Library", "Containers", "co.noteplan.NotePlan3", "Data", "Documents", "log", "day.md"],
            ["iCloud~co~noteplan~NotePlan-setapp", "Documents", "log", "day.md"],
            ["Library", "Containers", "co.noteplan.NotePlan-setapp", "Data", "Documents", "log", "day.md"],
        ]
        for parts in shapes {
            let file = parts.reduce(root) { $0.appendingPathComponent($1) }
            XCTAssertTrue(NoteFolderSave.isNotePlanFolder(file), parts.joined(separator: "/"))
            XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: true), .inPlace)
        }
        let upper = root
            .appendingPathComponent("Library")
            .appendingPathComponent("Containers")
            .appendingPathComponent("CO.NotePlan.NotePlan3")
            .appendingPathComponent("day.md")
        XCTAssertTrue(NoteFolderSave.isNotePlanFolder(upper))
        XCTAssertFalse(NoteFolderSave.isNotePlanFolder(root.appendingPathComponent("NotePlan").appendingPathComponent("day.md")))
        let real = root.appendingPathComponent("iCloud~co~noteplan~NotePlan3").appendingPathComponent("Documents")
        try FileManager.default.createDirectory(at: real, withIntermediateDirectories: true)
        let link = root.appendingPathComponent("linked-vault")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: real)
        XCTAssertTrue(NoteFolderSave.isNotePlanFolder(link.appendingPathComponent("log").appendingPathComponent("day.md")))
        let plain = root.appendingPathComponent("plain").appendingPathComponent("day.md")
        XCTAssertFalse(NoteFolderSave.isNotePlanFolder(plain))
        setenv("AIDANOS_VAULT_KIND", "noteplan", 1)
        defer { unsetenv("AIDANOS_VAULT_KIND") }
        XCTAssertEqual(NoteFolderSave.style(for: plain, swapInRequested: true), .inPlace)
    }

    func testSwapInStaysOutsideANotePlanFolder() throws {
        let folder = try makeFolder(named: "vault")
        let file = folder.appendingPathComponent("notes.md")
        XCTAssertFalse(NoteFolderSave.isNotePlanFolder(file))
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: true), .swapIn)
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: false), .inPlace)
        setenv("AIDANOS_SAVE_SWAP_IN", "1", 1)
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        try NoteFolderSave.write(Data("one\n".utf8), to: file)
        let inode = try fileInode(file)
        try NoteFolderSave.write(Data("two\n".utf8), to: file)
        XCTAssertNotEqual(try fileInode(file), inode)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "two\n")
    }

    func testInPlaceRefusesALink() throws {
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        for mode in ["0", "1"] {
            setenv("AIDANOS_SAVE_SWAP_IN", mode, 1)
            let folder = try makeFolder(named: "vault")
            let git = folder.appendingPathComponent(".git")
            let hooks = git.appendingPathComponent("hooks")
            try FileManager.default.createDirectory(at: hooks, withIntermediateDirectories: true)
            let config = git.appendingPathComponent("config")
            try Data("original\n".utf8).write(to: config)
            let linked = folder.appendingPathComponent("note.md")
            try FileManager.default.createSymbolicLink(at: linked, withDestinationURL: config)
            XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: linked))
            XCTAssertEqual(try String(contentsOf: config, encoding: .utf8), "original\n")
            let hook = hooks.appendingPathComponent("post-commit")
            let danglingHook = folder.appendingPathComponent("hook.md")
            try FileManager.default.createSymbolicLink(at: danglingHook, withDestinationURL: hook)
            XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: danglingHook))
            XCTAssertFalse(FileManager.default.fileExists(atPath: hook.path))
            let outside = folder.deletingLastPathComponent().appendingPathComponent("missing-\(mode).md")
            let danglingOut = folder.appendingPathComponent("out.md")
            try FileManager.default.createSymbolicLink(at: danglingOut, withDestinationURL: outside)
            XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: danglingOut))
            XCTAssertFalse(FileManager.default.fileExists(atPath: outside.path))
            let log = folder.appendingPathComponent("log").appendingPathComponent("2026-10-25.md")
            try FileManager.default.createDirectory(at: log.deletingLastPathComponent(), withIntermediateDirectories: true)
            let outsideLog = folder.deletingLastPathComponent().appendingPathComponent("kept-\(mode).md")
            try Data("keep\n".utf8).write(to: outsideLog)
            try FileManager.default.createSymbolicLink(at: log, withDestinationURL: outsideLog)
            XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: log))
            XCTAssertEqual(try String(contentsOf: outsideLog, encoding: .utf8), "keep\n")
        }
    }

    func testASwappedLinkIsRefused() throws {
        let folder = try makeFolder(named: "vault")
        let secret = folder.appendingPathComponent("secret.txt")
        try Data("SECRET\n".utf8).write(to: secret)
        let note = folder.appendingPathComponent("note.md")
        setenv("AIDANOS_SAVE_SWAP_IN", "0", 1)
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        try NoteFolderSave.write(Data("one\n".utf8), to: note)
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("pwned\n".utf8), to: note, beforeOpen: {
            try? FileManager.default.removeItem(at: note)
            try? FileManager.default.createSymbolicLink(at: note, withDestinationURL: secret)
        }))
        XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "SECRET\n")
        let swapped = folder.appendingPathComponent("swap.md")
        try Data("one\n".utf8).write(to: swapped)
        XCTAssertThrowsError(try AtomicFile.write(Data("pwned\n".utf8), to: swapped, beforeRename: {
            try FileManager.default.removeItem(at: swapped)
            try FileManager.default.createSymbolicLink(at: swapped, withDestinationURL: secret)
        }))
        XCTAssertEqual(try String(contentsOf: secret, encoding: .utf8), "SECRET\n")
        XCTAssertTrue(NoteFolderSave.isSymbolicLink(swapped.path))
    }

    func testInPlaceRefusesAHardLink() throws {
        let folder = try makeFolder(named: "notes")
        let outside = folder.deletingLastPathComponent().appendingPathComponent("outside.txt")
        try Data("keep\n".utf8).write(to: outside)
        let note = folder.appendingPathComponent("day.md")
        try FileManager.default.linkItem(at: outside, to: note)
        setenv("AIDANOS_SAVE_SWAP_IN", "0", 1)
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: note))
        XCTAssertEqual(try String(contentsOf: outside, encoding: .utf8), "keep\n")
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "keep\n")
    }

    func testInPlaceRefusesAFifo() throws {
        let folder = try makeFolder(named: "notes")
        let note = folder.appendingPathComponent("day.md")
        let made = note.path.withCString { mkfifo($0, S_IRUSR | S_IWUSR) }
        XCTAssertEqual(made, 0)
        setenv("AIDANOS_SAVE_SWAP_IN", "0", 1)
        defer { unsetenv("AIDANOS_SAVE_SWAP_IN") }
        XCTAssertThrowsError(try NoteFolderSave.write(Data("pwned\n".utf8), to: note))
    }

    func testCreateRefusesAFileThatAppearsFirst() throws {
        let folder = try makeFolder(named: "notes")
        let note = folder.appendingPathComponent("fresh.md")
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("pwned\n".utf8), to: note, beforeOpen: {
            FileManager.default.createFile(atPath: note.path, contents: Data("kept\n".utf8))
        }))
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "kept\n")
    }

    func testAFailedWriteLeavesTheExistingNote() throws {
        let folder = try makeFolder(named: "notes")
        let note = folder.appendingPathComponent("day.md")
        try NoteFolderSave.writeInPlace(Data("original-text\n".utf8), to: note)
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("new\n".utf8), to: note, beforeWrite: {
            throw AidanError.io("disk full")
        }))
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "original-text\n")
    }

    func testAPartialWriteRestoresTheOriginalText() throws {
        let folder = try makeFolder(named: "notes")
        let note = folder.appendingPathComponent("day.md")
        try NoteFolderSave.writeInPlace(Data("original-text\n".utf8), to: note)
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(
            Data("NEW-TEXT-THAT-DIFFERS\n".utf8),
            to: note,
            failAfterBytes: 4
        ))
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "original-text\n")
        let leftovers = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        XCTAssertFalse(leftovers.contains { $0.lastPathComponent.hasSuffix(".recover") })
    }

    func testACreatedFileIsRemovedWhenTheParentCheckFails() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("page.md")
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let real = root.appendingPathComponent("notes-real")
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("NEW\n".utf8), to: note, beforeOpen: {
            try? FileManager.default.moveItem(at: notes, to: real)
            try? FileManager.default.createSymbolicLink(at: notes, withDestinationURL: outside)
        }))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("page.md").path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: real.appendingPathComponent("page.md").path))
    }

    func testAFailedRestoreKeepsTheRecoveryFile() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("day.md")
        try NoteFolderSave.writeInPlace(Data("original-text\n".utf8), to: note, vaultRoot: root)
        let quiet = try FileManager.default.contentsOfDirectory(at: notes, includingPropertiesForKeys: nil)
        XCTAssertFalse(quiet.contains { $0.lastPathComponent.hasSuffix(".recover") })
        var logged = ""
        let previous = NoteFolderSave.logRestoreFailure
        NoteFolderSave.logRestoreFailure = { logged = $0 }
        defer { NoteFolderSave.logRestoreFailure = previous }
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(
            Data("NEW-TEXT-THAT-DIFFERS\n".utf8),
            to: note,
            failAfterBytes: 4,
            failRestore: { throw AidanError.io("restore failed") },
            vaultRoot: root
        ))
        let recovery = try FileManager.default.contentsOfDirectory(at: notes, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(".recover") }
        XCTAssertEqual(recovery.count, 1)
        XCTAssertEqual(try String(contentsOf: recovery[0], encoding: .utf8), "original-text\n")
        XCTAssertTrue(try String(contentsOf: note, encoding: .utf8).hasPrefix("NEW-"))
        XCTAssertEqual(logged, "notes/\(recovery[0].lastPathComponent)")
        XCTAssertFalse(logged.contains(root.path))
    }

    func testASwappedParentAfterTheRecoveryFileIsRefused() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("page.md")
        try Data("original\n".utf8).write(to: note)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let real = root.appendingPathComponent("notes-real")
        let located = try VaultPaths.locate(vault: root, path: "notes/page.md")
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(
            Data("pwned\n".utf8),
            to: note,
            afterRecovery: {
                try? FileManager.default.moveItem(at: notes, to: real)
                try? FileManager.default.createSymbolicLink(at: notes, withDestinationURL: outside)
            },
            parents: located.parents,
            vaultRoot: root
        ))
        let outsideNames = try FileManager.default.contentsOfDirectory(at: outside, includingPropertiesForKeys: nil)
        XCTAssertTrue(outsideNames.isEmpty)
        XCTAssertEqual(try String(contentsOf: real.appendingPathComponent("page.md"), encoding: .utf8), "original\n")
        let leftovers = try FileManager.default.contentsOfDirectory(at: real, includingPropertiesForKeys: nil)
        XCTAssertFalse(leftovers.contains { $0.lastPathComponent.hasSuffix(".recover") })
    }

    func testAFailedSyncKeepsTheRecoveryFile() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("day.md")
        try NoteFolderSave.writeInPlace(Data("original-text\n".utf8), to: note, vaultRoot: root)
        var logged = ""
        let previous = NoteFolderSave.logSyncFailure
        NoteFolderSave.logSyncFailure = { logged = $0 }
        defer { NoteFolderSave.logSyncFailure = previous }
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(
            Data("NEW-TEXT\n".utf8),
            to: note,
            failSync: true,
            vaultRoot: root
        ))
        let recovery = try FileManager.default.contentsOfDirectory(at: notes, includingPropertiesForKeys: nil)
            .filter { $0.lastPathComponent.hasSuffix(".recover") }
        XCTAssertEqual(recovery.count, 1)
        XCTAssertEqual(try String(contentsOf: recovery[0], encoding: .utf8), "original-text\n")
        XCTAssertEqual(logged, "notes/\(recovery[0].lastPathComponent)")
        XCTAssertFalse(logged.contains(root.path))
    }

    func testStartupReportsALeftoverRecoveryFile() throws {
        let vault = try makeFolder(named: "vault")
        let notes = vault.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let recovery = notes.appendingPathComponent("day.md.leftover.recover")
        try Data("only copy\n".utf8).write(to: recovery)
        var logged: [String] = []
        let previous = AidanSession.logRecoveryFile
        AidanSession.logRecoveryFile = { logged.append($0) }
        defer { AidanSession.logRecoveryFile = previous }
        _ = try AidanSession(vault: vault)
        XCTAssertEqual(logged, ["notes/day.md.leftover.recover"])
        XCTAssertEqual(try String(contentsOf: recovery, encoding: .utf8), "only copy\n")
    }

    func testTheVaultWalkIsRecheckedFromTheRoot() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("page.md")
        try Data("original text\n".utf8).write(to: note)
        let located = try VaultPaths.locate(vault: root, path: "notes/page.md")
        XCTAssertEqual(located.parents.count, 2)
        XCTAssertEqual(located.url.path, note.path)
        let stale = NoteFolderSave.DirectoryIdentity(path: located.parents[0].path, dev: 0, ino: 0)
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(
            Data("pwned\n".utf8),
            to: located.url,
            parents: [stale, located.parents[1]]
        ))
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "original text\n")
        try NoteFolderSave.writeInPlace(Data("saved\n".utf8), to: located.url, parents: located.parents, vaultRoot: root)
        XCTAssertEqual(try String(contentsOf: note, encoding: .utf8), "saved\n")
        let leftovers = try FileManager.default.contentsOfDirectory(at: notes, includingPropertiesForKeys: nil)
        XCTAssertFalse(leftovers.contains { $0.lastPathComponent.hasSuffix(".recover") })
    }

    func testSwappedParentDoesNotWriteTheOutsideFile() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("page.md")
        try Data("original text\n".utf8).write(to: note)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let outsideNote = outside.appendingPathComponent("page.md")
        try Data("outside-original\n".utf8).write(to: outsideNote)
        let real = root.appendingPathComponent("notes-real")
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("SWAPPED_SECRET\n".utf8), to: note, beforeOpen: {
            try? FileManager.default.moveItem(at: notes, to: real)
            try? FileManager.default.createSymbolicLink(at: notes, withDestinationURL: outside)
        }))
        XCTAssertEqual(try String(contentsOf: real.appendingPathComponent("page.md"), encoding: .utf8), "original text\n")
        XCTAssertEqual(try String(contentsOf: outsideNote, encoding: .utf8), "outside-original\n")
    }

    func testParentsAreRecheckedAfterOpen() throws {
        let root = try makeFolder(named: "vault")
        let notes = root.appendingPathComponent("notes", isDirectory: true)
        try FileManager.default.createDirectory(at: notes, withIntermediateDirectories: true)
        let note = notes.appendingPathComponent("page.md")
        try Data("original text\n".utf8).write(to: note)
        let outside = root.appendingPathComponent("outside", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        let outsideNote = outside.appendingPathComponent("page.md")
        try Data("outside-original\n".utf8).write(to: outsideNote)
        let real = root.appendingPathComponent("notes-real")
        XCTAssertThrowsError(try NoteFolderSave.writeInPlace(Data("SWAPPED_SECRET\n".utf8), to: note, afterOpen: {
            try? FileManager.default.moveItem(at: notes, to: real)
            try? FileManager.default.createSymbolicLink(at: notes, withDestinationURL: outside)
        }))
        XCTAssertEqual(try String(contentsOf: real.appendingPathComponent("page.md"), encoding: .utf8), "original text\n")
        XCTAssertEqual(try String(contentsOf: outsideNote, encoding: .utf8), "outside-original\n")
    }

    func testTypedWeekMatchesTheFiles() throws {
        let root = try sampleVault()
        let week = [
            "log/2026-03-09.md",
            "log/2026-03-14.md",
            "log/2026-03-15.md",
            "log/2026-03-16.md",
            "aidanos/weeks/2026-03-09.md",
        ]
        let vault = try makeFolder(named: "co.noteplan.NotePlan3").appendingPathComponent("Documents", isDirectory: true)
        let session = try AidanSession(vault: vault)
        for relative in week {
            let original = try String(contentsOf: root.appendingPathComponent(relative), encoding: .utf8)
            var editor = LiveNoteEditor(text: "", context: EditorNoteContext.forPath(relative))
            var previous = ""
            if relative == "log/2026-03-09.md" {
                var built = ""
                for character in original {
                    built.append(character)
                    let kept = editor.type(built)
                    XCTAssertEqual(kept, built)
                    let merged = try session.applyEdit(relative, from: previous, to: kept)
                    XCTAssertEqual(merged, built)
                    previous = merged
                }
            } else {
                let pieces = NoteLineBreaks.pieces(original)
                var built = ""
                for piece in pieces {
                    built += piece.line
                    built += piece.breakAfter
                    let kept = editor.type(built)
                    XCTAssertEqual(kept, built)
                    let merged = try session.applyEdit(relative, from: previous, to: kept)
                    XCTAssertEqual(merged, built)
                    previous = merged
                }
            }
            XCTAssertEqual(editor.text, original)
            XCTAssertEqual(try session.text(relative), original)
            let saved = try String(contentsOf: vault.appendingPathComponent(relative), encoding: .utf8)
            XCTAssertEqual(saved, original)
            let file = vault.appendingPathComponent(relative)
            let inode = try fileInode(file)
            try session.applyEdit(relative, from: original, to: original + "x")
            try session.replace(relative, with: original)
            XCTAssertEqual(try fileInode(file), inode)
            XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), original)
        }
    }

    /// 5,000 ordinary lines stay a linear scan, and one keystroke stays one line.
    /// The simulator's wall clock missed 1.5s on this same linear read
    /// (run 40412816082 recorded 1.888s). That clock is not the bound there.
    /// The step count is: twice the lines stay within 3x, and a quadratic scan is about 4x.
    func testFiveThousandLinesStayResponsive() {
        let half = noteLines(2500)
        let text = noteLines(5000)
        let halfWork = scanSteps(half)
        let fullWork = scanSteps(text)
        XCTAssertGreaterThan(halfWork, 0)
        XCTAssertLessThanOrEqual(
            fullWork,
            halfWork * 3,
            "reading 5,000 lines took \(fullWork) steps after \(halfWork)"
        )
        let oneWork = scanSteps("A plain sentence 1.")
        XCTAssertGreaterThan(oneWork, 0)
        XCTAssertLessThan(oneWork * 100, fullWork, "one line took \(oneWork) steps; the note took \(fullWork)")
        let reading = ExternalFormatLineReading()
        let shapes = reading.shapes(in: text, context: .project)
        XCTAssertEqual(shapes.count, 5000)
        XCTAssertEqual(shapes[0].role, .heading(level: 1))
        XCTAssertEqual(shapes[5].role, .task(ticked: false))
        var editor = LiveNoteEditor(text: text, context: .project)
        #if !targetEnvironment(simulator)
        let full = fastest(of: 3) {
            let timed = reading.shapes(in: text, context: .project)
            XCTAssertEqual(timed.count, 5000)
        }
        XCTAssertLessThan(full, 1.5, "reading 5,000 lines took \(full)s")
        #endif
        let key = fastest(of: 5) {
            _ = editor.replace(start: text.count, end: text.count, with: "!")
            XCTAssertEqual(editor.role(ofLine: "A plain sentence 1.!"), .plain)
            _ = editor.undo()
        }
        XCTAssertLessThan(key, 0.05, "one keystroke took \(key)s")
        XCTAssertEqual(editor.text, text)
    }

    private func noteLines(_ count: Int) -> String {
        var lines: [String] = []
        lines.reserveCapacity(count)
        for index in 0..<count {
            if index % 20 == 0 {
                lines.append("# Section \(index)")
            } else if index % 5 == 0 {
                lines.append("- [ ] Task \(index) stays put")
            } else if index % 2 == 0 {
                lines.append("- hanging line \(index)")
            } else {
                lines.append("A plain sentence \(index).")
            }
        }
        return lines.joined(separator: "\n")
    }

    private func scanSteps(_ text: String) -> Int {
        var work: ExternalFormatScanWork? = ExternalFormatScanWork()
        _ = ExternalFormatReader.read(text, in: .project, work: &work, route: .automatic)
        return work?.count ?? 0
    }

    private func fastest(of times: Int, _ body: () -> Void) -> TimeInterval {
        var best = TimeInterval.greatestFiniteMagnitude
        for _ in 0..<times {
            let started = Date()
            body()
            let elapsed = Date().timeIntervalSince(started)
            if elapsed < best { best = elapsed }
        }
        return best
    }

    private func makeFolder(named name: String) throws -> URL {
        let url = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("aidanos-\(name)-\(UUID().uuidString)", isDirectory: true)
            .appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func fileInode(_ url: URL) throws -> UInt64 {
        var info = stat()
        if stat(url.path, &info) != 0 {
            throw AidanError.io("Could not read the saved note.")
        }
        return UInt64(info.st_ino)
    }

    private func sampleVault() throws -> URL {
        let starts = [
            URL(fileURLWithPath: #filePath),
            URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        ]
        for start in starts {
            var url = start
            for _ in 0..<12 {
                let manifest = url.appendingPathComponent("fixtures/sample-notes/manifest.json")
                if FileManager.default.fileExists(atPath: manifest.path) {
                    return manifest.deletingLastPathComponent().appendingPathComponent("vault")
                }
                let parent = url.deletingLastPathComponent()
                if parent.path == url.path { break }
                url = parent
            }
        }
        throw AidanError.io("The sample notes were not next to the test.")
    }
}
