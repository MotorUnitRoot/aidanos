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
        let folder = try makeFolder(named: "NotePlan")
        let file = folder.appendingPathComponent("log").appendingPathComponent("day.md")
        XCTAssertTrue(NoteFolderSave.isNotePlanFolder(file))
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: true), .inPlace)
        try NoteFolderSave.write(Data("one\n".utf8), to: file)
        let inode = try fileInode(file)
        try NoteFolderSave.write(Data("one\ntwo\n".utf8), to: file, style: .inPlace)
        XCTAssertEqual(try fileInode(file), inode)
        let names = try FileManager.default.contentsOfDirectory(atPath: file.deletingLastPathComponent().path)
        XCTAssertFalse(names.contains { $0.contains(".tmp") })
        let saved = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(saved, "one\ntwo\n")
    }

    func testSwapInStaysOutsideANotePlanFolder() throws {
        let folder = try makeFolder(named: "vault")
        let file = folder.appendingPathComponent("notes.md")
        XCTAssertFalse(NoteFolderSave.isNotePlanFolder(file))
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: true), .swapIn)
        XCTAssertEqual(NoteFolderSave.style(for: file, swapInRequested: false), .inPlace)
        try NoteFolderSave.write(Data("one\n".utf8), to: file, style: .swapIn)
        let inode = try fileInode(file)
        try NoteFolderSave.write(Data("two\n".utf8), to: file, style: .swapIn)
        XCTAssertNotEqual(try fileInode(file), inode)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "two\n")
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
        let vault = try makeFolder(named: "NotePlan").appendingPathComponent("Notes", isDirectory: true)
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

    func testFiveThousandLinesStayResponsive() {
        var lines: [String] = []
        lines.reserveCapacity(5000)
        for index in 0..<5000 {
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
        let text = lines.joined(separator: "\n")
        let reading = ExternalFormatLineReading()
        _ = reading.shapes(in: text, context: .project)
        let full = fastest(of: 3) {
            let shapes = reading.shapes(in: text, context: .project)
            XCTAssertEqual(shapes.count, 5000)
            XCTAssertEqual(shapes[0].role, .heading(level: 1))
            XCTAssertEqual(shapes[5].role, .task(ticked: false))
        }
        XCTAssertLessThan(full, 1.5, "reading 5,000 lines took \(full)s")
        var editor = LiveNoteEditor(text: text, context: .project)
        let key = fastest(of: 5) {
            _ = editor.replace(start: text.count, end: text.count, with: "!")
            _ = editor.role(ofLine: "A plain sentence 1.!")
            _ = editor.undo()
        }
        XCTAssertLessThan(key, 0.05, "one keystroke took \(key)s")
        XCTAssertEqual(editor.text, text)
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
