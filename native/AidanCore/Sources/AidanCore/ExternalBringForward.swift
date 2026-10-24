/// How an unfinished task moves to another day, and what a new day receives.
///
/// `>today` follows the real current day from a clock. Tests can pass another clock.
/// Nothing here writes a file.
/// The three ways to move a task are one setting, and the caller passes it.
import Foundation
public enum ExternalBringForwardMode: Equatable, Sendable {
    /// The original line stays, marked scheduled, and an open copy is added on the target day.
    case scheduleByCopy
    /// The line stays where it is and gains a reference to the target day.
    case scheduleByLink
    /// The line leaves its note and is added on the target day unchanged.
    case cutAndPaste
}

public enum ExternalBringForwardResult: Equatable, Sendable {
    /// `sourceLine` is nil when the line leaves the source note.
    /// `addedLine` is nil when the target day gains no line.
    case edited(sourceLine: String?, addedLine: String?)
    /// A done, cancelled, or already scheduled task is left alone when lines are scheduled.
    case skipped
    /// The description does not settle this line.
    case unsettled
}

public struct ExternalDayText: Equatable, Sendable {
    public var day: ExternalDate
    public var text: String

    public init(day: ExternalDate, text: String) {
        self.day = day
        self.text = text
    }
}

public struct ExternalOpenedDay: Equatable, Sendable {
    public var text: String
    /// Tasks copied in from earlier days. Opening a day does not copy any.
    public var broughtLines: [String]

    public init(text: String, broughtLines: [String]) {
        self.text = text
        self.broughtLines = broughtLines
    }
}

public struct ExternalWeeklyReading: Equatable, Sendable {
    /// The days this weekly note covers, from the week-start setting.
    public var days: [ExternalDate]
    public var lines: [ExternalLine]

    public init(days: [ExternalDate], lines: [ExternalLine]) {
        self.days = days
        self.lines = lines
    }
}

/// The day `>today` follows. The product clock is the real current day.
public protocol ExternalDayClock: Sendable {
    var today: ExternalDate { get }
}

public struct ExternalSystemDayClock: ExternalDayClock {
    public init() {}

    public var today: ExternalDate {
        let parts = Calendar.current.dateComponents([.year, .month, .day], from: Date())
        return ExternalDate(year: parts.year ?? 1, month: parts.month ?? 1, day: parts.day ?? 1)
    }
}

/// Sunday is 0, through Saturday at 6.
public enum ExternalWeekday: Int, Equatable, Sendable {
    case sunday = 0
    case monday = 1
    case tuesday = 2
    case wednesday = 3
    case thursday = 4
    case friday = 5
    case saturday = 6
}

/// Which day begins a week. The default is Monday.
public struct ExternalWeekStart: Equatable, Sendable {
    public var firstDay: ExternalWeekday

    public init(firstDay: ExternalWeekday = .monday) {
        self.firstDay = firstDay
    }
}

extension ExternalFormatReader {
    public static func bringForward(
        line: String,
        in context: ExternalNoteContext,
        to target: ExternalDate,
        mode: ExternalBringForwardMode
    ) -> ExternalBringForwardResult {
        let parts = paragraphs(in: line)
        guard parts.count == 1 else { return .unsettled }
        let parsedNote = read(parts[0], in: context)
        guard parsedNote.lines.count == 1 else { return .unsettled }
        let parsed = parsedNote.lines[0]
        if parsed.indentTabs > 0 {
            if !parsed.kind.isTask {
                // AidanOS choice, pending case 112
                return .unsettled
            }
            // AidanOS choice, pending case 54
            return .unsettled
        }
        if case .day(let origin) = context, target <= origin {
            // AidanOS choice, pending section 7.4
            return .unsettled
        }
        switch mode {
        case .scheduleByCopy:
            return scheduleByCopy(parts[0], parsed: parsed, in: context, to: target)
        case .scheduleByLink:
            return scheduleByLink(parts[0], parsed: parsed, in: context, to: target)
        case .cutAndPaste:
            return cutAndPaste(parts[0], parsed: parsed)
        }
    }

