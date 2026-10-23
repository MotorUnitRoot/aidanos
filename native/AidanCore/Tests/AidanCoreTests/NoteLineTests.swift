@testable import AidanCore
import Foundation
import XCTest

final class NoteLineTests: XCTestCase {
    private let marks = PlainMarkerReading.asteriskIsOpenTask

    private func parsed(_ text: String, _ reading: PlainMarkerReading? = nil) -> ParsedLine {
        NoteLines.parse(line: text, plainMarkers: reading ?? marks)
    }

    func testCheckboxStatesAndPlainMarkers() {
        XCTAssertEqual(parsed("* [ ] Open").task, TaskRead(state: .open, plain: false))
        XCTAssertEqual(parsed("- [ ] Open").task, TaskRead(state: .open, plain: false))
        XCTAssertEqual(parsed("+ [ ] Open").task, TaskRead(state: .open, plain: false))
        XCTAssertEqual(parsed("1. [ ] Open").task, TaskRead(state: .open, plain: false))
        XCTAssertEqual(parsed("2) [ ] Open").task, TaskRead(state: .open, plain: false))
        XCTAssertEqual(parsed("* [x] Done").task?.state, .done)
        XCTAssertEqual(parsed("* [X] Done").task?.state, .done)
        XCTAssertEqual(parsed("- [x] Done").task?.state, .done)
        XCTAssertEqual(parsed("+ [x] Done").task?.state, .done)
        XCTAssertEqual(parsed("* [-] Skip").task?.state, .cancelled)
        XCTAssertEqual(parsed("- [-] Skip").task?.state, .cancelled)
        XCTAssertEqual(parsed("* [>] Later").task?.state, .scheduled)
        XCTAssertEqual(parsed("- [>] Later").task?.state, .scheduled)
        XCTAssertEqual(parsed("3) [>] Later").task?.state, .scheduled)

        let star = parsed("* Buy milk")
        XCTAssertEqual(star.task, TaskRead(state: .open, plain: true))
        XCTAssertTrue(star.isListItem)
        XCTAssertEqual(star.listMarker, "*")
        XCTAssertNil(star.headingLevel)

        let dash = parsed("- Buy milk")
        XCTAssertNil(dash.task)
        XCTAssertTrue(dash.isListItem)
        XCTAssertEqual(dash.listMarker, "-")

        let numbered = parsed("1. Buy milk")
        XCTAssertNil(numbered.task)
        XCTAssertTrue(numbered.isListItem)

        let plus = parsed("+ Buy milk")
        XCTAssertNil(plus.task)
        XCTAssertTrue(plus.isListItem)

        let configured = PlainMarkerReading.plainMarkersAreOpenTasks
        XCTAssertEqual(parsed("- Buy milk", configured).task, TaskRead(state: .open, plain: true))
        XCTAssertEqual(parsed("* Buy milk", configured).task, TaskRead(state: .open, plain: true))
        XCTAssertEqual(parsed("1. Buy milk", configured).task, TaskRead(state: .open, plain: true))
        XCTAssertEqual(parsed("1) Buy milk", configured).task, TaskRead(state: .open, plain: true))
        XCTAssertNil(parsed("+ Buy milk", configured).task)
    }

    func testUnknownMarksAreLeftAlone() {
        for sample in ["* [?] Look", "* [/] Look", "* [!] Look", "+ [?] Look", "- [~] Look"] {
            let line = parsed(sample)
            XCTAssertEqual(line.text, sample)
            XCTAssertNil(line.task)
            XCTAssertTrue(line.isListItem)
            XCTAssertNotNil(line.unknownMark)
            XCTAssertTrue(sample.contains(line.unknownMark ?? ""))
        }
        XCTAssertEqual(parsed("* [?] Look").unknownMark, "[?]")
        XCTAssertNil(parsed("*[ ] stuck").task)
        XCTAssertFalse(parsed("*[ ] stuck").isListItem)
        XCTAssertNil(parsed("[ ] No bullet").task)
        XCTAssertNil(parsed("***").task)
        XCTAssertFalse(parsed("---").isListItem)
        XCTAssertNil(parsed("**bold**").task)
    }

