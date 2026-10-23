@testable import AidanCore
import Foundation
import XCTest

final class BroughtForwardTests: XCTestCase {
    private let utc = TimeZone(secondsFromGMT: 0)!

    func testLookbackIsThirtyDaysInTheGivenTimeZone() throws {
        let loaded = try loadSamples()
        let result = BroughtForward.tasks(
            in: loaded.notes,
            on: utcDate(year: 2026, month: 10, day: 23, hour: 15, minute: 0),
            timeZone: utc,
            mode: .everyOpenTaskFromEarlierDays
        )
        XCTAssertEqual(result.today, CalendarDay(year: 2026, month: 10, day: 23))
        let keys = Set(broughtRows(result).map(\.key))
        XCTAssertTrue(keys.contains("Sweep the far bench"))
        XCTAssertFalse(keys.contains("Too old by a day"))
        XCTAssertFalse(keys.contains("Rebuild the shelf"))
        XCTAssertFalse(keys.contains("Throw three bowls"))
        let sweep = try row("Sweep the far bench", in: result)
        XCTAssertEqual(sweep.year, 2026)
        XCTAssertEqual(sweep.month, 9)
        XCTAssertEqual(sweep.day, 23)
        let gap = calendarGap(
            from: CalendarDay(year: 2026, month: 9, day: 23),
            to: result.today,
            timeZone: utc
        )
        XCTAssertEqual(gap, BroughtForward.lookbackDays)
        XCTAssertEqual(sweep.count, gap)

        let shifted = BroughtForward.tasks(
            in: loaded.notes,
            on: utcDate(year: 2026, month: 10, day: 22, hour: 12, minute: 0),
            timeZone: utc,
            mode: .everyOpenTaskFromEarlierDays
        )
        XCTAssertEqual(shifted.today, CalendarDay(year: 2026, month: 10, day: 22))
        let shiftedKeys = Set(broughtRows(shifted).map(\.key))
        XCTAssertTrue(shiftedKeys.contains("Too old by a day"))
        XCTAssertFalse(shiftedKeys.contains("Carry the glaze"))
        XCTAssertFalse(shiftedKeys.contains("Stack bowls"))
    }

    func testDayBoundaryUsesThePassedInTimeZone() {
        let zone = TimeZone(secondsFromGMT: -6 * 3600)!
        let instant = utcDate(year: 2026, month: 10, day: 23, hour: 5, minute: 30)
        let notes = [
            ReadNote(path: "Calendar/20260921.md", text: "* [ ] Thirty one days out\n", plainMarkers: .asteriskIsOpenTask),
            ReadNote(path: "Calendar/20260922.md", text: "* [ ] Exactly thirty\n", plainMarkers: .asteriskIsOpenTask),
            ReadNote(path: "Calendar/20261021.md", text: "* [ ] From the twenty first\n", plainMarkers: .asteriskIsOpenTask),
            ReadNote(path: "Calendar/20261022.md", text: "* [ ] From the twenty second\n", plainMarkers: .asteriskIsOpenTask),
        ]
        let behind = BroughtForward.tasks(in: notes, on: instant, timeZone: zone, mode: .everyOpenTaskFromEarlierDays)
        XCTAssertEqual(behind.today, CalendarDay(year: 2026, month: 10, day: 22))
        XCTAssertEqual(broughtRows(behind).map(\.key), ["From the twenty first", "Exactly thirty"])

        let universal = BroughtForward.tasks(in: notes, on: instant, timeZone: utc, mode: .everyOpenTaskFromEarlierDays)
        XCTAssertEqual(universal.today, CalendarDay(year: 2026, month: 10, day: 23))
        XCTAssertEqual(
            broughtRows(universal).map(\.key),
            ["From the twenty second", "From the twenty first"]
        )
        XCTAssertFalse(broughtRows(universal).map(\.key).contains("Exactly thirty"))
    }