    public static func bringForward(
        lines: [String],
        in context: ExternalNoteContext,
        to target: ExternalDate,
        mode: ExternalBringForwardMode
    ) -> [ExternalBringForwardResult] {
        lines.map { bringForward(line: $0, in: context, to: target, mode: mode) }
    }

    /// The first time a day note is created, the caller's template is the whole note.
    /// A note that already has text is left as it is. Earlier notes are not copied in.
    public static func openDay(
        existingText: String?,
        template: String?,
        earlierNotes _: [ExternalDayText],
        today _: ExternalDate
    ) -> ExternalOpenedDay {
        if let existingText {
            return ExternalOpenedDay(text: existingText, broughtLines: [])
        }
        return ExternalOpenedDay(text: template ?? "", broughtLines: [])
    }

    /// Every item in a weekly note is listed on each day of the week that contains `day`.
    /// The week's first day comes from `weekStart`, which defaults to Monday.
    public static func readWeekly(
        _ text: String,
        containing day: ExternalDate,
        weekStart: ExternalWeekStart = ExternalWeekStart()
    ) -> ExternalWeeklyReading {
        // AidanOS choice, pending section 4.4: a weekly note is read like a project note for clocks,
        // so a clock with no typed date does not become a time block.
        let note = read(text, in: .project)
        let covered = daysOfWeek(containing: day, starting: weekStart)
        var lines = note.lines
        for index in lines.indices {
            let kind = lines[index].kind
            guard kind != .empty, kind != .unsettled else { continue }
            // AidanOS choice, pending case 120: done tasks and bullets are shown too.
            for weekDay in covered where !lines[index].referencedDays.contains(weekDay) {
                lines[index].referencedDays.append(weekDay)
            }
        }
        return ExternalWeeklyReading(days: covered, lines: lines)
    }

    /// Seven days beginning on the setting's first day, containing `day`.
    public static func daysOfWeek(containing day: ExternalDate, starting start: ExternalWeekStart = ExternalWeekStart()) -> [ExternalDate] {
        let weekday = weekdayIndex(day)
        let first = start.firstDay.rawValue
        var back = weekday - first
        if back < 0 {
            back += 7
        }
        let startDay = day.adding(days: -back)
        return (0..<7).map { startDay.adding(days: $0) }
    }

    /// A fixed reference day, or the real current day when the line carries `>today` and is not done.
    public static func references(
        _ line: ExternalLine,
        on day: ExternalDate,
        clock: any ExternalDayClock = ExternalSystemDayClock()
    ) -> Bool {
        if line.referencedDays.contains(day) { return true }
        return line.carriesToday && day == clock.today
    }

    /// True when the day has a task that places as overdue. A checklist does not count.
    public static func dayCountsAsOverdue(_ note: ExternalNoteReading, on today: ExternalDate) -> Bool {
        note.lines.contains { placement(of: $0, on: today, in: note.context) == .overdue }
    }

