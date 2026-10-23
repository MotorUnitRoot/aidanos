@testable import AidanCore
import Foundation
import XCTest

final class SampleNotesTests: XCTestCase {
    func testSampleFolderCoversTheReader() throws {
        let loaded = try loadSamples()
        XCTAssertEqual(loaded.files, expectedFiles)
        XCTAssertEqual(loaded.unreadable, ["Calendar/garbled.md"])
        XCTAssertEqual(loaded.notes.count, expectedFiles.count - 1)

        let days = loaded.notes.compactMap(\.pathKind.day).sorted()
        XCTAssertEqual(days.first, CalendarDay(year: 2023, month: 10, day: 20))
        XCTAssertEqual(days.last, CalendarDay(year: 2026, month: 10, day: 23))
        XCTAssertGreaterThanOrEqual(calendarGap(from: days.first!, to: days.last!, timeZone: TimeZone(secondsFromGMT: 0)!), 365 * 3)

        let empty = try note("Notes/empty.md", in: loaded)
        XCTAssertEqual(empty.text, "")
        XCTAssertTrue(empty.lines.isEmpty)

        XCTAssertEqual(try note("Calendar/loose-page.md", in: loaded).pathKind, .ordinary)
        XCTAssertEqual(try note("Calendar/20240231.md", in: loaded).pathKind, .ordinary)
        XCTAssertEqual(try note("Calendar/20231102.txt", in: loaded).pathKind, .notePlanDay(CalendarDay(year: 2023, month: 11, day: 2)))
        XCTAssertEqual(try note("Calendar/2026-W43.md", in: loaded).pathKind, .notePlanWeek(year: 2026, week: 43))
        XCTAssertEqual(try note("Calendar/2026-10.md", in: loaded).pathKind, .notePlanMonth(year: 2026, month: 10))
        XCTAssertEqual(try note("Notes/Plan.md", in: loaded).pathKind, .ordinary)
        XCTAssertTrue(try note("Notes/Plan.md", in: loaded).text.contains("Autumn plan"))

        var states: Set<TaskState> = []
        var sawPlainStar = false
        var sawPlainDash = false
        var sawUnknown = false
        var sawHeading = false
        var sawTime930 = false
        var sawTime930am = false
        var sawTime2to3 = false
        var sawTime24hRange = false
        var sawHeadingTime = false
        var sawPlainTimeIgnored = false
        var sawToday = false
        var sawWeek = false
        var sawSource = false
        var sawDay = false
        var sawDoneStamp = false
        var sawNestedMention = false
        var sawTag = false
        var sawWiki = false
        for item in loaded.notes {
            XCTAssertEqual(rejoined(item.text), item.text, item.path)
            for line in item.lines {
                XCTAssertFalse(line.text.contains("\n"))
                if let state = line.task?.state { states.insert(state) }
                if line.task?.plain == true, line.listMarker == "*" { sawPlainStar = true }
                if line.listMarker == "-", line.task == nil { sawPlainDash = true }
                if line.unknownMark != nil { sawUnknown = true }
                if line.headingLevel != nil { sawHeading = true }
                if line.times.contains(where: { $0.raw == "9:30" }) { sawTime930 = true }
                if line.times.contains(where: { $0.raw.contains("9:30am") }) { sawTime930am = true }
                if line.times.contains(where: { $0.start == ClockTime(hour: 14, minute: 0) && $0.end == ClockTime(hour: 15, minute: 0) && $0.raw.contains("2-3pm") }) {
                    sawTime2to3 = true
                }
                if line.times.contains(where: { $0.raw == "14:00-15:30" }) { sawTime24hRange = true }
                if line.headingLevel != nil, line.times.contains(where: { $0.raw == "09:00 - 11:00" }) { sawHeadingTime = true }
                if line.text.contains("Meet at 9:30"), line.times.isEmpty { sawPlainTimeIgnored = true }
                if line.dates.contains(where: { $0.kind == .today }) { sawToday = true }
                if line.dates.contains(where: { if case .week = $0.kind { return true }; return false }) { sawWeek = true }
                if line.dates.contains(where: { if case .sourceDay = $0.kind { return true }; return false }) { sawSource = true }
                if line.dates.contains(where: { if case .day = $0.kind { return true }; return false }) { sawDay = true }
                if line.mentions.contains(where: { $0.name == "done" && $0.detail != nil }) { sawDoneStamp = true }
                if line.mentions.contains(where: { $0.name == "team/quinn" }) { sawNestedMention = true }
                if line.tags.contains(where: { $0.name == "packing" || $0.name == "glaze" || $0.name == "firing" }) { sawTag = true }
                if line.wikiLinks.contains(where: { $0.target == "Kiln notes" || $0.target == "Plan" || $0.target == "Supplier list" }) { sawWiki = true }
            }
        }
        XCTAssertEqual(states, [.open, .done, .cancelled, .scheduled])
        XCTAssertTrue(sawPlainStar)
        XCTAssertTrue(sawPlainDash)
        XCTAssertTrue(sawUnknown)
        XCTAssertTrue(sawHeading)
        XCTAssertTrue(sawTime930)
        XCTAssertTrue(sawTime930am)
        XCTAssertTrue(sawTime2to3)
        XCTAssertTrue(sawTime24hRange)
        XCTAssertTrue(sawHeadingTime)
        XCTAssertTrue(sawPlainTimeIgnored)
        XCTAssertTrue(sawToday)
        XCTAssertTrue(sawWeek)
        XCTAssertTrue(sawSource)
        XCTAssertTrue(sawDay)
        XCTAssertTrue(sawDoneStamp)
        XCTAssertTrue(sawNestedMention)
        XCTAssertTrue(sawTag)
        XCTAssertTrue(sawWiki)

        let odd = try line("Calendar/20250618.md", containing: "Check the odd mark", in: loaded)
        XCTAssertEqual(odd.unknownMark, "[?]")
        XCTAssertNil(odd.task)
        XCTAssertEqual(odd.text, "* [?] Check the odd mark")

        let locked = try line("Calendar/20261022.md", containing: "@done", in: loaded)
        XCTAssertEqual(locked.task?.state, .done)
        XCTAssertTrue(locked.times.isEmpty)
        XCTAssertEqual(locked.mentions.first?.detail, "2026-10-22 18:00")
    }