    func testDoneAndCancelledTasksAreSkipped() throws {
        let loaded = try loadSamples()
        let openSand = try loaded.notes.line("Calendar/20261018.md", "* [ ] Sand the board")
        let doneSand = try loaded.notes.line("Notes/Workshop.md", "* [x] Sand the board")
        XCTAssertEqual(openSand.task?.state, .open)
        XCTAssertEqual(doneSand.task?.state, .done)
        XCTAssertEqual(TaskText.key(for: openSand), TaskText.key(for: doneSand))

        let openDrop = try loaded.notes.line("Calendar/20261017.md", "* [ ] Drop the whole order")
        let cancelledDrop = try loaded.notes.line("Notes/Workshop.md", "* [-] Drop the whole order")
        XCTAssertEqual(cancelledDrop.task?.state, .cancelled)
        XCTAssertEqual(TaskText.key(for: openDrop), TaskText.key(for: cancelledDrop))
        XCTAssertEqual(try loaded.notes.line("Calendar/20261016.md", "* [-] Skip the fair").task?.state, .cancelled)

        for mode in [BroughtForwardMode.everyOpenTaskFromEarlierDays, .onlyTasksMovedForward] {
            let keys = Set(broughtRows(list(loaded.notes, mode)).map(\.key))
            XCTAssertFalse(keys.contains("Sand the board"), "\(mode)")
            XCTAssertFalse(keys.contains("Drop the whole order"), "\(mode)")
            XCTAssertFalse(keys.contains("Skip the fair"), "\(mode)")
        }
    }

    func testTasksScheduledAfterTodayAreSkipped() throws {
        let loaded = try loadSamples()
        let later = try loaded.notes.line("Calendar/20261019.md", "* [ ] Call the supplier >2026-11-02")
        XCTAssertEqual(later.task?.state, .open)
        XCTAssertEqual(later.dates.first?.kind, .day(CalendarDay(year: 2026, month: 11, day: 2)))
        let kept = try loaded.notes.line("Calendar/20261019.md", "* [ ] Sharpen the tool")
        XCTAssertEqual(kept.task?.state, .open)
        XCTAssertTrue(kept.dates.isEmpty)

        let result = list(loaded.notes, .everyOpenTaskFromEarlierDays)
        let keys = broughtRows(result).map(\.key)
        XCTAssertFalse(keys.contains("Call the supplier"))
        XCTAssertTrue(keys.contains("Sharpen the tool"))
        XCTAssertTrue(keys.contains("Stack bowls"))
        XCTAssertTrue(keys.contains("Carry the glaze"))
        XCTAssertEqual(try row("Carry the glaze", in: result).count, 1)
    }

    func testBroughtForwardKeepsAStableReferenceAndDoesNotRewrite() throws {
        let loaded = try loadSamples()
        let snapshot = loaded.notes
        let result = list(loaded.notes, .everyOpenTaskFromEarlierDays)
        XCTAssertEqual(loaded.notes, snapshot)
        XCTAssertFalse(result.groups.isEmpty)
        for group in result.groups {
            for task in group.tasks {
                let note = try XCTUnwrap(loaded.notes.first { $0.path == task.source.path })
                XCTAssertTrue(task.source.matches(note: note))
                XCTAssertEqual(task.line.text, task.source.text)
                XCTAssertEqual(note.lines[task.source.lineNumber - 1].text, task.source.text)
                XCTAssertEqual(task.sourceDay, group.sourceDay)
            }
        }
        for task in result.projectTasksDueToday {
            let note = try XCTUnwrap(loaded.notes.first { $0.path == task.source.path })
            XCTAssertTrue(task.source.matches(note: note))
            XCTAssertEqual(task.line.text, task.source.text)
        }
        let bowls = try result.task(key: "Stack bowls")
        XCTAssertEqual(bowls.source.text, "* [ ] Stack bowls  >2026-10-01")
        XCTAssertEqual(bowls.source.path, "Calendar/20261022.md")
    }

