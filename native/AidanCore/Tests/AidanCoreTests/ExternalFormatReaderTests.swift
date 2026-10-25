@testable import AidanCore
import Foundation
import XCTest
#if canImport(Darwin)
import Darwin
import os
#else
import Glibc
#endif

/// Cases 1–8, 11, 15–18, 25, 26–31, 34, 35, 41–43, 47, 52, 55, 58, 59, 61, 62, and 65.
/// Each one is loaded from fixtures/external-format and read by ExternalFormatReader.
/// Case 64 stays a fixture file. Guessed and Unknown cases stay out of this list.
final class ExternalFormatReaderTests: XCTestCase {
    private let checkedCaseNumbers = [
        1, 2, 3, 4, 5, 6, 7, 8, 11, 15, 16, 17, 18, 25, 26, 27, 28, 29, 30, 31, 34, 35,
        41, 42, 43, 47, 52, 55, 58, 59, 61, 62, 65,
    ]

    /// Any day after 2017-01-10 and on or before 2031-03-03 gives the same list
    /// results for the dated cases. This day sits between those two fixture dates.
    private let sessionDay = ExternalDate(year: 2026, month: 10, day: 24)

    func testCheckedCasesAreTheActiveFixtureFiles() throws {
        XCTAssertEqual(Set(checkedCaseNumbers).count, checkedCaseNumbers.count)
        XCTAssertEqual(checkedCaseNumbers.count, 33)
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
        XCTAssertEqual(fixtureOnly, [64])
    }

