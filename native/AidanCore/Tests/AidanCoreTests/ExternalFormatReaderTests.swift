@testable import AidanCore
import Foundation
import XCTest

/// Cases 1–8, 11, 15–17, 25, 26–31, 34, 35, 41–43, 47, 62, and 65.
/// Each one is loaded from fixtures/external-format and read by ExternalFormatReader.
/// Other active cases stay as fixture files. Guessed and Unknown cases stay out of this list.
final class ExternalFormatReaderTests: XCTestCase {
    private let checkedCaseNumbers = [
        1, 2, 3, 4, 5, 6, 7, 8, 11, 15, 16, 17, 25, 26, 27, 28, 29, 30, 31, 34, 35,
        41, 42, 43, 47, 62, 65,
    ]

    /// Any day after 2017-01-10 and on or before 2031-03-03 gives the same list
    /// results for the dated cases. This day sits between those two fixture dates.
    private let sessionDay = ExternalDate(year: 2026, month: 10, day: 24)

    func testCheckedCasesAreTheActiveFixtureFiles() throws {
        XCTAssertEqual(Set(checkedCaseNumbers).count, checkedCaseNumbers.count)
        XCTAssertEqual(checkedCaseNumbers.count, 27)
        let root: URL
        do {
            root = try fixturesRoot()
        } catch {
            #if os(iOS)
            throw XCTSkip("The checkout fixtures are not visible from the simulator.")
            #else
            XCTFail("fixtures/external-format was not found from \(#filePath)")
            throw error
            #endif
        }
        let data = try Data(contentsOf: root.appendingPathComponent("manifest.json"))
        let manifest = try JSONDecoder().decode(ManifestFile.self, from: data)
        let active = Set(manifest.active.map(\.number))
        for number in checkedCaseNumbers {
            XCTAssertTrue(active.contains(number), "case \(number) is not an active fixture")
            let file = root.appendingPathComponent("cases/\(number).json")
            XCTAssertTrue(FileManager.default.fileExists(atPath: file.path), "missing case \(number)")
        }
        let fixtureOnly = active.subtracting(checkedCaseNumbers)
        XCTAssertEqual(fixtureOnly, [18, 52, 55, 58, 59, 61, 64])
    }

    func testProjectAndDayLabels() {
        XCTAssertEqual(ExternalFormatReader.noteContext(labeled: "Project note"), .project)
        XCTAssertEqual(
            ExternalFormatReader.noteContext(labeled: "Day 2017-01-09"),
            .day(date(2017, 1, 9))
        )
        XCTAssertNil(ExternalFormatReader.noteContext(labeled: "Weekly note 2017-W02"))
    }

    func testCase1BareStarIsAnOpenTask() throws {
        try assertOpenTask(1)
    }

    func testCase2EmptyBoxIsAnOpenTask() throws {
        try assertOpenTask(2)
    }

    func testCase3DoneTask() throws {
        let (fixture, line) = try oneLine(3)
        XCTAssertEqual(fixture.expected, "Done task")
        XCTAssertEqual(line.kind, .doneTask)
        XCTAssertFalse(line.countsAsOpen)
    }

    func testCase4CancelledTask() throws {
        let (fixture, line) = try oneLine(4)
        XCTAssertEqual(fixture.expected, "Cancelled task")
        XCTAssertEqual(line.kind, .cancelledTask)
        XCTAssertFalse(line.countsAsOpen)
    }

    func testCase5ScheduledTaskIsNotOpen() throws {
        let (fixture, line) = try oneLine(5)
        XCTAssertEqual(fixture.expected, "Scheduled task (moved); not counted as open")
        XCTAssertEqual(line.kind, .scheduledTask)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertEqual(line.scheduleDates, [date(2031, 3, 3)])
    }

    func testCase6BulletIsNotATask() throws {
        let (fixture, line) = try oneLine(6)
        XCTAssertEqual(fixture.expected, "Bullet, not a task")
        XCTAssertEqual(line.kind, .bullet)
        XCTAssertFalse(line.countsAsOpen)
    }

    func testCase7DashBoxIsAnOpenTask() throws {
        try assertOpenTask(7)
    }