    /// How many times the task was put off. Each `[>]` line in the chain counts once.
    /// `<` marks on one copy do not. Nil means the line is a task inside a code block.
    public static func moveCount(
        ofLineAt index: Int,
        on day: ExternalDate,
        in notes: [ExternalDayText]
    ) -> Int? {
        guard let note = notes.first(where: { $0.day == day }) else { return 0 }
        let lines = paragraphs(in: note.text)
        guard lines.indices.contains(index) else { return 0 }
        let reading = read(note.text, in: .day(day))
        guard lines.count == reading.lines.count else { return 0 }
        let alone = read(lines[index], in: .day(day))
        if reading.lines[index].kind == .unsettled, alone.lines.count == 1, alone.lines[0].kind.isTask {
            // AidanOS choice, pending case 93
            return nil
        }
        guard reading.lines[index].kind.isTask else { return 0 }
        // AidanOS choice, pending case 53: the same remaining text is treated as one task.
        let body = matchingBody(lines[index])
        guard !body.isEmpty else { return 0 }

        struct Link: Hashable {
            var from: ExternalDate
            var to: ExternalDate
        }
        var seen: Set<Link> = []
        var byDay: [ExternalDate: [Link]] = [:]
        for source in notes {
            let raw = paragraphs(in: source.text)
            let parsed = read(source.text, in: .day(source.day))
            guard raw.count == parsed.lines.count else { continue }
            for offset in parsed.lines.indices {
                let line = parsed.lines[offset]
                guard line.kind == .scheduledTask else { continue }
                // AidanOS choice, pending case 53: the same remaining text is treated as one task.
                guard matchingBody(raw[offset]) == body else { continue }
                if line.scheduleDates.count > 1 {
                    // AidanOS choice, pending case 122
                    return nil
                }
                guard let target = line.scheduleDates.first else { continue }
                let link = Link(from: source.day, to: target)
                guard seen.insert(link).inserted else { continue }
                byDay[source.day, default: []].append(link)
                if target != source.day {
                    byDay[target, default: []].append(link)
                }
            }
        }
        var queue: [ExternalDate] = [day]
        var visitedDays: Set<ExternalDate> = [day]
        var counted: Set<Link> = []
        var head = 0
        while head < queue.count {
            let current = queue[head]
            head += 1
            for link in byDay[current] ?? [] where counted.insert(link).inserted {
                let next = link.from == current ? link.to : link.from
                if visitedDays.insert(next).inserted {
                    queue.append(next)
                }
            }
        }
        return counted.count
    }
}

extension ExternalFormatReader {
    fileprivate static func scheduleByCopy(
        _ line: String,
        parsed: ExternalLine,
        in context: ExternalNoteContext,
        to target: ExternalDate
    ) -> ExternalBringForwardResult {
        if parsed.kind.isHeading {
            return .edited(sourceLine: line, addedLine: line)
        }
        if parsed.kind == .doneTask || parsed.kind == .cancelledTask || parsed.kind == .scheduledTask {
            return .skipped
        }
        guard parsed.kind == .openTask else { return .unsettled }
        // AidanOS choice, pending case 117: what a copy from a project note writes is not settled.
        guard case .day(let origin) = context else { return .unsettled }
        if !parsed.broughtFromDays.isEmpty {
            // AidanOS choice, pending case 53
            return .unsettled
        }
        if !parsed.scheduleDates.isEmpty || hasSyncId(line) {
            // AidanOS choice, pending case 75
            return .unsettled
        }
        // A today tag, an @remind, and an @done stamp on a copied line are not settled.
        // AidanOS choice, pending section 8A.2.
        if parsed.carriesToday || hasMention(parsed, named: "remind") || hasMention(parsed, named: "done") {
            return .unsettled
        }
        guard let rewritten = scheduledAndOpenCopy(line) else { return .unsettled }
        return .edited(
            sourceLine: appendMark(rewritten.scheduled, ">" + isoDay(target)),
            addedLine: appendMark(rewritten.copy, "<" + isoDay(origin))
        )
    }

    fileprivate static func scheduleByLink(
        _ line: String,
        parsed: ExternalLine,
        in context: ExternalNoteContext,
        to target: ExternalDate
    ) -> ExternalBringForwardResult {
        if parsed.kind.isHeading {
            // AidanOS choice, pending section 7.6: copying a heading is stated for schedule by copy.
            return .unsettled
        }
        if parsed.kind == .doneTask || parsed.kind == .cancelledTask || parsed.kind == .scheduledTask {
            return .skipped
        }
        guard parsed.kind == .openTask else { return .unsettled }
        if !parsed.broughtFromDays.isEmpty || parsed.carriesToday {
            return .unsettled
        }
        if parsed.scheduleDates.contains(where: { $0 != target }) {
            return .unsettled
        }
        if parsed.scheduleDates.contains(target) || parsed.wikiLinks.contains(where: { $0.day == target }) {
            return .edited(sourceLine: line, addedLine: nil)
        }
        // AidanOS choice, pending section 7.4: the written form of a drag is not given.
        // These are the marks that list the line on the target day from each kind of note.
        let mark: String
        switch context {
        case .project:
            mark = ">" + isoDay(target)
        case .day(_):
            mark = "[[" + isoDay(target) + "]]"
        }
        return .edited(sourceLine: appendMark(line, mark), addedLine: nil)
    }