    func testProjectAndDayLabels() {
        XCTAssertEqual(ExternalFormatReader.noteContext(labeled: "Project note"), .project)
        XCTAssertEqual(
            ExternalFormatReader.noteContext(labeled: "Day 2017-01-09"),
            .day(date(2017, 1, 9))
        )
        XCTAssertNil(ExternalFormatReader.noteContext(labeled: "Day 2017-01-09, viewed on session day"))
        XCTAssertEqual(
            ExternalFormatReader.noteContext(labeled: fixtureContext("Day 2017-01-09, viewed on session day")),
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
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
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
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .overdue)
        XCTAssertTrue(ExternalFormatReader.references(line, on: date(2017, 1, 10)))
        let listed = ExternalFormatReader.viewListing(of: line, on: sessionDay, in: .project)
        XCTAssertEqual(listed.calendar, .open)
        XCTAssertEqual(listed.notes, .scheduled)
        XCTAssertTrue(listed.staysInOverdue)
        XCTAssertEqual(listed.date, date(2017, 1, 10))
        XCTAssertFalse(line.carriesToday)
        let opened = ExternalFormatReader.openDay(
            existingText: nil,
            template: nil,
            earlierNotes: [],
            today: sessionDay
        )
        XCTAssertEqual(opened.text, "")
        XCTAssertTrue(opened.broughtLines.isEmpty)
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

    func testCase55OpenTaskInAPastDayNoteIsOverdue() throws {
        let (fixture, line, note) = try oneLineNote(55)
        XCTAssertEqual(
            fixture.expected,
            "Not copied anywhere; Jan 9 shows red in the month calendar; listed in Overdue"
        )
        XCTAssertEqual(note.context, .day(date(2017, 1, 9)))
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(
            ExternalFormatReader.placement(of: line, on: sessionDay, in: note.context),
            .overdue
        )
        XCTAssertTrue(ExternalFormatReader.dayCountsAsOverdue(note, on: sessionDay))
        let opened = ExternalFormatReader.openDay(
            existingText: nil,
            template: nil,
            earlierNotes: [ExternalDayText(day: date(2017, 1, 9), text: fixture.input)],
            today: sessionDay
        )
        XCTAssertEqual(opened.text, "")
        XCTAssertTrue(opened.broughtLines.isEmpty)
        XCTAssertFalse(opened.text.contains("left behind"))
    }

    func testCase62FutureDateIsUpcoming() throws {
        let (fixture, line) = try oneLine(62)
        XCTAssertEqual(fixture.expected, "Listed in Upcoming, not Overdue")
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertEqual(line.scheduleDates, [date(2031, 3, 3)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .upcoming)
    }

    func testCase18TodayTagFollowsTheRealCurrentDay() throws {
        let (fixture, line) = try oneLine(18)
        XCTAssertEqual(fixture.expected, "Shows in the session day's references, and on each later day until done")
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertTrue(line.carriesToday)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        let clock = FixedDayClock(today: sessionDay)
        XCTAssertEqual(
            ExternalFormatReader.placement(of: line, on: sessionDay, in: .project, clock: clock),
            .upcoming
        )
        let listed = ExternalFormatReader.viewListing(of: line, on: sessionDay, in: .project, clock: clock)
        XCTAssertEqual(listed.calendar, .open)
        XCTAssertEqual(listed.notes, .open)
        XCTAssertFalse(listed.staysInOverdue)
        XCTAssertEqual(
            ExternalFormatReader.viewListing(of: line, on: date(2031, 3, 3), in: .project, clock: clock).calendar,
            .unlisted
        )
        XCTAssertTrue(ExternalFormatReader.references(line, on: sessionDay, clock: clock))
        XCTAssertFalse(ExternalFormatReader.references(line, on: date(2031, 3, 3), clock: clock))
        let nextDay = FixedDayClock(today: date(2026, 10, 25))
        XCTAssertTrue(ExternalFormatReader.references(line, on: date(2026, 10, 25), clock: nextDay))
        XCTAssertFalse(ExternalFormatReader.references(line, on: sessionDay, clock: nextDay))
        let pastNote = ExternalFormatReader.read("* x >today", in: .day(date(2017, 1, 9))).lines[0]
        XCTAssertTrue(pastNote.carriesToday)
        XCTAssertEqual(
            ExternalFormatReader.placement(of: pastNote, on: sessionDay, in: .day(date(2017, 1, 9)), clock: clock),
            .upcoming
        )
        XCTAssertEqual(
            ExternalFormatReader.placement(of: pastNote, on: date(2017, 1, 9), in: .day(date(2017, 1, 9)), clock: clock),
            .unlisted
        )
        XCTAssertEqual(
            ExternalFormatReader.viewListing(of: pastNote, on: sessionDay, in: .day(date(2017, 1, 9)), clock: clock).calendar,
            .open
        )
        XCTAssertFalse(ExternalFormatReader.references(pastNote, on: date(2017, 1, 9), clock: clock))
        XCTAssertTrue(ExternalFormatReader.references(pastNote, on: sessionDay, clock: clock))
        let done = ExternalFormatReader.read("* [x] Water fake plants >today", in: .project).lines[0]
        XCTAssertEqual(done.kind, .doneTask)
        XCTAssertFalse(done.carriesToday)
        XCTAssertFalse(ExternalFormatReader.references(done, on: sessionDay, clock: clock))
        let bullet = ExternalFormatReader.read("- Water fake plants >today", in: .project).lines[0]
        XCTAssertEqual(bullet.kind, .bullet)
        XCTAssertTrue(bullet.carriesToday)
        XCTAssertTrue(ExternalFormatReader.references(bullet, on: sessionDay, clock: clock))
        let instant = Date()
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = .current
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = .current
        buddhist.locale = Locale(identifier: "th_TH")
        var japanese = Calendar(identifier: .japanese)
        japanese.timeZone = .current
        japanese.locale = Locale(identifier: "ja_JP")
        let before = gregorian.dateComponents([.year, .month, .day], from: instant)
        let real = ExternalSystemDayClock().today
        let after = gregorian.dateComponents([.year, .month, .day], from: Date())
        let matchesBefore = real.year == before.year && real.month == before.month && real.day == before.day
        let matchesAfter = real.year == after.year && real.month == after.month && real.day == after.day
        XCTAssertTrue(matchesBefore || matchesAfter)
        XCTAssertGreaterThan(real.year, 2000)
        XCTAssertEqual(String(real.year).count, 4)
        XCTAssertNotEqual(real.year, buddhist.component(.year, from: instant))
        XCTAssertNotEqual(real.year, japanese.component(.year, from: instant))
    }

    func testGregorianDayIgnoresABuddhistOrJapaneseCalendar() {
        let instant = Date()
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = .current
        var buddhist = Calendar(identifier: .buddhist)
        buddhist.timeZone = .current
        buddhist.locale = Locale(identifier: "th_TH")
        var japanese = Calendar(identifier: .japanese)
        japanese.timeZone = .current
        japanese.locale = Locale(identifier: "ja_JP")
        let expected = gregorian.dateComponents([.year, .month, .day], from: instant)
        for foreign in [buddhist, japanese] {
            let day = ExternalSystemDayClock.gregorianDay(of: instant, in: .current, ignoring: foreign)
            XCTAssertEqual(day.year, expected.year)
            XCTAssertEqual(day.month, expected.month)
            XCTAssertEqual(day.day, expected.day)
            XCTAssertNotEqual(day.year, foreign.component(.year, from: instant))
        }
    }

    func testCase52ScheduleByCopyWritesBothLines() throws {
        let fixture = try loadFixture(52)
        XCTAssertEqual(fixture.expected, "Jan 9: [>] with >2017-01-10; Jan 10: open copy with <2017-01-09")
        let result = ExternalFormatReader.bringForward(
            line: "* Fake move once",
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 10),
            mode: .scheduleByCopy
        )
        guard case .edited(sourceLine: let source, addedLine: let added) = result else {
            return XCTFail("case 52 did not edit the line")
        }
        let sourceLine = try XCTUnwrap(source)
        let addedLine = try XCTUnwrap(added)
        XCTAssertEqual(sourceLine, "* [>] Fake move once >2017-01-10")
        XCTAssertEqual(addedLine, "* Fake move once <2017-01-09")
        let original = ExternalFormatReader.read(sourceLine, in: .day(date(2017, 1, 9))).lines[0]
        XCTAssertEqual(original.kind, .scheduledTask)
        XCTAssertFalse(original.countsAsOpen)
        XCTAssertEqual(original.scheduleDates, [date(2017, 1, 10)])
        XCTAssertTrue(original.broughtFromDays.isEmpty)
        let copy = ExternalFormatReader.read(addedLine, in: .day(date(2017, 1, 10))).lines[0]
        XCTAssertEqual(copy.kind, .openTask)
        XCTAssertTrue(copy.countsAsOpen)
        XCTAssertEqual(copy.broughtFromDays, [date(2017, 1, 9)])
        XCTAssertTrue(copy.scheduleDates.isEmpty)
    }

    func testCase58OpeningAnEmptyDayCopiesNothing() throws {
        let fixture = try loadFixture(58)
        XCTAssertEqual(
            fixture.expected,
            "If an auto-insert daily template exists, it is inserted; otherwise empty; no tasks from earlier days appear by themselves"
        )
        let earlier = [
            ExternalDayText(day: date(2017, 1, 9), text: "* Fake left behind"),
            ExternalDayText(day: date(2017, 1, 10), text: "* [ ] Another open task"),
        ]
        let opened = ExternalFormatReader.openDay(
            existingText: nil,
            template: nil,
            earlierNotes: earlier,
            today: date(2017, 1, 13)
        )
        XCTAssertEqual(opened.text, "")
        XCTAssertTrue(opened.broughtLines.isEmpty)
        let template = "* From the caller template"
        let inserted = ExternalFormatReader.openDay(
            existingText: nil,
            template: template,
            earlierNotes: earlier,
            today: date(2017, 1, 13)
        )
        XCTAssertEqual(inserted.text, template)
        XCTAssertTrue(inserted.broughtLines.isEmpty)
        XCTAssertFalse(inserted.text.contains("Fake left behind"))
        let existing = ExternalFormatReader.openDay(
            existingText: "* Already written",
            template: template,
            earlierNotes: earlier,
            today: date(2017, 1, 13)
        )
        XCTAssertEqual(existing.text, "* Already written")
        XCTAssertTrue(existing.broughtLines.isEmpty)
    }

    func testCase59WeeklyTaskReferencesThePassedDays() throws {
        let fixture = try loadFixture(59)
        XCTAssertEqual(fixture.expected, "Shows in references of each day Jan 9 to 15, 2017")
        let days = (9...15).map { date(2017, 1, $0) }
        let week = ExternalFormatReader.readWeekly(fixture.input, containing: date(2017, 1, 11))
        XCTAssertEqual(week.days, days)
        XCTAssertEqual(week.lines.count, 1)
        XCTAssertEqual(week.lines[0].kind, .openTask)
        XCTAssertEqual(week.lines[0].referencedDays, days)
        for day in days {
            XCTAssertTrue(ExternalFormatReader.references(week.lines[0], on: day))
        }
        XCTAssertFalse(ExternalFormatReader.references(week.lines[0], on: date(2017, 1, 8)))
        XCTAssertFalse(ExternalFormatReader.references(week.lines[0], on: date(2017, 1, 16)))
    }

    func testWeeklyNoteWithASundayStartListsEveryItem() {
        let text = "* Open item\n* [x] Done item\n- Bullet item\n"
        let week = ExternalFormatReader.readWeekly(
            text,
            containing: date(2017, 1, 9),
            weekStart: ExternalWeekStart(firstDay: .sunday)
        )
        let days = (8...14).map { date(2017, 1, $0) }
        XCTAssertEqual(week.days, days)
        XCTAssertEqual(week.lines.count, 3)
        XCTAssertEqual(week.lines[0].kind, .openTask)
        XCTAssertEqual(week.lines[1].kind, .doneTask)
        XCTAssertEqual(week.lines[2].kind, .bullet)
        for line in week.lines {
            XCTAssertEqual(line.referencedDays, days)
        }
        XCTAssertFalse(week.lines[0].referencedDays.contains(date(2017, 1, 15)))
    }

    func testCase61OpenChecklistDoesNotMakeTheDayOverdue() throws {
        let (fixture, line, note) = try oneLineNote(61)
        XCTAssertEqual(fixture.expected, "Not in Overdue; does not make the day count as overdue on iPhone")
        XCTAssertEqual(note.context, .day(date(2017, 1, 9)))
        XCTAssertEqual(line.kind, .openChecklist)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.leftOutOfOverdue)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: note.context), .unlisted)
        XCTAssertFalse(ExternalFormatReader.dayCountsAsOverdue(note, on: sessionDay))
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
        XCTAssertEqual(ExternalFormatReader.placement(of: spaces.lines[0], on: sessionDay, in: .project), .unlisted)
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

    func testNonASCIILineKeepsAWikiLink() {
        let line = ExternalFormatReader.read("See [[Café]] today", in: .project).lines[0]
        XCTAssertEqual(line.wikiLinks.map(\.target), ["Café"])
        XCTAssertTrue(line.markdownLinks.isEmpty)
    }

    func testNonASCIILineKeepsAMarkdownLink() {
        let line = ExternalFormatReader.read("See [café](notes/cafe) today", in: .project).lines[0]
        XCTAssertEqual(line.markdownLinks.map(\.shownText), ["café"])
        XCTAssertEqual(line.markdownLinks.map(\.address), ["notes/cafe"])
        XCTAssertTrue(line.wikiLinks.isEmpty)
    }

    func testUnclosedBracketLineStaysWithinTheTimeBound() {
        printMemory("bracket-bound-start", seconds: 0)
        let line = String(repeating: "[", count: 1_000_000)
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing bracket-bound \(elapsed)")
        printMemory("bracket-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
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
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
    }

    func testCheckedChecklistBoxIsUnsettledAndUnlisted() {
        let line = ExternalFormatReader.read("+ [x] Pack fake socks >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .unsettled)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
    }

    func testAtDateIsFlaggedAndTheLineStays() {
        let line = ExternalFormatReader.read("* Fake meeting prep @2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertTrue(line.mentions.isEmpty)
        XCTAssertTrue(line.scheduleDates.isEmpty)
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(line.flaggedTokens, ["@2017-01-10"])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
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
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[1], on: sessionDay, in: .project), .unlisted)
        XCTAssertEqual(note.lines[3].kind, .openTask)
        XCTAssertEqual(note.lines[3].scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[3], on: sessionDay, in: .project), .overdue)
    }

    func testDatelessOpenTaskInTodayOrAFutureDayIsUpcoming() {
        let project = ExternalFormatReader.read("* Open", in: .project).lines[0]
        XCTAssertEqual(ExternalFormatReader.placement(of: project, on: sessionDay, in: .project), .unlisted)
        let today = ExternalFormatReader.read("* Open", in: .day(sessionDay)).lines[0]
        XCTAssertEqual(today.kind, .openTask)
        XCTAssertTrue(today.scheduleDates.isEmpty)
        XCTAssertEqual(
            ExternalFormatReader.placement(of: today, on: sessionDay, in: .day(sessionDay)),
            .upcoming
        )
        let futureDay = date(2031, 3, 3)
        let future = ExternalFormatReader.read("* Open", in: .day(futureDay)).lines[0]
        XCTAssertEqual(ExternalFormatReader.placement(of: future, on: sessionDay, in: .day(futureDay)), .upcoming)
        let pastDay = date(2017, 1, 9)
        let later = ExternalFormatReader.read("* Later >2031-03-03", in: .day(pastDay)).lines[0]
        XCTAssertEqual(later.scheduleDates, [date(2031, 3, 3)])
        XCTAssertEqual(ExternalFormatReader.placement(of: later, on: sessionDay, in: .day(pastDay)), .upcoming)
    }

    func testFlaggedTokensStayInTheirLists() throws {
        let bug = ExternalFormatReader.read("* Fix bug #123 >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(bug.kind, .openTask)
        XCTAssertTrue(bug.countsAsOpen)
        XCTAssertTrue(bug.tags.isEmpty)
        XCTAssertEqual(bug.flaggedTokens, ["#123"])
        XCTAssertEqual(bug.scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: bug, on: sessionDay, in: .project), .overdue)

        let see = ExternalFormatReader.read("* Read docs (see #3) >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(see.kind, .openTask)
        XCTAssertTrue(see.tags.isEmpty)
        XCTAssertEqual(see.flaggedTokens, ["#3"])
        XCTAssertEqual(see.scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: see, on: sessionDay, in: .project), .overdue)

        let follow = ExternalFormatReader.read("* Call Zed #follow-up", in: .project).lines[0]
        XCTAssertEqual(follow.kind, .openTask)
        XCTAssertTrue(follow.countsAsOpen)
        XCTAssertTrue(follow.tags.isEmpty)
        XCTAssertEqual(follow.flaggedTokens, ["#follow-up"])
        XCTAssertTrue(follow.scheduleDates.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: follow, on: sessionDay, in: .project), .unlisted)

        let link = ExternalFormatReader.read(
            "* Read https://example.test/#section-two >2017-01-10",
            in: .project
        ).lines[0]
        XCTAssertEqual(link.kind, .openTask)
        XCTAssertTrue(link.tags.isEmpty)
        XCTAssertEqual(link.flaggedTokens, ["#section-two"])
        XCTAssertEqual(link.scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: link, on: sessionDay, in: .project), .overdue)

        let meeting = ExternalFormatReader.read("Meeting @2017-01-10", in: .project).lines[0]
        XCTAssertEqual(meeting.kind, .plain)
        XCTAssertTrue(meeting.mentions.isEmpty)
        XCTAssertTrue(meeting.scheduleDates.isEmpty)
        XCTAssertEqual(meeting.flaggedTokens, ["@2017-01-10"])
        XCTAssertEqual(ExternalFormatReader.placement(of: meeting, on: sessionDay, in: .project), .unlisted)

        let heading = ExternalFormatReader.read(
            "## 09:00 - 11:00 Focus #deep-work",
            in: .day(date(2017, 1, 9))
        ).lines[0]
        XCTAssertEqual(heading.kind, .heading(level: 2))
        XCTAssertTrue(heading.tags.isEmpty)
        XCTAssertEqual(heading.flaggedTokens, ["#deep-work"])
        let block = try XCTUnwrap(heading.timeBlock)
        XCTAssertEqual(block.start, ExternalClockTime(hour: 9, minute: 0))
        XCTAssertEqual(block.end, ExternalClockTime(hour: 11, minute: 0))
        XCTAssertEqual(block.day, date(2017, 1, 9))
    }

    func testEmojiCanBePartOfATag() {
        let line = ExternalFormatReader.read("* c94 zzrea emoji tag #📌zzrea", in: .project).lines[0]
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertEqual(line.tags, [ExternalTag(name: "📌zzrea", parent: nil)])
        let nested = ExternalFormatReader.read("* Task #📌/zzrea", in: .project).lines[0]
        XCTAssertEqual(nested.kind, .openTask)
        XCTAssertEqual(nested.tags, [ExternalTag(name: "📌/zzrea", parent: "📌")])
        let mention = ExternalFormatReader.read("* Hey @📌zed", in: .project).lines[0]
        XCTAssertEqual(mention.mentions, [ExternalMention(name: "📌zed", value: nil)])
        let brand = ExternalFormatReader.read("* Item #brand™", in: .project).lines[0]
        XCTAssertEqual(brand.tags, [ExternalTag(name: "brand", parent: nil)])
        XCTAssertTrue(brand.flaggedTokens.isEmpty)
        let copy = ExternalFormatReader.read("* Item #brand©", in: .project).lines[0]
        XCTAssertEqual(copy.tags, [ExternalTag(name: "brand", parent: nil)])
        XCTAssertTrue(copy.flaggedTokens.isEmpty)
        let registered = ExternalFormatReader.read("* Item #brand®", in: .project).lines[0]
        XCTAssertEqual(registered.tags, [ExternalTag(name: "brand", parent: nil)])
        XCTAssertTrue(registered.flaggedTokens.isEmpty)
    }

    func testHyphenatedTagIsFlaggedAndTheLineStays() {
        let line = ExternalFormatReader.read("* c95 zzrea hyphen tag #zzrea-hy-phen.", in: .project).lines[0]
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertTrue(line.tags.isEmpty)
        XCTAssertEqual(line.flaggedTokens, ["#zzrea-hy-phen"])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
    }

    func testDigitsOnlyTagIsFlaggedAndTheLineStays() {
        let count = ExternalFormatReader.read("* Fake count #123", in: .project).lines[0]
        XCTAssertEqual(count.kind, .openTask)
        XCTAssertTrue(count.countsAsOpen)
        XCTAssertTrue(count.tags.isEmpty)
        XCTAssertEqual(count.flaggedTokens, ["#123"])
        XCTAssertEqual(ExternalFormatReader.placement(of: count, on: sessionDay, in: .project), .unlisted)
        let year = ExternalFormatReader.read("* c96 zzrea digits tag #2017", in: .project).lines[0]
        XCTAssertEqual(year.kind, .openTask)
        XCTAssertTrue(year.tags.isEmpty)
        XCTAssertEqual(year.flaggedTokens, ["#2017"])
        let nestedDigits = ExternalFormatReader.read("* Count #12/34", in: .project).lines[0]
        XCTAssertEqual(nestedDigits.kind, .openTask)
        XCTAssertTrue(nestedDigits.tags.isEmpty)
        XCTAssertEqual(nestedDigits.flaggedTokens, ["#12/34"])
        let mixed = ExternalFormatReader.read("* Year #zz/2017", in: .project).lines[0]
        XCTAssertEqual(mixed.kind, .openTask)
        XCTAssertEqual(mixed.tags, [ExternalTag(name: "zz/2017", parent: "zz")])
        XCTAssertTrue(mixed.flaggedTokens.isEmpty)
    }

    func testClosedTaskDropsOnlyTheTimeBlock() {
        let day = date(2017, 1, 9)
        let line = ExternalFormatReader.read(
            "* [x] Call at 10:30 @done(2017-01-09)",
            in: .day(day)
        ).lines[0]
        XCTAssertEqual(line.kind, .doneTask)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertNil(line.timeBlock)
        XCTAssertEqual(line.completion, ExternalCompletion(day: day, time: nil))
        XCTAssertEqual(line.mentions, [ExternalMention(name: "done", value: "2017-01-09")])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .day(day)), .unlisted)
        let cancelled = ExternalFormatReader.read("* [-] Call at 10:30", in: .day(day)).lines[0]
        XCTAssertEqual(cancelled.kind, .cancelledTask)
        XCTAssertNil(cancelled.timeBlock)
        let moved = ExternalFormatReader.read("* [>] Call at 10:30 >2031-03-03", in: .project).lines[0]
        XCTAssertEqual(moved.kind, .scheduledTask)
        XCTAssertEqual(moved.scheduleDates, [date(2031, 3, 3)])
        XCTAssertNil(moved.timeBlock)
        XCTAssertEqual(ExternalFormatReader.placement(of: moved, on: sessionDay, in: .project), .unlisted)
    }

    func testFenceUnsettlesPlainLinesAndBullets() {
        let text = "~~~\n* task #zzcode >2017-01-10\n- bullet #zzhome >2017-01-11\nplain #zzhome\n~~~\n* Outside >2017-01-10\n"
        let note = ExternalFormatReader.read(text, in: .project)
        XCTAssertEqual(note.lines[1].kind, .unsettled)
        XCTAssertTrue(note.lines[1].tags.isEmpty)
        XCTAssertTrue(note.lines[1].scheduleDates.isEmpty)
        XCTAssertEqual(note.lines[2].kind, .unsettled)
        XCTAssertTrue(note.lines[2].tags.isEmpty)
        XCTAssertTrue(note.lines[2].scheduleDates.isEmpty)
        XCTAssertTrue(note.lines[2].referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[2], on: sessionDay, in: .project), .unlisted)
        XCTAssertEqual(note.lines[3].kind, .unsettled)
        XCTAssertTrue(note.lines[3].tags.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[3], on: sessionDay, in: .project), .unlisted)
        XCTAssertEqual(note.lines[5].kind, .openTask)
        XCTAssertEqual(note.lines[5].scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[5], on: sessionDay, in: .project), .overdue)
        let open = ExternalFormatReader.read("```\n* inside\n- kept #zzhome >2017-01-11\n", in: .project)
        XCTAssertEqual(open.lines[1].kind, .unsettled)
        XCTAssertEqual(open.lines[2].kind, .unsettled)
        XCTAssertTrue(open.lines[2].tags.isEmpty)
        XCTAssertTrue(open.lines[2].scheduleDates.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: open.lines[2], on: sessionDay, in: .project), .unlisted)
    }

    func testFenceUnsettlesHeadingsAndChecklistItems() {
        let day = date(2017, 1, 9)
        let heading = ExternalFormatReader.read("```\n## h #zz 09:00\n```\n", in: .day(day))
        XCTAssertEqual(heading.lines[1].kind, .unsettled)
        XCTAssertNil(heading.lines[1].timeBlock)
        XCTAssertTrue(heading.lines[1].tags.isEmpty)
        XCTAssertTrue(heading.lines[1].flaggedTokens.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: heading.lines[1], on: sessionDay, in: .day(day)), .unlisted)

        let check = ExternalFormatReader.read("```\n+ c #zz\n+ c #zz >2017-01-10\n```\n", in: .project)
        XCTAssertEqual(check.lines[1].kind, .unsettled)
        XCTAssertTrue(check.lines[1].tags.isEmpty)
        XCTAssertTrue(check.lines[1].scheduleDates.isEmpty)
        XCTAssertNil(check.lines[1].timeBlock)
        XCTAssertEqual(check.lines[2].kind, .unsettled)
        XCTAssertTrue(check.lines[2].tags.isEmpty)
        XCTAssertTrue(check.lines[2].scheduleDates.isEmpty)
        XCTAssertTrue(check.lines[2].referencedDays.isEmpty)
        XCTAssertNil(check.lines[2].timeBlock)
        XCTAssertEqual(ExternalFormatReader.placement(of: check.lines[2], on: sessionDay, in: .project), .unlisted)
    }

    func testFenceClosesOnlyOnTheSameMarker() {
        let tilde = ExternalFormatReader.read(
            "```\n* inside #zz\n~~~\n* still #zz >2017-01-10\n```\n* Outside >2017-01-10\n",
            in: .project
        )
        XCTAssertEqual(tilde.lines[1].kind, .unsettled)
        XCTAssertTrue(tilde.lines[1].tags.isEmpty)
        XCTAssertEqual(tilde.lines[2].kind, .unsettled)
        XCTAssertEqual(tilde.lines[3].kind, .unsettled)
        XCTAssertTrue(tilde.lines[3].tags.isEmpty)
        XCTAssertTrue(tilde.lines[3].scheduleDates.isEmpty)
        XCTAssertEqual(tilde.lines[5].kind, .openTask)
        XCTAssertEqual(tilde.lines[5].scheduleDates, [date(2017, 1, 10)])

        let shorter = ExternalFormatReader.read(
            "````\nplain #zz\n```\nplain #yy >2017-01-11\n````\n* Out >2017-01-10\n",
            in: .project
        )
        XCTAssertEqual(shorter.lines[1].kind, .unsettled)
        XCTAssertTrue(shorter.lines[1].tags.isEmpty)
        XCTAssertEqual(shorter.lines[2].kind, .unsettled)
        XCTAssertEqual(shorter.lines[3].kind, .unsettled)
        XCTAssertTrue(shorter.lines[3].tags.isEmpty)
        XCTAssertTrue(shorter.lines[3].scheduleDates.isEmpty)
        XCTAssertEqual(shorter.lines[5].kind, .openTask)
        XCTAssertEqual(shorter.lines[5].scheduleDates, [date(2017, 1, 10)])

        let longer = ExternalFormatReader.read("```\nplain #zz\n````\n* Out >2017-01-10\n", in: .project)
        XCTAssertEqual(longer.lines[1].kind, .unsettled)
        XCTAssertTrue(longer.lines[1].tags.isEmpty)
        XCTAssertEqual(longer.lines[3].kind, .openTask)
        XCTAssertEqual(longer.lines[3].scheduleDates, [date(2017, 1, 10)])
    }

    func testInfoStringDoesNotCloseAFence() {
        let stays = ExternalFormatReader.read("```\n* inside #zz\n``` js #yy\n* Out #ok >2017-01-10\n", in: .project)
        XCTAssertEqual(stays.lines[0].kind, .unsettled)
        XCTAssertTrue(stays.lines[0].tags.isEmpty)
        XCTAssertEqual(stays.lines[1].kind, .unsettled)
        XCTAssertTrue(stays.lines[1].tags.isEmpty)
        XCTAssertEqual(stays.lines[2].kind, .unsettled)
        XCTAssertTrue(stays.lines[2].tags.isEmpty)
        XCTAssertEqual(stays.lines[3].kind, .unsettled)
        XCTAssertTrue(stays.lines[3].tags.isEmpty)
        XCTAssertTrue(stays.lines[3].scheduleDates.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: stays.lines[3], on: sessionDay, in: .project), .unlisted)

        let closed = ExternalFormatReader.read(
            "``` js #zz\n* inside #yy\n```\n* Out #ok >2017-01-10\n",
            in: .project
        )
        XCTAssertEqual(closed.lines[0].kind, .unsettled)
        XCTAssertTrue(closed.lines[0].tags.isEmpty)
        XCTAssertEqual(closed.lines[1].kind, .unsettled)
        XCTAssertTrue(closed.lines[1].tags.isEmpty)
        XCTAssertEqual(closed.lines[2].kind, .unsettled)
        XCTAssertTrue(closed.lines[2].tags.isEmpty)
        XCTAssertEqual(closed.lines[3].kind, .openTask)
        XCTAssertEqual(closed.lines[3].tags.map(\.name), ["ok"])
        XCTAssertEqual(closed.lines[3].scheduleDates, [date(2017, 1, 10)])

        let tilde = ExternalFormatReader.read("~~~\nplain #zz\n~~~ js\nplain #yy\n~~~\n* Out\n", in: .project)
        XCTAssertEqual(tilde.lines[1].kind, .unsettled)
        XCTAssertTrue(tilde.lines[1].tags.isEmpty)
        XCTAssertEqual(tilde.lines[2].kind, .unsettled)
        XCTAssertTrue(tilde.lines[2].tags.isEmpty)
        XCTAssertEqual(tilde.lines[3].kind, .unsettled)
        XCTAssertTrue(tilde.lines[3].tags.isEmpty)
        XCTAssertEqual(tilde.lines[5].kind, .openTask)
    }

    func testUnclosedMentionDoesNotSwallowALaterParen() {
        let line = ExternalFormatReader.read("See @a( then #zz and @b(ok)", in: .project).lines[0]
        XCTAssertEqual(line.mentions, [
            ExternalMention(name: "a", value: nil),
            ExternalMention(name: "b", value: "ok"),
        ])
        XCTAssertEqual(line.tags, [ExternalTag(name: "zz", parent: nil)])
        XCTAssertTrue(line.flaggedTokens.isEmpty)
        let stray = ExternalFormatReader.read("See @a( #zz )", in: .project).lines[0]
        XCTAssertEqual(stray.mentions, [ExternalMention(name: "a", value: nil)])
        XCTAssertEqual(stray.tags, [ExternalTag(name: "zz", parent: nil)])
    }

    func testRejectedWikiDoesNotHideALaterLink() {
        let line = ExternalFormatReader.read("See [[#nope]] and [[Note]]", in: .project).lines[0]
        XCTAssertEqual(line.wikiLinks.map(\.target), ["Note"])
        XCTAssertEqual(line.tags.map(\.name), ["nope"])
    }

    func testRejectedWikiKeepsItsTag() {
        let text = "See [[#heading]]"
        let line = ExternalFormatReader.read(text, in: .project).lines[0]
        XCTAssertTrue(line.wikiLinks.isEmpty)
        XCTAssertEqual(line.tags, [ExternalTag(name: "heading", parent: nil)])
        var work: ExternalFormatScanWork?
        let characters = ExternalFormatReader.read(text, in: .project, work: &work, route: .characters).lines[0]
        XCTAssertEqual(characters.tags, line.tags)
        XCTAssertEqual(characters.wikiLinks, line.wikiLinks)
        let titled = ExternalFormatReader.read("See [[Market List#Dairy]]", in: .project).lines[0]
        XCTAssertEqual(titled.wikiLinks.map(\.target), ["Market List"])
        XCTAssertEqual(titled.wikiLinks.first?.heading, "Dairy")
        XCTAssertTrue(titled.tags.isEmpty)
        let nested = ExternalFormatReader.read("See [[ #zz [[Note]]", in: .project).lines[0]
        XCTAssertEqual(nested.tags.map(\.name), ["zz"])
        XCTAssertEqual(nested.wikiLinks.map(\.target), ["Note"])
    }

    /// `[[#heading]]` and an empty target stay rejected. `[[Market List#Dairy]]` stays a link.
    func testEmptyOrHashedWikiTargetKeepsTheSameReading() {
        let hashed = ExternalFormatReader.read("[[#heading]]", in: .project).lines[0]
        XCTAssertEqual(hashed.kind, .plain)
        XCTAssertTrue(hashed.wikiLinks.isEmpty)
        XCTAssertTrue(hashed.markdownLinks.isEmpty)
        XCTAssertEqual(hashed.tags, [ExternalTag(name: "heading", parent: nil)])

        let empty = ExternalFormatReader.read("[[]]", in: .project).lines[0]
        XCTAssertEqual(empty.kind, .plain)
        XCTAssertTrue(empty.wikiLinks.isEmpty)
        XCTAssertTrue(empty.tags.isEmpty)
        XCTAssertTrue(empty.markdownLinks.isEmpty)
        XCTAssertTrue(empty.flaggedTokens.isEmpty)

        let alias = ExternalFormatReader.read("[[|alias]]", in: .project).lines[0]
        XCTAssertEqual(alias.kind, .plain)
        XCTAssertTrue(alias.wikiLinks.isEmpty)
        XCTAssertTrue(alias.tags.isEmpty)
        XCTAssertTrue(alias.markdownLinks.isEmpty)
        XCTAssertTrue(alias.flaggedTokens.isEmpty)

        let titled = ExternalFormatReader.read("[[Market List#Dairy]]", in: .project).lines[0]
        XCTAssertEqual(
            titled.wikiLinks,
            [ExternalWikiLink(target: "Market List", heading: "Dairy", shownText: nil, day: nil)]
        )
        XCTAssertTrue(titled.tags.isEmpty)
        XCTAssertTrue(titled.markdownLinks.isEmpty)

        let keycap = ExternalFormatReader.read("[[#️⃣ Notes]]", in: .project).lines[0]
        XCTAssertEqual(
            keycap.wikiLinks,
            [ExternalWikiLink(target: "#️⃣ Notes", heading: nil, shownText: nil, day: nil)]
        )
        XCTAssertTrue(keycap.tags.isEmpty)
        XCTAssertTrue(keycap.markdownLinks.isEmpty)

        let combining = ExternalFormatReader.read("[[#\u{301}x]]", in: .project).lines[0]
        XCTAssertEqual(
            combining.wikiLinks,
            [ExternalWikiLink(target: "#\u{301}x", heading: nil, shownText: nil, day: nil)]
        )
        XCTAssertTrue(combining.tags.isEmpty)
        XCTAssertTrue(combining.markdownLinks.isEmpty)

        for text in ["[[#heading]]", "[[]]", "[[|alias]]", "[[Market List#Dairy]]", "[[#️⃣ Notes]]", "[[#\u{301}x]]"] {
            var work: ExternalFormatScanWork?
            let characters = ExternalFormatReader.read(text, in: .project, work: &work, route: .characters).lines[0]
            let bytes = ExternalFormatReader.read(text, in: .project).lines[0]
            XCTAssertEqual(characters, bytes, text)
        }
    }

    func testLooseHashInsideAMentionKeepsTheValue() {
        let text = "See @a(item # 3)"
        let line = ExternalFormatReader.read(text, in: .project).lines[0]
        XCTAssertEqual(line.mentions, [ExternalMention(name: "a", value: "item # 3")])
        XCTAssertTrue(line.tags.isEmpty)
        var work: ExternalFormatScanWork?
        let characters = ExternalFormatReader.read(text, in: .project, work: &work, route: .characters).lines[0]
        XCTAssertEqual(characters.mentions, line.mentions)
        XCTAssertEqual(characters.tags, line.tags)
    }

    func testRealTagInsideAMentionEndsTheValue() {
        let text = "See @a(item #zz more)"
        let line = ExternalFormatReader.read(text, in: .project).lines[0]
        XCTAssertEqual(line.mentions, [ExternalMention(name: "a", value: nil)])
        XCTAssertEqual(line.tags, [ExternalTag(name: "zz", parent: nil)])
        var work: ExternalFormatScanWork?
        let characters = ExternalFormatReader.read(text, in: .project, work: &work, route: .characters).lines[0]
        XCTAssertEqual(characters.mentions, line.mentions)
        XCTAssertEqual(characters.tags, line.tags)
    }

    func testRejectedWikiLineStaysWithinTheTimeBound() {
        printMemory("wiki-bound-start", seconds: 0)
        let line = String(repeating: "[[#", count: 350_000) + "]]"
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing wiki-bound \(elapsed)")
        printMemory("wiki-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertTrue(note.lines[0].wikiLinks.isEmpty)
    }

    func testUnclosedMentionParenStaysWithinTheTimeBound() {
        printMemory("mention-bound-start", seconds: 0)
        let line = String(repeating: "@a(", count: 350_000)
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing mention-bound \(elapsed)")
        printMemory("mention-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertFalse(note.lines[0].mentions.isEmpty)
    }

    func testCase73CopyKeepsTheTagsAndTheMention() {
        let result = ExternalFormatReader.bringForward(
            line: "* c66 Fake move with extras #zzmove @Zed_Tester",
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 10),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            result,
            .edited(
                sourceLine: "* [>] c66 Fake move with extras #zzmove @Zed_Tester >2017-01-10",
                addedLine: "* c66 Fake move with extras #zzmove @Zed_Tester <2017-01-09"
            )
        )
        let added = "* c66 Fake move with extras #zzmove @Zed_Tester <2017-01-09"
        let copy = ExternalFormatReader.read(added, in: .day(date(2017, 1, 10))).lines[0]
        XCTAssertEqual(copy.kind, .openTask)
        XCTAssertEqual(copy.tags, [ExternalTag(name: "zzmove", parent: nil)])
        XCTAssertEqual(copy.mentions, [ExternalMention(name: "Zed_Tester", value: nil)])
        XCTAssertEqual(copy.broughtFromDays, [date(2017, 1, 9)])
    }

    func testBringForwardModesAreDistinct() {
        let line = "* Fake move once"
        let origin = ExternalNoteContext.day(date(2017, 1, 9))
        let target = date(2017, 1, 10)
        let copy = ExternalFormatReader.bringForward(line: line, in: origin, to: target, mode: .scheduleByCopy)
        let link = ExternalFormatReader.bringForward(line: line, in: origin, to: target, mode: .scheduleByLink)
        let cut = ExternalFormatReader.bringForward(line: line, in: origin, to: target, mode: .cutAndPaste)
        XCTAssertEqual(
            copy,
            .edited(sourceLine: "* [>] Fake move once >2017-01-10", addedLine: "* Fake move once <2017-01-09")
        )
        XCTAssertEqual(link, .edited(sourceLine: "* Fake move once [[2017-01-10]]", addedLine: nil))
        XCTAssertEqual(cut, .edited(sourceLine: nil, addedLine: line))
        let linked = ExternalFormatReader.read("* Fake move once [[2017-01-10]]", in: origin).lines[0]
        XCTAssertEqual(linked.kind, .openTask)
        XCTAssertEqual(linked.referencedDays, [target])
        XCTAssertTrue(linked.scheduleDates.isEmpty)
        let project = ExternalFormatReader.bringForward(
            line: "* Send fake invoice",
            in: .project,
            to: date(2017, 1, 10),
            mode: .scheduleByLink
        )
        XCTAssertEqual(project, .edited(sourceLine: "* Send fake invoice >2017-01-10", addedLine: nil))
        let fromProject = ExternalFormatReader.bringForward(
            line: "* Send fake invoice",
            in: .project,
            to: date(2017, 1, 10),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(fromProject, .unsettled)
        let boxed = ExternalFormatReader.bringForward(
            line: "* [ ] Boxed",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            boxed,
            .edited(sourceLine: "* [>] Boxed >2017-01-10", addedLine: "* [ ] Boxed <2017-01-09")
        )
    }

    func testScheduledSelectionCopiesAHeadingAndSkipsClosedTasks() {
        let lines = [
            "## Focus",
            "* Open task",
            "* [x] Done task",
            "* [-] Cancelled task",
            "* [>] Already moved >2017-01-12",
            "+ Checklist item",
        ]
        let results = ExternalFormatReader.bringForward(
            lines: lines,
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 10),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(results[0], .edited(sourceLine: "## Focus", addedLine: "## Focus"))
        XCTAssertEqual(
            results[1],
            .edited(sourceLine: "* [>] Open task >2017-01-10", addedLine: "* Open task <2017-01-09")
        )
        XCTAssertEqual(results[2], .skipped)
        XCTAssertEqual(results[3], .skipped)
        XCTAssertEqual(results[4], .skipped)
        XCTAssertEqual(results[5], .unsettled)
        let children = ExternalFormatReader.bringForward(
            lines: ["* Fake parent", "\t* open child", "\t* [x] done child", "\t- bullet child"],
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 10),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(children[0], .unsettled)
        XCTAssertEqual(children[1], .unsettled)
        XCTAssertEqual(children[2], .unsettled)
        XCTAssertEqual(children[3], .unsettled)
    }

    func testSyncIdOrRemindOrDoneStampOnACopyStaysUnsettled() {
        let origin = ExternalNoteContext.day(date(2017, 1, 9))
        let target = date(2017, 1, 10)
        let synced = ExternalFormatReader.bringForward(
            line: "* Fake synced ^zz1abc",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(synced, .unsettled)
        let remind = ExternalFormatReader.bringForward(
            line: "* Call @remind(2pm)",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(remind, .unsettled)
        let stamped = ExternalFormatReader.bringForward(
            line: "* Mail the parcel @done(2017-01-09)",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(stamped, .unsettled)
        let shortId = ExternalFormatReader.bringForward(
            line: "* Fake synced ^AB12",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(shortId, .unsettled)
        let glued = ExternalFormatReader.bringForward(
            line: "* task^ab",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(glued, .unsettled)
        let accented = ExternalFormatReader.bringForward(
            line: "* Fake synced ^zz1abé",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            accented,
            .edited(
                sourceLine: "* [>] Fake synced ^zz1abé >2017-01-10",
                addedLine: "* Fake synced ^zz1abé <2017-01-09"
            )
        )
        let notAtEnd = ExternalFormatReader.bringForward(
            line: "* Fake ^zz1abc still open",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            notAtEnd,
            .edited(
                sourceLine: "* [>] Fake ^zz1abc still open >2017-01-10",
                addedLine: "* Fake ^zz1abc still open <2017-01-09"
            )
        )
    }

    func testMoveToTheSameDayOrAnEarlierDayStaysUnsettled() {
        let line = "* Fake move once"
        let origin = ExternalNoteContext.day(date(2017, 1, 10))
        for mode in [ExternalBringForwardMode.scheduleByCopy, .scheduleByLink, .cutAndPaste] {
            XCTAssertEqual(
                ExternalFormatReader.bringForward(line: line, in: origin, to: date(2017, 1, 10), mode: mode),
                .unsettled
            )
            XCTAssertEqual(
                ExternalFormatReader.bringForward(line: line, in: origin, to: date(2017, 1, 9), mode: mode),
                .unsettled
            )
        }
    }

    func testLinkModeLeavesAHeadingUnsettled() {
        let result = ExternalFormatReader.bringForward(
            line: "## Focus",
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 10),
            mode: .scheduleByLink
        )
        XCTAssertEqual(result, .unsettled)
    }

    func testMoveCountOfAFencedTaskStaysUnsettled() {
        let notes = [
            ExternalDayText(
                day: date(2017, 1, 9),
                text: "```\n* [>] Task >2017-01-10\n```\n"
            ),
        ]
        XCTAssertNil(ExternalFormatReader.moveCount(ofLineAt: 1, on: date(2017, 1, 9), in: notes))
    }

    func testMoveCountOfALongChainStaysWithinTheTimeBound() {
        let total = 20_000
        var day = date(2000, 1, 1)
        var notes: [ExternalDayText] = []
        notes.reserveCapacity(total + 1)
        for _ in 0..<total {
            let next = dayAfter(day)
            notes.append(ExternalDayText(day: day, text: "* [>] Task >" + isoDay(next)))
            day = next
        }
        notes.append(ExternalDayText(day: day, text: "* Task"))
        printMemory("move-count-setup", seconds: 0)
        let started = Date()
        let count = ExternalFormatReader.moveCount(ofLineAt: 0, on: notes[0].day, in: notes)
        let elapsed = Date().timeIntervalSince(started)
        printMemory("move-count", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(count, total as Int?)
    }

    func testMoveCountFollowsScheduledLines() {
        let once = [
            ExternalDayText(day: date(2017, 1, 9), text: "* [>] Fake move once >2017-01-10"),
            ExternalDayText(day: date(2017, 1, 10), text: "* Fake move once <2017-01-09"),
        ]
        XCTAssertEqual(ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 10), in: once), 1 as Int?)
        XCTAssertEqual(ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 9), in: once), 1 as Int?)
        let twice = [
            ExternalDayText(day: date(2017, 1, 9), text: "* [>] Fake move once >2017-01-10"),
            ExternalDayText(day: date(2017, 1, 10), text: "* [>] Fake move once >2017-01-11"),
            ExternalDayText(day: date(2017, 1, 11), text: "* Fake move once <2017-01-10"),
        ]
        XCTAssertEqual(ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 11), in: twice), 2 as Int?)
        let twoMarksOnOneCopy = [
            ExternalDayText(day: date(2017, 1, 9), text: "* [>] Task >2017-01-11"),
            ExternalDayText(
                day: date(2017, 1, 11),
                text: "* Task <2017-01-09 <2017-01-10"
            ),
        ]
        XCTAssertEqual(
            ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 11), in: twoMarksOnOneCopy),
            1 as Int?
        )
        let marksOnly = [
            ExternalDayText(day: date(2017, 1, 11), text: "* Task <2017-01-09 <2017-01-10"),
        ]
        XCTAssertEqual(ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 11), in: marksOnly), 0 as Int?)
        let twoDates = [
            ExternalDayText(day: date(2017, 1, 9), text: "* [>] Task >2017-01-10 >2017-01-11"),
        ]
        XCTAssertNil(ExternalFormatReader.moveCount(ofLineAt: 0, on: date(2017, 1, 9), in: twoDates))
    }

    func testCase53SecondMoveStaysUnsettled() {
        let result = ExternalFormatReader.bringForward(
            line: "* Fake move once <2017-01-09",
            in: .day(date(2017, 1, 10)),
            to: date(2017, 1, 11),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(result, .unsettled)
    }

    func testSchedulingALineThatAlreadyHasADateStaysUnsettled() {
        let copy = ExternalFormatReader.bringForward(
            line: "* c67 Fake dated >2017-01-12",
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 11),
            mode: .scheduleByCopy
        )
        XCTAssertEqual(copy, .unsettled)
        let link = ExternalFormatReader.bringForward(
            line: "* c67 Fake dated >2017-01-12",
            in: .day(date(2017, 1, 9)),
            to: date(2017, 1, 11),
            mode: .scheduleByLink
        )
        XCTAssertEqual(link, .unsettled)
    }

    func testCase80DueOnThePassedDayIsUpcoming() {
        let line = ExternalFormatReader.read("* c69 Fake due today >2026-10-24", in: .project).lines[0]
        XCTAssertEqual(line.scheduleDates, [sessionDay])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .upcoming)
    }

    func testCase81DueBeforeThePassedDayIsOverdue() {
        let line = ExternalFormatReader.read("* c70 Fake due yesterday >2026-10-23", in: .project).lines[0]
        XCTAssertEqual(line.scheduleDates, [date(2026, 10, 23)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .overdue)
    }

    func testCase86OpenTaskWithNoDateInAPastDayIsOverdue() {
        let day = date(2017, 1, 16)
        let note = ExternalFormatReader.read("* c86 zzrea left open, no date", in: .day(day))
        XCTAssertEqual(note.lines[0].kind, .openTask)
        XCTAssertTrue(note.lines[0].scheduleDates.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[0], on: sessionDay, in: note.context), .overdue)
        XCTAssertTrue(ExternalFormatReader.dayCountsAsOverdue(note, on: sessionDay))
        let opened = ExternalFormatReader.openDay(
            existingText: nil,
            template: nil,
            earlierNotes: [ExternalDayText(day: day, text: "* c86 zzrea left open, no date")],
            today: sessionDay
        )
        XCTAssertEqual(opened.text, "")
        XCTAssertTrue(opened.broughtLines.isEmpty)
    }

    func testCase90OpenCopyInAPastDayIsOverdue() {
        let day = date(2017, 1, 17)
        let note = ExternalFormatReader.read("* c87 zzrea move away <2017-01-16", in: .day(day))
        XCTAssertEqual(note.lines[0].kind, .openTask)
        XCTAssertTrue(note.lines[0].countsAsOpen)
        XCTAssertEqual(note.lines[0].broughtFromDays, [date(2017, 1, 16)])
        XCTAssertTrue(note.lines[0].scheduleDates.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: note.lines[0], on: sessionDay, in: note.context), .overdue)
        XCTAssertTrue(ExternalFormatReader.dayCountsAsOverdue(note, on: sessionDay))
    }

    func testMovedAwayTaskInAProjectNoteWithAPastDateStaysUnlisted() {
        let line = ExternalFormatReader.read("* [>] Stay in the note >2017-01-10", in: .project).lines[0]
        XCTAssertEqual(line.kind, .scheduledTask)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 10)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
        let listed = ExternalFormatReader.viewListing(of: line, on: sessionDay, in: .project)
        XCTAssertEqual(listed.calendar, .unlisted)
        XCTAssertEqual(listed.notes, .unlisted)
        XCTAssertFalse(listed.staysInOverdue)
    }

    func testCase123OpenPastProjectTaskIsOpenInTheCalendarAndScheduledInNotes() {
        let line = ExternalFormatReader.read("* c123 zzrea past project >2017-01-24", in: .project).lines[0]
        XCTAssertEqual(line.kind, .openTask)
        XCTAssertTrue(line.countsAsOpen)
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 24)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .overdue)
        let listed = ExternalFormatReader.viewListing(of: line, on: sessionDay, in: .project)
        XCTAssertEqual(listed.calendar, .open)
        XCTAssertEqual(listed.notes, .scheduled)
        XCTAssertTrue(listed.staysInOverdue)
        XCTAssertEqual(listed.date, date(2017, 1, 24))
    }

    /// The same unclosed `@a(` input at N and 2N. A quadratic closer scan grows by about 4x.
    func testUnclosedMentionParenGrowsLinearly() throws {
        try skipWallClockGrowthOnTheSimulator()
        let count = 900_000
        let smaller = String(repeating: "@a(", count: count)
        let larger = String(repeating: "@a(", count: count * 2)
        let (once, twice) = growthTimes(smaller, larger) { note in
            XCTAssertFalse(note.lines[0].mentions.isEmpty)
        }
        print("reader-timing mention-growth \(once) \(twice) \(twice / once)")
        XCTAssertLessThanOrEqual(twice, once * 3)
    }

    func testClosedMentionParenStaysWithinTheTimeBound() {
        printMemory("mention-closed-bound-start", seconds: 0)
        let line = String(repeating: "@a(", count: 350_000) + ")"
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing mention-closed-bound \(elapsed)")
        printMemory("mention-closed-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertFalse(note.lines[0].mentions.isEmpty)
    }

    func testClosedMentionParenGrowsLinearly() throws {
        try skipWallClockGrowthOnTheSimulator()
        let count = 900_000
        let smaller = String(repeating: "@a(", count: count) + ")"
        let larger = String(repeating: "@a(", count: count * 2) + ")"
        let (once, twice) = growthTimes(smaller, larger) { note in
            XCTAssertFalse(note.lines[0].mentions.isEmpty)
        }
        print("reader-timing mention-closed-growth \(once) \(twice) \(twice / once)")
        XCTAssertLessThanOrEqual(twice, once * 3)
    }

    func testClosedBracketLineStaysWithinTheTimeBound() {
        printMemory("bracket-closed-bound-start", seconds: 0)
        let line = String(repeating: "[a", count: 350_000) + "]"
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing bracket-closed-bound \(elapsed)")
        printMemory("bracket-closed-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertTrue(note.lines[0].markdownLinks.isEmpty)
        XCTAssertTrue(note.lines[0].wikiLinks.isEmpty)
    }

    func testClosedBracketLineGrowsLinearly() throws {
        try skipWallClockGrowthOnTheSimulator()
        let count = 2_000_000
        let smaller = String(repeating: "[a", count: count) + "]"
        let larger = String(repeating: "[a", count: count * 2) + "]"
        let (once, twice) = growthTimes(smaller, larger) { note in
            XCTAssertEqual(note.lines.count, 1)
        }
        print("reader-timing bracket-closed-growth \(once) \(twice) \(twice / once)")
        XCTAssertLessThanOrEqual(twice, once * 3)
    }

    /// simulator wall-clock time varied about 6x on identical input in run 40128432168
    private func skipWallClockGrowthOnTheSimulator() throws {
        #if targetEnvironment(simulator)
        throw XCTSkip("simulator wall-clock time varied about 6x on identical input in run 40128432168")
        #endif
    }

    /// Work counted inside the scan at N and 2N. The same 3x limit on every platform.
    func testScanWorkGrowsLinearly() {
        let count = 100_000
        let samples: [(String, (Int) -> String)] = [
            ("mention", { String(repeating: "@a(", count: $0) }),
            ("mention-closed", { String(repeating: "@a(", count: $0) + ")" }),
            ("bracket-closed", { String(repeating: "[a", count: $0) + "]" }),
            ("wiki", { String(repeating: "[[#", count: $0) + "]]" }),
            ("bracket", { String(repeating: "[", count: $0) }),
            ("non-english", { "é" + String(repeating: "@a(", count: $0) }),
        ]
        var measured: [(String, Int, Int)] = []
        for (name, make) in samples {
            let started = Date()
            let once = scanWork(make(count))
            let twice = scanWork(make(count * 2))
            let elapsed = Date().timeIntervalSince(started)
            print("reader-work \(name) \(once) \(twice) \(Double(twice) / Double(once))")
            printMemory("scan-\(name)", seconds: elapsed)
            measured.append((name, once, twice))
        }
        for (name, once, twice) in measured {
            XCTAssertGreaterThan(once, 0, name)
            XCTAssertLessThanOrEqual(twice, once * 3, name)
        }
    }

    private func scanWork(_ text: String) -> Int {
        var work: ExternalFormatScanWork? = ExternalFormatScanWork()
        _ = ExternalFormatReader.read(text, in: .project, work: &work, route: .automatic)
        return work?.count ?? 0
    }

    func testNonEnglishLineStaysWithinTheTimeBound() {
        printMemory("non-english-bound-start", seconds: 0)
        let line = "é" + String(repeating: "@a(", count: 350_000)
        let started = Date()
        let note = ExternalFormatReader.read(line, in: .project)
        let elapsed = Date().timeIntervalSince(started)
        print("reader-timing non-english-bound \(elapsed)")
        printMemory("non-english-bound-end", seconds: elapsed)
        XCTAssertLessThan(elapsed, 5)
        XCTAssertEqual(note.lines.count, 1)
        XCTAssertFalse(note.lines[0].mentions.isEmpty)
    }

    func testASCIILineMatchesOnTheByteAndCharacterPaths() {
        let text = "* Buy milk #zz @sam(ok) [[Note]] [words](notes/milk) >2017-01-10"
        var byteWork: ExternalFormatScanWork?
        var characterWork: ExternalFormatScanWork?
        let byteLine = ExternalFormatReader.read(text, in: .project, work: &byteWork, route: .automatic).lines[0]
        let characterLine = ExternalFormatReader.read(
            text,
            in: .project,
            work: &characterWork,
            route: .characters
        ).lines[0]
        XCTAssertEqual(byteLine, characterLine)
        XCTAssertEqual(byteLine.kind, .openTask)
        XCTAssertEqual(byteLine.tags.map(\.name), ["zz"])
        XCTAssertEqual(byteLine.mentions, [ExternalMention(name: "sam", value: "ok")])
        XCTAssertEqual(byteLine.wikiLinks.map(\.target), ["Note"])
        XCTAssertEqual(byteLine.markdownLinks.map(\.shownText), ["words"])
        XCTAssertEqual(byteLine.markdownLinks.map(\.address), ["notes/milk"])
        XCTAssertEqual(byteLine.scheduleDates, [date(2017, 1, 10)])
    }

    func testChineseJapaneseAndKoreanLines() {
        let chinese = ExternalFormatReader.read("* 买菜 #zz", in: .project).lines[0]
        let japanese = ExternalFormatReader.read("* 牛乳を買う #zz", in: .project).lines[0]
        let korean = ExternalFormatReader.read("* 우유 사기 #zz", in: .project).lines[0]
        for line in [chinese, japanese, korean] {
            XCTAssertEqual(line.kind, .openTask)
            XCTAssertTrue(line.countsAsOpen)
            XCTAssertEqual(line.tags.map(\.name), ["zz"])
        }
    }

    func testCarriageReturnBlankLineEndsChildren() {
        let note = ExternalFormatReader.read("* One\r\n\t- child\r\n\r\n\t* Two\r\n", in: .project)
        XCTAssertEqual(note.lines.count, 4)
        XCTAssertEqual(note.lines[0].kind, .openTask)
        XCTAssertEqual(note.lines[0].childIndexes, [1])
        XCTAssertEqual(note.lines[1].kind, .bullet)
        XCTAssertEqual(note.lines[1].indentTabs, 1)
        XCTAssertEqual(note.lines[2].kind, .empty)
        XCTAssertEqual(note.lines[3].kind, .openTask)
        XCTAssertEqual(note.lines[3].indentTabs, 1)
        XCTAssertFalse(note.lines[0].childIndexes.contains(3))
        let pair = ExternalFormatReader.read("* One\r\n\r\n* Two\r\n", in: .project)
        XCTAssertEqual(pair.lines.map(\.kind), [.openTask, .empty, .openTask])
    }

    /// One unmeasured read, then the fastest of three measured reads at each size.
    private func growthTimes(
        _ smaller: String,
        _ larger: String,
        check: (ExternalNoteReading) -> Void
    ) -> (TimeInterval, TimeInterval) {
        _ = ExternalFormatReader.read(larger, in: .project)
        return (fastestRead(smaller, check: check), fastestRead(larger, check: check))
    }

    private func fastestRead(_ text: String, check: (ExternalNoteReading) -> Void) -> TimeInterval {
        var best = TimeInterval.greatestFiniteMagnitude
        for _ in 0..<3 {
            let started = Date()
            let note = ExternalFormatReader.read(text, in: .project)
            let elapsed = Date().timeIntervalSince(started)
            check(note)
            if elapsed < best {
                best = elapsed
            }
        }
        return best
    }

    func testMovedAwayTaskInAPastDayIsUnlisted() {
        let pastDay = date(2017, 1, 16)
        let line = ExternalFormatReader.read(
            "* [>] c87 zzrea move away >2017-01-17",
            in: .day(pastDay)
        ).lines[0]
        XCTAssertEqual(line.kind, .scheduledTask)
        XCTAssertFalse(line.countsAsOpen)
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 17)])
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .day(pastDay)), .unlisted)
        let futureMove = ExternalFormatReader.read("* [>] Later >2031-03-03", in: .day(pastDay)).lines[0]
        XCTAssertEqual(futureMove.kind, .scheduledTask)
        XCTAssertEqual(
            ExternalFormatReader.placement(of: futureMove, on: sessionDay, in: .day(pastDay)),
            .unlisted
        )
        let project = ExternalFormatReader.read("* [>] Pay the fake water bill >2031-03-03", in: .project).lines[0]
        XCTAssertEqual(project.kind, .scheduledTask)
        XCTAssertEqual(project.scheduleDates, [date(2031, 3, 3)])
        XCTAssertEqual(ExternalFormatReader.placement(of: project, on: sessionDay, in: .project), .unlisted)
        let futureListed = ExternalFormatReader.viewListing(of: project, on: sessionDay, in: .project)
        XCTAssertEqual(futureListed.calendar, .unlisted)
        XCTAssertEqual(futureListed.notes, .unlisted)
    }

    func testTwoScheduleDatesAddNoReferenceDays() {
        let line = ExternalFormatReader.read(
            "* c122 zzrea two dates >2017-01-24 >2031-03-05",
            in: .project
        ).lines[0]
        XCTAssertEqual(line.scheduleDates, [date(2017, 1, 24), date(2031, 3, 5)])
        XCTAssertTrue(line.referencedDays.isEmpty)
        XCTAssertEqual(ExternalFormatReader.placement(of: line, on: sessionDay, in: .project), .unlisted)
    }

    func testScheduleByCopyRewritesALeadingLink() {
        let origin = ExternalNoteContext.day(date(2017, 1, 9))
        let target = date(2017, 1, 10)
        let wiki = ExternalFormatReader.bringForward(
            line: "* [[Project]] call",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            wiki,
            .edited(
                sourceLine: "* [>] [[Project]] call >2017-01-10",
                addedLine: "* [[Project]] call <2017-01-09"
            )
        )
        let spec = ExternalFormatReader.bringForward(
            line: "* [Spec](notes/spec) review",
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(
            spec,
            .edited(
                sourceLine: "* [>] [Spec](notes/spec) review >2017-01-10",
                addedLine: "* [Spec](notes/spec) review <2017-01-09"
            )
        )
    }

    func testUnsettledBringForwardPaths() {
        let origin = ExternalNoteContext.day(date(2017, 1, 9))
        let target = date(2017, 1, 10)
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* One\n* Two", in: origin, to: target, mode: .scheduleByCopy),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* Call >today", in: origin, to: target, mode: .scheduleByCopy),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "- Top bullet", in: origin, to: target, mode: .scheduleByCopy),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(
                line: "* c104 14:00 zzrea timed",
                in: origin,
                to: target,
                mode: .scheduleByCopy
            ),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "## Focus", in: .project, to: target, mode: .scheduleByCopy),
            .unsettled
        )
        let fenced = ExternalFormatReader.bringForward(
            lines: ["```", "* Fenced task", "```"],
            in: origin,
            to: target,
            mode: .scheduleByCopy
        )
        XCTAssertEqual(fenced, [.unsettled, .unsettled, .unsettled])
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* Fake synced ^zz1abc", in: origin, to: target, mode: .scheduleByLink),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(
                line: "* Mail the parcel @done(2017-01-09)",
                in: origin,
                to: target,
                mode: .scheduleByLink
            ),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "- Top bullet", in: origin, to: target, mode: .scheduleByLink),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "+ Checklist item", in: origin, to: target, mode: .scheduleByLink),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* Task <2017-01-08", in: origin, to: target, mode: .scheduleByLink),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* Call >today", in: origin, to: target, mode: .scheduleByLink),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* [x] Done task", in: origin, to: target, mode: .scheduleByLink),
            .skipped
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "* [-] Cancelled task", in: origin, to: target, mode: .scheduleByLink),
            .skipped
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(
                line: "* [>] Already moved >2017-01-12",
                in: origin,
                to: target,
                mode: .scheduleByLink
            ),
            .skipped
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "- Top bullet", in: origin, to: target, mode: .cutAndPaste),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "## Focus", in: origin, to: target, mode: .cutAndPaste),
            .unsettled
        )
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: "+ Checklist item", in: origin, to: target, mode: .cutAndPaste),
            .unsettled
        )
        let done = "* [x] Done task"
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: done, in: origin, to: target, mode: .cutAndPaste),
            .edited(sourceLine: nil, addedLine: done)
        )
        let cancelled = "* [-] Cancelled task"
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: cancelled, in: origin, to: target, mode: .cutAndPaste),
            .edited(sourceLine: nil, addedLine: cancelled)
        )
        let scheduled = "* [>] Already moved >2017-01-12"
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: scheduled, in: origin, to: target, mode: .cutAndPaste),
            .edited(sourceLine: nil, addedLine: scheduled)
        )
        let stamped = "* Mail the parcel @done(2017-01-09)"
        XCTAssertEqual(
            ExternalFormatReader.bringForward(line: stamped, in: origin, to: target, mode: .cutAndPaste),
            .edited(sourceLine: nil, addedLine: stamped)
        )
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

    private func loadFixture(_ number: Int) throws -> FixtureCase {
        let root = try fixtureRootOrSkip()
        let url = root.appendingPathComponent("cases/\(number).json")
        let fixture = try JSONDecoder().decode(FixtureCase.self, from: Data(contentsOf: url))
        XCTAssertEqual(fixture.number, number)
        XCTAssertEqual(fixture.label, "Seen")
        return fixture
    }

    private func loadCase(_ number: Int) throws -> (FixtureCase, ExternalNoteReading) {
        let fixture = try loadFixture(number)
        guard let context = ExternalFormatReader.noteContext(labeled: fixtureContext(fixture.context)) else {
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

/// Diagnostic only. Prints the slice time beside the process footprint and the
/// memory still available to it. Nothing here is asserted.
private func printMemory(_ label: String, seconds: TimeInterval) {
    #if canImport(Darwin)
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)
    let result = withUnsafeMutablePointer(to: &info) {
        $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
            task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
        }
    }
    let footprint = result == KERN_SUCCESS ? info.phys_footprint : 0
    let available = os_proc_available_memory()
    print("reader-memory \(label) \(seconds) footprint=\(footprint) available=\(available)")
    #else
    print("reader-memory \(label) \(seconds) footprint=unavailable available=unavailable")
    #endif
    fflush(stdout)
}