    func testMoveCountIsDaysSincePlusEarlierMovedMarks() throws {
        let loaded = try loadSamples()
        let result = list(loaded.notes, .everyOpenTaskFromEarlierDays)
        let oil = try result.task(key: "Oil the hinge")
        XCTAssertEqual(oil.source.path, "Calendar/20261020.md")
        XCTAssertEqual(oil.source.text, "* [ ] Oil the hinge <2026-10-15")
        let marks = loaded.notes.flatMap(\.lines).filter { line in
            line.task?.state == .scheduled && TaskText.key(for: line) == "Oil the hinge"
        }
        XCTAssertEqual(marks.count, 2)
        let days = calendarGap(from: oil.sourceDay, to: result.today, timeZone: utc)
        XCTAssertEqual(days, 3)
        XCTAssertEqual(oil.moveCount, days + marks.count)

        let clay = try result.task(key: "Carry clay")
        let clayMarks = loaded.notes.flatMap(\.lines).filter { line in
            line.task?.state == .scheduled && TaskText.key(for: line) == "Carry clay"
        }
        XCTAssertEqual(clayMarks.count, 1)
        XCTAssertEqual(clayMarks[0].text, "* [>] Carry clay >2026-10-21")
        XCTAssertEqual(
            try XCTUnwrap(loaded.notes.first { $0.path == "Calendar/20260801.md" }).pathKind.day,
            CalendarDay(year: 2026, month: 8, day: 1)
        )
        let clayDays = calendarGap(from: clay.sourceDay, to: result.today, timeZone: utc)
        XCTAssertEqual(clayDays, 2)
        XCTAssertEqual(clay.moveCount, clayDays + 1)

        let waiting = try result.task(key: "Sharpen the tool")
        XCTAssertEqual(waiting.moveCount, calendarGap(from: waiting.sourceDay, to: result.today, timeZone: utc))
    }

    func testSameTaskTextShowsOnceFromTheNewestDay() throws {
        let loaded = try loadSamples()
        let result = list(loaded.notes, .everyOpenTaskFromEarlierDays)
        let labels = result.groups.flatMap(\.tasks).filter { TaskText.key(for: $0.line) == "Label jars" }
        XCTAssertEqual(labels.count, 1)
        XCTAssertEqual(labels[0].source.path, "Calendar/20261021.md")
        XCTAssertEqual(labels[0].sourceDay, CalendarDay(year: 2026, month: 10, day: 21))
        XCTAssertNotEqual(labels[0].source.path, "Calendar/20261012.md")
        XCTAssertNotEqual(labels[0].source.path, "Calendar/20261014.md")
        let copies = loaded.notes.filter { note in
            note.lines.contains { TaskText.key(for: $0) == "Label jars" && $0.task?.state == .open }
        }
        XCTAssertEqual(copies.map(\.path).sorted(), [
            "Calendar/20261012.md",
            "Calendar/20261014.md",
            "Calendar/20261021.md",
        ])
    }