    fileprivate static func hasMention(_ line: ExternalLine, named name: String) -> Bool {
        line.mentions.contains { $0.name == name }
    }

    /// A caret and a run of letters or digits at the end of the line.
    /// AidanOS choice, pending case 113: the run is not required to be six characters.
    fileprivate static func hasSyncId(_ line: String) -> Bool {
        let chars = Array(line)
        var end = chars.count
        while end > 0, chars[end - 1] == " " || chars[end - 1] == "\t" {
            end -= 1
        }
        var start = end
        while start > 0, isSyncChar(chars[start - 1]) {
            start -= 1
        }
        guard end > start, start > 0, chars[start - 1] == "^" else { return false }
        let caret = start - 1
        return caret == 0 || chars[caret - 1] == " " || chars[caret - 1] == "\t"
    }

    fileprivate static func isSyncChar(_ char: Character) -> Bool {
        if char.isLetter { return true }
        guard let ascii = char.asciiValue, let zero = Character("0").asciiValue, let nine = Character("9").asciiValue else {
            return false
        }
        return ascii >= zero && ascii <= nine
    }

    fileprivate static func cutAndPaste(_ line: String, parsed: ExternalLine) -> ExternalBringForwardResult {
        // AidanOS choice, pending section 7.6: skipping closed tasks is stated for lines scheduled together.
        // A cut leaves any task line as it is.
        guard parsed.kind.isTask else { return .unsettled }
        return .edited(sourceLine: nil, addedLine: line)
    }

    fileprivate struct RewrittenTask {
        var scheduled: String
        var copy: String
    }

    /// The copy keeps the open form the line already had.
    /// AidanOS choice, pending section 8A.2: a line with an empty box keeps that box on the copy.
    fileprivate static func scheduledAndOpenCopy(_ line: String) -> RewrittenTask? {
        let chars = Array(line)
        var index = 0
        while index < chars.count, chars[index] == "\t" {
            index += 1
        }
        let indent = String(chars[..<index])
        guard index < chars.count, chars[index] == "*" || chars[index] == "-" else { return nil }
        let marker = String(chars[index])
        index += 1
        guard index < chars.count, chars[index] == " " else { return nil }
        index += 1
        if index + 2 < chars.count, chars[index] == "[" {
            let box = String(chars[index..<(index + 3)])
            if box == "[ ]" {
                let scheduled = indent + marker + " [>]" + String(chars[(index + 3)...])
                return RewrittenTask(scheduled: scheduled, copy: line)
            }
            return nil
        }
        let rest = String(chars[index...])
        return RewrittenTask(scheduled: indent + marker + " [>] " + rest, copy: line)
    }

    fileprivate static func appendMark(_ line: String, _ mark: String) -> String {
        if line.last == " " || line.last == "\t" {
            return line + mark
        }
        return line + " " + mark
    }

    fileprivate static func isoDay(_ date: ExternalDate) -> String {
        let year = decimal(date.year, width: 4)
        let month = decimal(date.month, width: 2)
        let day = decimal(date.day, width: 2)
        return year + "-" + month + "-" + day
    }

    fileprivate static func decimal(_ value: Int, width: Int) -> String {
        var digits = String(value)
        while digits.count < width {
            digits = "0" + digits
        }
        return digits
    }

    fileprivate static func matchingBody(_ line: String) -> String {
        let chars = Array(line)
        var index = 0
        while index < chars.count, chars[index] == "\t" {
            index += 1
        }
        if index < chars.count,
           chars[index] == "*" || chars[index] == "-" || chars[index] == "+",
           index + 1 < chars.count, chars[index + 1] == " " {
            index += 2
        }
        if index + 2 < chars.count, chars[index] == "[" {
            let box = String(chars[index..<(index + 3)])
            if box == "[ ]" || box == "[x]" || box == "[-]" || box == "[>]" || box == "[X]" {
                index += 3
                if index < chars.count, chars[index] == " " {
                    index += 1
                }
            }
        }
        var kept: [Character] = []
        while index < chars.count {
            if let end = dateMarkEnd(chars, at: index) {
                index = end
                continue
            }
            kept.append(chars[index])
            index += 1
        }
        return collapseSpaces(trimSpaces(String(kept)))
    }

