/// How an unfinished task moves to another day, and what a new day receives.
///
/// Today's date is always an argument. Nothing here reads a clock or writes a file.
/// The three ways to move a task are one setting, and the caller passes it.
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
    /// The days this weekly note covers. The caller passes them.
    public var days: [ExternalDate]
    public var lines: [ExternalLine]

    public init(days: [ExternalDate], lines: [ExternalLine]) {
        self.days = days
        self.lines = lines
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
    /// A note that already has text is left as it is. Tasks in earlier notes stay there.
    public static func openDay(
        existingText: String?,
        template: String?,
        earlierNotes: [ExternalDayText],
        today: ExternalDate
    ) -> ExternalOpenedDay {
        // Look at earlier notes so a task there can be reviewed, then leave it where it is.
        for note in earlierNotes {
            let reading = read(note.text, in: .day(note.day))
            for line in reading.lines {
                if placement(of: line, on: today, in: reading.context) == .overdue {
                    continue
                }
            }
        }
        if let existingText {
            return ExternalOpenedDay(text: existingText, broughtLines: [])
        }
        return ExternalOpenedDay(text: template ?? "", broughtLines: [])
    }

    /// An open task in a weekly note is listed on each day the caller says that week covers.
    public static func readWeekly(_ text: String, covering days: [ExternalDate]) -> ExternalWeeklyReading {
        // AidanOS choice, pending section 4.4: a weekly note is read like a project note for clocks,
        // so a clock with no typed date does not become a time block.
        let note = read(text, in: .project)
        var lines = note.lines
        var covered: [ExternalDate] = []
        for day in days where !covered.contains(day) {
            covered.append(day)
        }
        for index in lines.indices {
            // AidanOS choice, pending section 3.8: the worked line is an open task.
            // Other kinds are not given the week's days.
            guard lines[index].kind == .openTask else { continue }
            for day in covered where !lines[index].referencedDays.contains(day) {
                lines[index].referencedDays.append(day)
            }
        }
        return ExternalWeeklyReading(days: covered, lines: lines)
    }

    /// A fixed reference day, or the passed day when the line carries `>today` and is not done.
    public static func references(_ line: ExternalLine, on day: ExternalDate, today: ExternalDate) -> Bool {
        if line.referencedDays.contains(day) { return true }
        return line.carriesToday && day == today
    }

    /// True when the day has a task that places as overdue. A checklist does not count.
    public static func dayCountsAsOverdue(_ note: ExternalNoteReading, on today: ExternalDate) -> Bool {
        note.lines.contains { placement(of: $0, on: today, in: note.context) == .overdue }
    }

    /// How many times the task was put off. Each `[>]` line in the chain counts once.
    /// `<` marks on one copy do not.
    public static func moveCount(
        ofLineAt index: Int,
        on day: ExternalDate,
        in notes: [ExternalDayText]
    ) -> Int {
        guard let note = notes.first(where: { $0.day == day }) else { return 0 }
        let lines = paragraphs(in: note.text)
        guard lines.indices.contains(index) else { return 0 }
        let parsed = read(lines[index], in: .day(day))
        guard parsed.lines.count == 1, parsed.lines[0].kind.isTask else { return 0 }
        let body = matchingBody(lines[index])
        guard !body.isEmpty else { return 0 }

        struct Link: Equatable {
            var from: ExternalDate
            var to: ExternalDate
        }
        var links: [Link] = []
        for source in notes {
            let raw = paragraphs(in: source.text)
            let reading = read(source.text, in: .day(source.day))
            guard raw.count == reading.lines.count else { continue }
            for offset in reading.lines.indices {
                let line = reading.lines[offset]
                guard line.kind == .scheduledTask, matchingBody(raw[offset]) == body else { continue }
                // AidanOS choice, pending section 7.9: the first typed date is the link.
                guard let target = line.scheduleDates.first else { continue }
                let link = Link(from: source.day, to: target)
                if !links.contains(link) { links.append(link) }
            }
        }
        var days: Set<ExternalDate> = [day]
        var included: Set<Int> = []
        var grew = true
        while grew {
            grew = false
            for offset in links.indices {
                let link = links[offset]
                if days.contains(link.from) || days.contains(link.to) {
                    if included.insert(offset).inserted {
                        days.insert(link.from)
                        days.insert(link.to)
                        grew = true
                    }
                }
            }
        }
        return included.count
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
        // AidanOS choice, pending section 7.4: the copy names the day it came from,
        // and a project note has no day of its own to write there.
        guard case .day(let origin) = context else { return .unsettled }
        // Case 53 and case 75 are not settled. A today tag on a copied line is not settled either.
        if !parsed.scheduleDates.isEmpty || !parsed.broughtFromDays.isEmpty || parsed.carriesToday {
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
            return .edited(sourceLine: line, addedLine: line)
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
}