    func testAutomaticModeAndMovedMode() throws {
        let loaded = try loadSamples()
        let automatic = list(loaded.notes, .everyOpenTaskFromEarlierDays)
        let moved = list(loaded.notes, .onlyTasksMovedForward)
        XCTAssertEqual(broughtRows(automatic), [
            BroughtRow(year: 2026, month: 10, day: 22, key: "Carry the glaze", count: 1, path: "Calendar/20261022.md"),
            BroughtRow(year: 2026, month: 10, day: 22, key: "Stack bowls", count: 1, path: "Calendar/20261022.md"),
            BroughtRow(year: 2026, month: 10, day: 21, key: "Label jars", count: 2, path: "Calendar/20261021.md"),
            BroughtRow(year: 2026, month: 10, day: 21, key: "Carry clay", count: 3, path: "Calendar/20261021.md"),
            BroughtRow(year: 2026, month: 10, day: 20, key: "Oil the hinge", count: 5, path: "Calendar/20261020.md"),
            BroughtRow(year: 2026, month: 10, day: 19, key: "Sharpen the tool", count: 4, path: "Calendar/20261019.md"),
            BroughtRow(year: 2026, month: 9, day: 23, key: "Sweep the far bench", count: 30, path: "Calendar/20260923.md"),
        ])
        XCTAssertEqual(broughtRows(moved), [
            BroughtRow(year: 2026, month: 10, day: 21, key: "Carry clay", count: 3, path: "Calendar/20261021.md"),
            BroughtRow(year: 2026, month: 10, day: 20, key: "Oil the hinge", count: 5, path: "Calendar/20261020.md"),
        ])
        XCTAssertEqual(projectRows(automatic), projectRows(moved))
        XCTAssertEqual(projectRows(automatic), [
            "Calendar/2026-W43.md Bisque day",
            "Notes/Glass-jars.md Order lids",
            "Notes/Glass-jars.md Check seals",
            "Notes/Plan.md Photograph the shelf",
        ])
        XCTAssertFalse(projectRows(automatic).contains { $0.contains("Buy labels") })
        XCTAssertFalse(projectRows(automatic).contains { $0.contains("Sketch a lid") })
        XCTAssertFalse(projectRows(automatic).contains { $0.contains("Move the order") })
        XCTAssertFalse(projectRows(automatic).contains { $0.contains("Open the stall") })
        XCTAssertFalse(projectRows(automatic).contains { $0.contains("Order boxes") })
        XCTAssertFalse(projectRows(automatic).joined(separator: "\n").contains("It is an ordinary note"))
    }

    func testTasksOlderThanAYearStayInTheSampleAndOutOfTheList() throws {
        let loaded = try loadSamples()
        let shelf = try loaded.notes.line("Calendar/20231020.md", "* [ ] Rebuild the shelf")
        XCTAssertEqual(shelf.task?.state, .open)
        let day = try XCTUnwrap(loaded.notes.first { $0.path == "Calendar/20231020.md" }?.pathKind.day)
        let today = CalendarDay(year: 2026, month: 10, day: 23)
        XCTAssertGreaterThan(calendarGap(from: day, to: today, timeZone: utc), 365)
        for mode in [BroughtForwardMode.everyOpenTaskFromEarlierDays, .onlyTasksMovedForward] {
            XCTAssertFalse(broughtRows(list(loaded.notes, mode)).map(\.key).contains("Rebuild the shelf"))
        }
    }

    func testProjectTaskDueTodayFollowsThePassedInDay() throws {
        let loaded = try loadSamples()
        let onTheTwentyThird = list(loaded.notes, .onlyTasksMovedForward)
        XCTAssertTrue(projectRows(onTheTwentyThird).contains("Notes/Glass-jars.md Order lids"))
        XCTAssertTrue(projectRows(onTheTwentyThird).contains("Notes/Glass-jars.md Check seals"))

        let onTheTwentySecond = BroughtForward.tasks(
            in: loaded.notes,
            on: utcDate(year: 2026, month: 10, day: 22, hour: 12, minute: 0),
            timeZone: utc,
            mode: .onlyTasksMovedForward
        )
        XCTAssertEqual(projectRows(onTheTwentySecond), ["Notes/Glass-jars.md Check seals"])
    }

    private func list(_ notes: [ReadNote], _ mode: BroughtForwardMode) -> BroughtForwardResult {
        BroughtForward.tasks(
            in: notes,
            on: utcDate(year: 2026, month: 10, day: 23, hour: 15, minute: 0),
            timeZone: utc,
            mode: mode
        )
    }

    private func row(_ key: String, in result: BroughtForwardResult) throws -> BroughtRow {
        try XCTUnwrap(broughtRows(result).first { $0.key == key })
    }
}

private extension Array where Element == ReadNote {
    func line(_ path: String, _ text: String) throws -> ParsedLine {
        let note = try XCTUnwrap(first { $0.path == path })
        return try XCTUnwrap(note.lines.first { $0.text == text })
    }
}

private extension BroughtForwardResult {
    func task(key: String) throws -> BroughtForwardTask {
        try XCTUnwrap(groups.flatMap(\.tasks).first { TaskText.key(for: $0.line) == key })
    }
}