    fileprivate static func dateMarkEnd(_ chars: [Character], at index: Int) -> Int? {
        let boundary = index == 0 || chars[index - 1] == " " || chars[index - 1] == "\t"
        guard boundary, index < chars.count else { return nil }
        let sign = chars[index]
        guard sign == ">" || sign == "<" else { return nil }
        if sign == ">" {
            let word = Array("today")
            let end = index + 1 + word.count
            if end <= chars.count, Array(chars[(index + 1)..<end]) == word {
                if end == chars.count || !isBodyWord(chars[end]) {
                    return end
                }
            }
        }
        let start = index + 1
        guard start + 10 <= chars.count else { return nil }
        let text = String(chars[start..<(start + 10)])
        guard ExternalDate.parse(text) != nil else { return nil }
        let end = start + 10
        if end < chars.count, chars[end] >= "0", chars[end] <= "9" { return nil }
        return end
    }

    fileprivate static func isBodyWord(_ char: Character) -> Bool {
        char.isLetter || char.isNumber
    }

    fileprivate static func trimSpaces(_ text: String) -> String {
        var chars = Array(text)
        while chars.first == " " || chars.first == "\t" {
            chars.removeFirst()
        }
        while chars.last == " " || chars.last == "\t" {
            chars.removeLast()
        }
        return String(chars)
    }

    fileprivate static func collapseSpaces(_ text: String) -> String {
        var result: [Character] = []
        var pendingSpace = false
        for char in text {
            if char == " " || char == "\t" {
                pendingSpace = !result.isEmpty
                continue
            }
            if pendingSpace {
                result.append(" ")
                pendingSpace = false
            }
            result.append(char)
        }
        return String(result)
    }

    fileprivate static func weekdayIndex(_ day: ExternalDate) -> Int {
        let days = ExternalBringForwardDateMath.civilDays(day)
        let weekday = (days + 4) % 7
        return weekday >= 0 ? weekday : weekday + 7
    }
}

extension ExternalDate {
    fileprivate func adding(days: Int) -> ExternalDate {
        ExternalDate.fromCivilDays(ExternalBringForwardDateMath.civilDays(self) + days)
    }
}

fileprivate enum ExternalBringForwardDateMath {
    static func civilDays(_ date: ExternalDate) -> Int {
        var year = date.year
        let month = date.month
        let day = date.day
        year -= month <= 2 ? 1 : 0
        let era = (year >= 0 ? year : year - 399) / 400
        let yearOfEra = year - era * 400
        let dayOfYear = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let dayOfEra = yearOfEra * 365 + yearOfEra / 4 - yearOfEra / 100 + dayOfYear
        return era * 146097 + dayOfEra - 719468
    }
}

extension ExternalDate {
    fileprivate static func fromCivilDays(_ days: Int) -> ExternalDate {
        let shifted = days + 719468
        let era = (shifted >= 0 ? shifted : shifted - 146096) / 146097
        let dayOfEra = shifted - era * 146097
        let yearOfEra = (dayOfEra - dayOfEra / 1460 + dayOfEra / 36524 - dayOfEra / 146096) / 365
        var year = yearOfEra + era * 400
        let dayOfYear = dayOfEra - (365 * yearOfEra + yearOfEra / 4 - yearOfEra / 100)
        let monthPrime = (5 * dayOfYear + 2) / 153
        let day = dayOfYear - (153 * monthPrime + 2) / 5 + 1
        let month = monthPrime + (monthPrime < 10 ? 3 : -9)
        year += month <= 2 ? 1 : 0
        return ExternalDate(year: year, month: month, day: day)
    }
}