    func testHeadingsAndIndent() {
        XCTAssertEqual(parsed("# Title").headingLevel, 1)
        XCTAssertEqual(parsed("## Title").headingLevel, 2)
        XCTAssertEqual(parsed("###### Title").headingLevel, 6)
        XCTAssertNil(parsed("####### Title").headingLevel)
        XCTAssertNil(parsed("#tag").headingLevel)
        XCTAssertEqual(parsed("#tag").tags.map(\.name), ["tag"])
        let indented = parsed("\t* [x] Done")
        XCTAssertEqual(indented.task?.state, .done)
        XCTAssertEqual(indented.text, "\t* [x] Done")
    }

    func testDatesMentionsTagsAndLinks() {
        let line = parsed("* [ ] Mail @quinn and @team/quinn #kiln #books/business [[Firing log]] >2026-10-23 >today >2026-W10 >Friday >nextweek <2026-10-01 @done(2026-01-02 15:30)")
        XCTAssertEqual(line.dates.map(\.kind), [
            .day(CalendarDay(year: 2026, month: 10, day: 23)),
            .today,
            .week(year: 2026, week: 10),
            .weekday("friday"),
            .nextWeek,
            .sourceDay(CalendarDay(year: 2026, month: 10, day: 1)),
        ])
        XCTAssertEqual(line.mentions.map(\.name), ["quinn", "team/quinn", "done"])
        XCTAssertEqual(line.mentions.last?.detail, "2026-01-02 15:30")
        XCTAssertEqual(line.tags.map(\.name), ["kiln", "books/business"])
        XCTAssertEqual(line.wikiLinks.map(\.target), ["Firing log"])
        XCTAssertTrue(line.times.isEmpty, "a time inside @done(...) is a stamp, not a time block")
        XCTAssertNil(parsed("* [ ] See >2026-02-31 tomorrow").dates.first)
        XCTAssertTrue(parsed("* [ ] See >tomorrow").dates.isEmpty)
        XCTAssertTrue(parsed("Write kiln@workshop.example later").mentions.isEmpty)
        XCTAssertEqual(TaskText.key(for: line), "Mail @quinn and @team/quinn #kiln #books/business [[Firing log]]")
    }

    func testWhichLinesCarryATime() {
        XCTAssertEqual(parsed("* [ ] Call at 9:30").times, [mark("9:30", 9, 30)])
        XCTAssertEqual(parsed("* [ ] Call at 9:30am").times, [mark("9:30am", 9, 30)])
        XCTAssertEqual(parsed("* [ ] Call at 9:30 am").times, [mark("9:30 am", 9, 30)])
        XCTAssertEqual(parsed("- 2-3pm Pack").times, [mark("2-3pm", 14, 0, 15, 0)])
        XCTAssertEqual(parsed("* [ ] Block 14:00-15:30").times, [mark("14:00-15:30", 14, 0, 15, 30)])
        XCTAssertEqual(parsed("## 09:00 - 11:00 Studio").times, [mark("09:00 - 11:00", 9, 0, 11, 0)])
        XCTAssertEqual(parsed("* [ ] Reply at 5:00pm").times.first?.start, ClockTime(hour: 17, minute: 0))
        XCTAssertEqual(parsed("* [ ] Meet at 3 pm").times.first?.start, ClockTime(hour: 15, minute: 0))
        XCTAssertEqual(parsed("* 9-11 am Focus").times, [mark("9-11 am", 9, 0, 11, 0)])
        XCTAssertEqual(parsed("* [ ] Lunch 15:00-16:00").times, [mark("15:00-16:00", 15, 0, 16, 0)])
        XCTAssertEqual(parsed("* [ ] Midnight 12:00am").times.first?.start, ClockTime(hour: 0, minute: 0))
        XCTAssertEqual(parsed("* [ ] Noon 12pm").times.first?.start, ClockTime(hour: 12, minute: 0))
        XCTAssertTrue(parsed("* [ ] Room 15 is free").times.isEmpty)
        XCTAssertEqual(parsed("* [ ] Room 15:00 is free").times.first?.start, ClockTime(hour: 15, minute: 0))
        XCTAssertTrue(parsed("* [ ] Read pages 2-3").times.isEmpty)
        XCTAssertTrue(parsed("Meet at 9:30 if you can.").times.isEmpty)
        XCTAssertTrue(parsed("#kiln at 9:30").times.isEmpty)
        let both = parsed("* [ ] Standup 9:30 then lunch 12:00-13:00")
        XCTAssertEqual(both.times.count, 2)
        XCTAssertEqual(both.times[0].start, ClockTime(hour: 9, minute: 30))
        XCTAssertEqual(both.times[1].start, ClockTime(hour: 12, minute: 0))
        XCTAssertEqual(both.times[1].end, ClockTime(hour: 13, minute: 0))
    }