private enum LoadError: Error {
    case missingRoot
    case context
}

private func fixtureRootOrSkip() throws -> URL {
    do {
        return try fixturesRoot()
    } catch {
        // The simulator cannot see the checkout. Linux and Mac package tests can.
        #if os(iOS)
        throw XCTSkip("The checkout fixtures are not visible from the simulator.")
        #else
        XCTFail("fixtures/external-format was not found from \(#filePath)")
        throw error
        #endif
    }
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

private func fixtureContext(_ label: String) -> String {
    let viewed = ", viewed on session day"
    if label.hasSuffix(viewed) {
        return String(label.dropLast(viewed.count))
    }
    return label
}

private struct FixedDayClock: ExternalDayClock {
    var today: ExternalDate
}

private func date(_ year: Int, _ month: Int, _ day: Int) -> ExternalDate {
    ExternalDate(year: year, month: month, day: day)
}

private func dayAfter(_ day: ExternalDate) -> ExternalDate {
    var length = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][day.month - 1]
    let leap = day.month == 2 && (day.year % 400 == 0 || (day.year % 100 != 0 && day.year % 4 == 0))
    if leap { length = 29 }
    if day.day < length {
        return ExternalDate(year: day.year, month: day.month, day: day.day + 1)
    }
    if day.month < 12 {
        return ExternalDate(year: day.year, month: day.month + 1, day: 1)
    }
    return ExternalDate(year: day.year + 1, month: 1, day: 1)
}

private func isoDay(_ day: ExternalDate) -> String {
    String(format: "%04d-%02d-%02d", day.year, day.month, day.day)
}
