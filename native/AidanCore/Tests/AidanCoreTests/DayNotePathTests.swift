@testable import AidanCore
import Foundation
import XCTest

final class DayNotePathTests: XCTestCase {
    func testAppStillNamesTodayLogPlusTheDate() {
        let zone = TimeZone(secondsFromGMT: 0)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21))!
        XCTAssertEqual(AidanSession.todayPath(on: date, timeZone: zone), "log/2026-10-21.md")
        XCTAssertEqual(
            NotePaths.kind(ofRelativePath: "log/2026-10-21.md"),
            .aidanDay(CalendarDay(year: 2026, month: 10, day: 21))
        )
    }

    func testAidanPathIsOnlyTheTodayPath() {
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "log/other/2026-10-21.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "log/2026-10-21.txt"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "LOG/2026-10-21.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "notes/2026-10-21.md"), .ordinary)
    }

    func testNotePlanDailyWeeklyAndTheRest() {
        // Claimed, from NotePlan documentation. See docs/native/day-note-paths.md.
        XCTAssertEqual(
            NotePaths.kind(ofRelativePath: "Calendar/20231020.md"),
            .notePlanDay(CalendarDay(year: 2023, month: 10, day: 20))
        )
        XCTAssertEqual(
            NotePaths.kind(ofRelativePath: "Calendar/20231102.txt"),
            .notePlanDay(CalendarDay(year: 2023, month: 11, day: 2))
        )
        XCTAssertEqual(
            NotePaths.kind(ofRelativePath: "Calendar/2026-10-23.md"),
            .notePlanDay(CalendarDay(year: 2026, month: 10, day: 23))
        )
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2026-W43.md"), .notePlanWeek(year: 2026, week: 43))
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2023-W02.txt"), .notePlanWeek(year: 2023, week: 2))
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2026-10.md"), .notePlanMonth(year: 2026, month: 10))
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2023-Q1.md"), .notePlanQuarter(year: 2023, quarter: 1))
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2026.md"), .notePlanYear(2026))
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2026.txt"), .notePlanYear(2026))
    }

    func testUndatedAndImpossibleNamesAreOrdinaryNotes() {
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/loose-page.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/20240231.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/garbled.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Calendar/2024/20240115.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Notes/Plan.md"), .ordinary)
        XCTAssertEqual(NotePaths.kind(ofRelativePath: "Notes/Glass-jars.md"), .ordinary)
        XCTAssertNil(CalendarDay.valid(year: 2024, month: 2, day: 31))
    }
}