    private func note(_ path: String, in loaded: LoadedSamples) throws -> ReadNote {
        guard let note = loaded.notes.first(where: { $0.path == path }) else {
            XCTFail("Missing \(path)")
            throw CocoaError(.fileNoSuchFile)
        }
        return note
    }

    private func line(_ path: String, containing needle: String, in loaded: LoadedSamples) throws -> ParsedLine {
        guard let line = try note(path, in: loaded).lines.first(where: { $0.text.contains(needle) }) else {
            XCTFail("Missing line \(needle) in \(path)")
            throw CocoaError(.fileNoSuchFile)
        }
        return line
    }

    private func rejoined(_ text: String) -> String {
        if text.isEmpty { return "" }
        let lines = NoteLines.parse(note: text, plainMarkers: .asteriskIsOpenTask).map(\.text)
        if text.hasSuffix("\n") { return lines.joined(separator: "\n") + "\n" }
        return lines.joined(separator: "\n")
    }
}

private let expectedFiles = [
    "Calendar/20231020.md",
    "Calendar/20231102.txt",
    "Calendar/20240108.md",
    "Calendar/20240231.md",
    "Calendar/20240601.md",
    "Calendar/20240701.md",
    "Calendar/20240812.md",
    "Calendar/20250106.md",
    "Calendar/20250618.md",
    "Calendar/20251020.md",
    "Calendar/2026-10.md",
    "Calendar/2026-W43.md",
    "Calendar/20260302.md",
    "Calendar/20260801.md",
    "Calendar/20260922.md",
    "Calendar/20260923.md",
    "Calendar/20261010.md",
    "Calendar/20261012.md",
    "Calendar/20261014.md",
    "Calendar/20261015.md",
    "Calendar/20261016.md",
    "Calendar/20261017.md",
    "Calendar/20261018.md",
    "Calendar/20261019.md",
    "Calendar/20261020.md",
    "Calendar/20261021.md",
    "Calendar/20261022.md",
    "Calendar/20261023.md",
    "Calendar/garbled.md",
    "Calendar/loose-page.md",
    "Notes/Glass-jars.md",
    "Notes/Plan.md",
    "Notes/Workshop.md",
    "Notes/empty.md",
]