    func testAppendedTimeReadsBackFromTheEnd() {
        let time = ClockTime(hour: 9, minute: 30)!
        let original = "* [ ] Call the kiln"
        let written = NoteLines.appendingTime(time, to: original)
        XCTAssertEqual(original, "* [ ] Call the kiln")
        XCTAssertEqual(written, "* [ ] Call the kiln 09:30")
        XCTAssertEqual(NoteLines.canonicalTime(time), "09:30")
        let line = parsed(written)
        XCTAssertEqual(line.text, written)
        XCTAssertEqual(line.task?.state, .open)
        XCTAssertEqual(line.times, [mark("09:30", 9, 30)])

        let afternoon = ClockTime(hour: 14, minute: 0)!
        XCTAssertEqual(NoteLines.appendingTime(afternoon, to: "- Pack"), "- Pack 14:00")
        XCTAssertEqual(parsed("- Pack 14:00").times, [mark("14:00", 14, 0)])
        XCTAssertEqual(parsed(NoteLines.appendingTime(time, to: "## Studio")).times, [mark("09:30", 9, 30)])
        XCTAssertEqual(NoteLines.appendingTime(afternoon, to: "* [ ] Call "), "* [ ] Call 14:00")

        let middle = "* [ ] 9:30 Call"
        let extended = NoteLines.appendingTime(afternoon, to: middle)
        XCTAssertEqual(extended, "* [ ] 9:30 Call 14:00")
        XCTAssertTrue(extended.hasPrefix(middle))
        XCTAssertEqual(parsed(extended).times.map(\.start), [ClockTime(hour: 9, minute: 30)!, afternoon])

        XCTAssertTrue(parsed(NoteLines.appendingTime(time, to: "Meet")).times.isEmpty)
    }

    func testParsingDoesNotChangeTheLine() {
        let text = "* [ ]  Keep the spaces  \n- a bullet\n"
        let lines = NoteLines.parse(note: text, plainMarkers: marks)
        XCTAssertEqual(lines.map(\.text).joined(separator: "\n") + "\n", text)
        XCTAssertEqual(lines[0].text, "* [ ]  Keep the spaces  ")
        let crlf = "* [ ] A\r\n* [ ] B\r\n"
        let split = NoteLines.parse(note: crlf, plainMarkers: marks)
        XCTAssertEqual(split.map(\.text), ["* [ ] A", "* [ ] B"])
        XCTAssertTrue(NoteLines.parse(note: "", plainMarkers: marks).isEmpty)
        XCTAssertEqual(NoteLines.parse(note: "\n", plainMarkers: marks).map(\.text), [""])
    }

    private func mark(_ raw: String, _ hour: Int, _ minute: Int, _ endHour: Int? = nil, _ endMinute: Int? = nil) -> NoteTimeMark {
        let end: ClockTime?
        if let endHour, let endMinute {
            end = ClockTime(hour: endHour, minute: endMinute)
        } else {
            end = nil
        }
        return NoteTimeMark(raw: raw, start: ClockTime(hour: hour, minute: minute)!, end: end)
    }
}