    func testCase8OpenChecklistIsLeftOutOfOverdue() throws {
        let (fixture, line) = try oneLine(8)
        XCTAssertEqual(fixture.expected, "Open checklist item; not in overdue counts or Overdue filter")
        XCTAssertEqual(line.kind, .openChecklist)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.leftOutOfOverdue)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .unlisted)
    }

    func testCase11DoneStampHasDateAndTime() throws {
        let (fixture, line) = try oneLine(11)
        XCTAssertEqual(fixture.expected, "Done task completed Jan 9, 2017 at 14:05")
        XCTAssertEqual(line.kind, .doneTask)
        XCTAssertEqual(
            line.completion,
            ExternalCompletion(day: date(2017, 1, 9), time: ExternalClockTime(hour: 14, minute: 5))
        )
        XCTAssertEqual(line.mentions, [ExternalMention(name: "done", value: "2017-01-09 14:05")])
        XCTAssertNil(line.timeBlock)
    }

    func testCase15ProjectScheduleStaysAndIsOverdue() throws {
        let (fixture, line, note) = try oneLineNote(15)
        XCTAssertEqual(fixture.expected, "Task stays here; appears in Jan 10, 2017 references; overdue on session day")
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(line.referencedDays, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .overdue)
    }

    func testCase16DayScheduleDoesNotMakeAReference() throws {
        let (fixture, line) = try oneLine(16)
        XCTAssertEqual(fixture.expected, "No reference appears in Jan 11, 2017")
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 11)])
        XCTAssertFalse(line.referencedDays.contains(date(2017, 1, 11)))
        XCTAssertTrue(line.referencedDays.isEmpty)
    }

    func testCase17DayLinkMakesAReference() throws {
        let (fixture, line) = try oneLine(17)
        XCTAssertEqual(fixture.expected, "Appears in Jan 11, 2017 references")
        XCTAssertEqual(line.referencedDays, [date(2017, 1, 11)])
        let link = try XCTUnwrap(line.wikiLinks.first)
        XCTAssertEqual(line.wikiLinks.count, 1)
        XCTAssertEqual(link.target, "2017-01-11")
        XCTAssertEqual(link.day, date(2017, 1, 11))
    }

    func testCase25TwoDayLinks() throws {
        let (fixture, line) = try oneLine(25)
        XCTAssertEqual(fixture.expected, "Appears in both days' references")
        XCTAssertEqual(line.referencedDays, [date(2017, 1, 10), date(2017, 1, 12)])
        XCTAssertEqual(line.wikiLinks.map(\.target), ["2017-01-10", "2017-01-12"])
    }

    func testCase26TwentyFourHourTimeBlock() throws {
        let (fixture, line) = try oneLine(26)
        XCTAssertEqual(fixture.expected, "Time block at 2 pm on Jan 9, 2017")
        let block = try XCTUnwrap(line.timeBlock)
        // 14:00 is 2 pm.
        XCTAssertEqual(block.start, ExternalClockTime(hour: 14, minute: 0))
        XCTAssertNil(block.end)
        XCTAssertEqual(block.day, date(2017, 1, 9))
        XCTAssertFalse(block.fromHeading)
    }

    func testCase27TwelveHourTimeBlock() throws {
        let (fixture, line) = try oneLine(27)
        XCTAssertEqual(fixture.expected, "Time block at 5 pm")
        let block = try XCTUnwrap(line.timeBlock)
        XCTAssertEqual(block.start, ExternalClockTime(hour: 17, minute: 0))
        XCTAssertNil(block.end)
        XCTAssertEqual(block.day, date(2017, 1, 9))
    }

    func testCase28BareNumberIsNotATime() throws {
        let (fixture, line) = try oneLine(28)
        XCTAssertEqual(fixture.expected, "No time block")
        XCTAssertTrue(fixture.input.contains("15"))
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertNil(line.timeBlock)
    }

    func testCase29PlainTextIsNotATimeBlock() throws {
        let (fixture, line) = try oneLine(29)
        XCTAssertEqual(fixture.expected, "No time block (plain text)")
        XCTAssertTrue(fixture.input.contains("16:00"))
        XCTAssertEqual(line.kind, .plain)
        XCTAssertNil(line.timeBlock)
    }

    func testCase30HeadingHoldsTheTimeRange() throws {
        let (fixture, note) = try loadCase(30)
        XCTAssertEqual(fixture.expected, "9 to 11 block from the heading")
        XCTAssertEqual(note.lines.count, 2)
        XCTAssertEqual(note.lines[0].kind, .heading(level: 2))
        let block = try XCTUnwrap(note.lines[0].timeBlock)
        XCTAssertEqual(block.start, ExternalClockTime(hour: 9, minute: 0))
        XCTAssertEqual(block.end, ExternalClockTime(hour: 11, minute: 0))
        XCTAssertEqual(block.day, date(2017, 1, 9))
        XCTAssertTrue(block.fromHeading)
        XCTAssertEqual(note.lines[1].kind, .openTask)
        XCTAssertNil(note.lines[1].timeBlock)
    }

    func testCase31ProjectTimeBlockUsesTheDate() throws {
        let (fixture, line) = try oneLine(31)
        XCTAssertEqual(fixture.expected, "Time block on Jan 10, 2017")
        let block = try XCTUnwrap(line.timeBlock)
        XCTAssertEqual(block.start, ExternalClockTime(hour: 17, minute: 0))
        XCTAssertNil(block.end)
        XCTAssertEqual(block.day, date(2017, 1, 10))
        XCTAssertFalse(block.fromHeading)
    }

    func testCase34NestedTag() throws {
        let (fixture, line) = try oneLine(34)
        XCTAssertEqual(fixture.expected, "Tag zzhome/garden, shown under zzhome in the sidebar")
        XCTAssertEqual(line.tags, [ExternalTag(name: "zzhome/garden", parent: "zzhome")])
    }

    func testCase35Mention() throws {
        let (fixture, line) = try oneLine(35)
        XCTAssertEqual(fixture.expected, "Mention Zed_Tester")
        XCTAssertEqual(line.mentions, [ExternalMention(name: "Zed_Tester", value: nil)])
    }

    func testCase41LinkTarget() throws {
        let link = try noteLink(41, expected: "Link; clicking creates the note if missing; line shows in that note's references")
        XCTAssertEqual(link.target, "ZZ REA Linked Note")
        XCTAssertNil(link.heading)
        XCTAssertNil(link.shownText)
    }

    func testCase42LinkHeading() throws {
        let link = try noteLink(42, expected: "Link to that heading")
        XCTAssertEqual(link.target, "ZZ REA Linked Note")
        XCTAssertEqual(link.heading, "Fake Heading")
        XCTAssertNil(link.shownText)
    }

    func testCase43LinkShownText() throws {
        let link = try noteLink(43, expected: "Shows \"Short\", links to the note")
        XCTAssertEqual(link.target, "ZZ REA Linked Note")
        XCTAssertNil(link.heading)
        XCTAssertEqual(link.shownText, "Short")
    }

    func testCase47BlankLineEndsChildren() throws {
        let (fixture, note) = try loadCase(47)
        XCTAssertEqual(fixture.expected, "First indented line is a child; the line after the blank line is not")
        XCTAssertTrue(fixture.input.contains("\t"))
        XCTAssertTrue(fixture.input.contains("\n\n"))
        XCTAssertEqual(note.lines.count, 4)
        XCTAssertEqual(note.lines[0].kind, .openTask)
        XCTAssertEqual(note.lines[0].indentTabs, 0)
        XCTAssertEqual(note.lines[0].childIndexes, [1])
        XCTAssertEqual(note.lines[1].kind, .bullet)
        XCTAssertEqual(note.lines[1].indentTabs, 1)
        XCTAssertEqual(note.lines[2].kind, .empty)
        XCTAssertEqual(note.lines[3].kind, .openTask)
        XCTAssertEqual(note.lines[3].indentTabs, 1)
        XCTAssertFalse(note.lines[0].childIndexes.contains(3))
    }

    func testCase62FutureDateIsUpcoming() throws {
        let (fixture, line) = try oneLine(62)
        XCTAssertEqual(fixture.expected, "Listed in Upcoming, not Overdue")
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertEqual(line.scheduleDates, [date(2031, 3, 3)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .upcoming)
    }

    func testCase65MarkdownLinkShowsItsWords() throws {
        let (fixture, line) = try oneLine(65)
        XCTAssertEqual(fixture.expected, "Markdown link showing the words \"fake site\"")
        XCTAssertEqual(line.kind, .plain)
        let link = try XCTUnwrap(line.markdownLinks.first)
        XCTAssertEqual(line.markdownLinks.count, 1)
        XCTAssertEqual(link.shownText, "fake site")
        XCTAssertTrue(fixture.input.contains("(" + link.address + ")"))
    }

    /// `@repeat(n/total)` is a mention with a value. The line is not copied forward.
    func testRepeatMarkIsAMentionWithAValue() {
        let note = ExternalFormatReader.read("* Chore @repeat(1/3)\n* Chore @repeat(5/10)", in: .project)
        XCTAssertEqual(note.lines.count, 2)
        XCTAssertEqual(note.lines[0].mentions, [ExternalMention(name: "repeat", value: "1/3")])
        XCTAssertEqual(note.lines[1].mentions, [ExternalMention(name: "repeat", value: "5/10")])
        XCTAssertTrue(note.lines[0].scheduleDates.isEmpty)
        XCTAssertTrue(note.lines[1].scheduleDates.isEmpty)
    }

    func testCarriageReturnsSplitLines() {
        let note = ExternalFormatReader.read("* One\r\n* Two\r* Three\r\n", in: .project)
        XCTAssertEqual(note.lines.count, 3)
        for line in note.lines {
            XCTAssertEqual(line.kind, .openTask)
            XCTAssertTrue(line.countsAsOpen)
        }
        let blank = ExternalFormatReader.read("\r\n", in: .project)
        XCTAssertEqual(blank.lines.count, 1)
        XCTAssertEqual(blank.lines[0].kind, .empty)
        let lone = ExternalFormatReader.read("* Left\r* Right", in: .project)
        XCTAssertEqual(lone.lines.count, 2)
        XCTAssertEqual(lone.lines[0].kind, .openTask)
        XCTAssertEqual(lone.lines[1].kind, .openTask)
    }

    func testAccentedDigitDoesNotCrash() {
        let accented = "1\u{0301}"
        let day = ExternalFormatReader.read("* \(accented):00 x", in: .day(date(2017, 1, 9)))
        XCTAssertEqual(day.lines.count, 1)
        XCTAssertEqual(day.lines[0].kind, .openTask)
        XCTAssertNil(day.lines[0].timeBlock)
        let stamp = ExternalFormatReader.read(
            "* [x] Item @done(2017-01-09 \(accented)4:05)",
            in: .project
        )
        XCTAssertEqual(stamp.lines[0].kind, .doneTask)
        XCTAssertNil(stamp.lines[0].completion)
        XCTAssertEqual(stamp.lines[0].mentions, [ExternalMention(name: "done", value: "2017-01-09 \(accented)4:05")])
        XCTAssertNil(stamp.lines[0].timeBlock)
    }

    func testEmptyAndWhitespaceInput() {
        XCTAssertTrue(ExternalFormatReader.read("", in: .project).lines.isEmpty)
        let newline = ExternalFormatReader.read("\n", in: .project)
        XCTAssertEqual(newline.lines.count, 1)
        XCTAssertEqual(newline.lines[0].kind, .empty)
        let spaces = ExternalFormatReader.read("  \n\t\t", in: .project)
        XCTAssertEqual(spaces.lines.count, 2)
        XCTAssertEqual(spaces.lines[0].kind, .plain)
        XCTAssertFalse(spaces.lines[0].countsAsOpen)
        XCTAssertEqual(ExternalFormatReader.placement(of: spaces.lines[0], on: sessionDay), .unlisted)
        XCTAssertEqual(spaces.lines[1].kind, .empty)
        XCTAssertEqual(spaces.lines[1].indentTabs, 2)
    }

    func testUnclosedLinksAreNotLinks() {
        let note = ExternalFormatReader.read("* See [[No end and [words](no-end", in: .project)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertEqual(note.lines[0].kind, .openTask)
        XCTAssertTrue(note.lines[0].wikiLinks.isEmpty)
        XCTAssertTrue(note.lines[0].markdownLinks.isEmpty)
    }

    func testUnclosedBracketLineStaysWithinTheTimeBound() {
        let line = String(repeating: "[", count: 1_000_000)
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        XCTAssertLessThan(Date().timeIntervalSince(started), 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertTrue(note.lines[0].wikiLinks.isEmpty)
        XCTAssertTrue(note.lines[0].markdownLinks.isEmpty)
    }

    func testCapitalBoxIsUnsettledAndUnlisted() {
        let line = ExternalFormatReader.read("* [X] Capital X box >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .unsettled)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.leftOutOfOverdue)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertNil(line.timeBlock)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .unlisted)
    }

    func testCheckedChecklistBoxIsUnsettledAndUnlisted() {
        let line = ExternalFormatReader.read("+ [x] Pack fake socks >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .unsettled)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .unlisted)
    }

    func testAtDateIsUnsettledAndUnlisted() {
        let line = ExternalFormatReader.read("* Fake meeting prep @2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .unsettled)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.mentions.isEmpty)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay), .unlisted)
    }

    func testTaskInsideCodeFenceIsUnsettledAndUnlisted() {
        let text = "```\n* fake task #zzcode >2017-01-10\n```\n* Outside >2017-01-10\n"
        let note = ExternalFormatReader.read(text, in: .project)
        XCTAssertEqual(note.lines.count, 4)
        XCTAssertEqual(note.lines[1].kind, .unsettled)
        XCTAssertFalse(note.lines[1].countsAsOpen)
        XCTAssertTrue(note.lines[1].tags.isEmpty)
        XCTAssertTrue(note.lines[1].scheduleDates.isEmpty)
        XCTAssertTrue(note.lines[1].referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[1], on: sessionDay), .unlisted)
        XCTAssertEqual(note.lines[3].kind, .openTask)
        XCTAssertEqual(note.lines[3].scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[3], on: sessionDay), .overdue)
    }

    private func assertOpenTask(_ number: Int) throws {
        let (fixture, line) = try oneLine(number)
        XCTAssertEqual(fixture.expected, "Open task")
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertFalse(line.leftOutOfOverdue)
    }

    private func noteLink(_ number: Int, expected: String) throws -> ExternalWikiLink {
        let (fixture, line) = try oneLine(number)
        XCTAssertEqual(fixture.expected, expected)
        let link = try XCTUnwrap(line.wikiLinks.first)
        XCTAssertEqual(line.wikiLinks.count, 1)
        return link
    }

    private func oneLine(_ number: Int) throws -> (FixtureCase, ExternalLine) {
        let (fixture, line, _) = try oneLineNote(number)
        return (fixture, line)
    }

    private func oneLineNote(_ number: Int) throws -> (FixtureCase, ExternalLine, ExternalNoteReading) {
        let (fixture, note) = try loadCase(number)
        XCTAssertEqual(note.lines.count, 1, "case \(number)")
        return (fixture, note.lines[0], note)
    }

    private func loadCase(_ number: Int) throws -> (FixtureCase, ExternalNoteReading) {
        let root: URL
        do {
            root = try fixturesRoot()
        } catch {
            // The simulator cannot see the checkout. Linux and Mac package tests can.
            #if os(iOS)
            throw XCTSkip("The checkout fixtures are not visible from the simulator.")
            #else
            XCTFail("fixtures/external-format was not found from \(#filePath)")
            throw error
            #endif
        }
        let url = root.appendingPathComponent("cases/\(number).json")
        let fixture = try JSONDecoder().decode(FixtureCase.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.number, number)
        XCTAssertEqual(fixture.label, "Seen")
        guard let context = ExternalFormatReader.noteContext(labeled: fixture.context) else {
            XCTFail("case \(number) has no readable context \(fixture.context)")
            throw LoadError.context
        }
        let note = ExternalFormatReader.read(fixture.input, in: context)
        XCTAssertEqual(note.context, context)
        return (fixture, note)
    }
}

private struct FixtureCase: Decodable {
    var number: Int
    var context: String
    var input: String
    var expected: String
    var label: String
}

private struct ManifestFile: Decodable {
    struct Entry: Decodable {
        var number: Int
    }

    var active: [Entry]
}

private enum LoadError: Error {
    case missingRoot
    case context
}

private func fixturesRoot() throws -> URL {
    let starts = [
        URL(fileURLWithPath: #filePath),
        URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
    ]
    for start in starts {
        var url = start
        for _ in 0..<12 {
            let manifest = url.appendingPathComponent("fixtures/external-format/manifest.json")
            if FileManager.default.fileExists(atPath: manifest.path) {
                return manifest.deletingLastPathComponent()
            }
            let parent = url.deletingLastPathComponent()
            if parent.path == url.path { break }
            url = parent
        }
    }
    throw LoadError.missingRoot
}

private func date(_ year: Int, _ month: Int, _ day: Int) -> ExternalDate {
    ExternalDate(year: year, month: month, day: day)
}
