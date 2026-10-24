/// Reads a note in the external calendar-and-project line format.
///
/// Each line is one paragraph. A task, checklist item, bullet, heading, or
/// plain line can carry dates, times, tags, mentions, and links.
public enum ExternalFormatReader {
    /// `Project note`, or `Day YYYY-MM-DD`. Other labels are not read here.
    public static func noteContext(labeled label: String) -> ExternalNoteContext? {
        if label == "Project note" {
            return .project
        }
        let prefix = "Day "
        guard label.hasPrefix(prefix) else { return nil }
        let rest = String(label.dropFirst(prefix.count))
        guard let day = ExternalDate.parse(rest) else { return nil }
        return .day(day)
    }

    public static func read(_ text: String, in context: ExternalNoteContext) -> ExternalNoteReading {
        var lines: [ExternalLine] = []
        var inFence = false
        for piece in splitLines(text) {
            if isCodeFence(piece) {
                // AidanOS choice, pending case 93. An opening fence with no closer stays open for the rest of the note. Lines that are not tasks keep their tags and dates.
                inFence.toggle()
                lines.append(readLine(piece, in: context))
                continue
            }
            var line = readLine(piece, in: context)
            // AidanOS choice, pending case 49
            if inFence, line.kind.isTask {
                line = leaveOutOfLists(line)
            }
            lines.append(line)
        }
        attachChildren(&lines)
        return ExternalNoteReading(context: context, lines: lines)
    }

    /// A typed date before the session day is overdue. The session day or a later
    /// typed date is upcoming. An open task with no typed date takes the day note's
    /// date: a past day is overdue, and today or a later day is upcoming.
    /// Checklist items are left out of both. A dateless task in a project note is unlisted.
    public static func placement(
        of line: ExternalLine,
        on sessionDay: ExternalDate,
        in context: ExternalNoteContext
    ) -> ExternalListPlacement {
        if line.leftOutOfOverdue {
            return .unlisted
        }
        if line.kind == .scheduledTask, case .day(let noteDay) = context, noteDay < sessionDay {
            if let date = line.scheduleDates.first, date >= sessionDay {
                // AidanOS choice, pending section 8B.1
                return .unlisted
            }
            // AidanOS choice, pending case 87
            return .unlisted
        }
        let eligible = line.countsAsOpen || line.kind == .scheduledTask
        if eligible, let date = line.scheduleDates.first {
            if date < sessionDay {
                return .overdue
            }
            return .upcoming
        }
        if line.countsAsOpen, case .day(let noteDay) = context {
            if noteDay < sessionDay {
                return .overdue
            }
            // AidanOS choice, pending case 82
            return .upcoming
        }
        return .unlisted
    }
}

public enum ExternalNoteContext: Equatable, Sendable {
    case project
    case day(ExternalDate)
}

public struct ExternalDate: Equatable, Comparable, Sendable {
    public var year: Int
    public var month: Int
    public var day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    public static func < (lhs: ExternalDate, rhs: ExternalDate) -> Bool {
        if lhs.year != rhs.year { return lhs.year < rhs.year }
        if lhs.month != rhs.month { return lhs.month < rhs.month }
        return lhs.day < rhs.day
    }

    /// A full `YYYY-MM-DD` calendar day. Anything else, including an impossible day, is nil.
    public static func parse(_ text: String) -> ExternalDate? {
        let chars = Array(text)
        guard let (date, end) = readISODate(chars, at: 0), end == chars.count else { return nil }
        return date
    }
}

public struct ExternalClockTime: Equatable, Sendable {
    public var hour: Int
    public var minute: Int

    public init(hour: Int, minute: Int) {
        self.hour = hour
        self.minute = minute
    }
}

public struct ExternalCompletion: Equatable, Sendable {
    public var day: ExternalDate
    public var time: ExternalClockTime?

    public init(day: ExternalDate, time: ExternalClockTime?) {
        self.day = day
        self.time = time
    }
}

public struct ExternalTimeBlock: Equatable, Sendable {
    public var start: ExternalClockTime
    public var end: ExternalClockTime?
    public var day: ExternalDate
    /// The clock was on a heading, so the block comes from that heading.
    public var fromHeading: Bool

    public init(start: ExternalClockTime, end: ExternalClockTime?, day: ExternalDate, fromHeading: Bool) {
        self.start = start
        self.end = end
        self.day = day
        self.fromHeading = fromHeading
    }
}

public struct ExternalTag: Equatable, Sendable {
    public var name: String
    /// `#zzhome/garden` sits under `zzhome`. A tag with no slash has no parent.
    public var parent: String?

    public init(name: String, parent: String?) {
        self.name = name
        self.parent = parent
    }
}

public struct ExternalMention: Equatable, Sendable {
    public var name: String
    /// The text inside parentheses, when the mention has them.
    public var value: String?

    public init(name: String, value: String?) {
        self.name = name
        self.value = value
    }
}

public struct ExternalWikiLink: Equatable, Sendable {
    public var target: String
    public var heading: String?
    public var shownText: String?
    /// Set when `target` is a calendar day.
    public var day: ExternalDate?

    public init(target: String, heading: String?, shownText: String?, day: ExternalDate?) {
        self.target = target
        self.heading = heading
        self.shownText = shownText
        self.day = day
    }
}

public struct ExternalMarkdownLink: Equatable, Sendable {
    public var shownText: String
    public var address: String

    public init(shownText: String, address: String) {
        self.shownText = shownText
        self.address = address
    }
}

public enum ExternalLineKind: Equatable, Sendable {
    case empty
    case plain
    case heading(level: Int)
    case bullet
    case openTask
    case doneTask
    case cancelledTask
    case scheduledTask
    case openChecklist
    /// The form is not settled, so this line stays out of the lists.
    case unsettled

    var isTask: Bool {
        switch self {
        case .openTask, .doneTask, .cancelledTask, .scheduledTask:
            return true
        default:
            return false
        }
    }

    var isHeading: Bool {
        if case .heading = self { return true }
        return false
    }

    var allowsTimeBlock: Bool {
        switch self {
        case .openTask, .doneTask, .cancelledTask, .scheduledTask, .bullet, .openChecklist, .heading:
            return true
        default:
            return false
        }
    }
}

public struct ExternalLine: Equatable, Sendable {
    public var kind: ExternalLineKind
    public var indentTabs: Int
    public var countsAsOpen: Bool
    public var leftOutOfOverdue: Bool
    public var completion: ExternalCompletion?
    public var scheduleDates: [ExternalDate]
    public var referencedDays: [ExternalDate]
    public var timeBlock: ExternalTimeBlock?
    public var tags: [ExternalTag]
    /// A tag or `@` date that stays out of the lists while the line itself stays.
    public var flaggedTokens: [String]
    public var mentions: [ExternalMention]
    public var wikiLinks: [ExternalWikiLink]
    public var markdownLinks: [ExternalMarkdownLink]
    public var childIndexes: [Int]

    public init(
        kind: ExternalLineKind,
        indentTabs: Int,
        countsAsOpen: Bool,
        leftOutOfOverdue: Bool,
        completion: ExternalCompletion?,
        scheduleDates: [ExternalDate],
        referencedDays: [ExternalDate],
        timeBlock: ExternalTimeBlock?,
        tags: [ExternalTag],
        flaggedTokens: [String],
        mentions: [ExternalMention],
        wikiLinks: [ExternalWikiLink],
        markdownLinks: [ExternalMarkdownLink],
        childIndexes: [Int]
    ) {
        self.kind = kind
        self.indentTabs = indentTabs
        self.countsAsOpen = countsAsOpen
        self.leftOutOfOverdue = leftOutOfOverdue
        self.completion = completion
        self.scheduleDates = scheduleDates
        self.referencedDays = referencedDays
        self.timeBlock = timeBlock
        self.tags = tags
        self.flaggedTokens = flaggedTokens
        self.mentions = mentions
        self.wikiLinks = wikiLinks
        self.markdownLinks = markdownLinks
        self.childIndexes = childIndexes
    }
}

public struct ExternalNoteReading: Equatable, Sendable {
    public var context: ExternalNoteContext
    public var lines: [ExternalLine]

    public init(context: ExternalNoteContext, lines: [ExternalLine]) {
        self.context = context
        self.lines = lines
    }
}

public enum ExternalListPlacement: Equatable, Sendable {
    case overdue
    case upcoming
    case unlisted
}

private enum BoxState {
    case open
    case done
    case cancelled
    case scheduled
}

private struct InlineMarks {
    var tags: [ExternalTag] = []
    var mentions: [ExternalMention] = []
    var wikiLinks: [ExternalWikiLink] = []
    var markdownLinks: [ExternalMarkdownLink] = []
    var scheduleDates: [ExternalDate] = []
    var blocked: [Range<Int>] = []
    var flaggedTokens: [String] = []
}

private enum TagIssue {
    case none
    case hyphen
    case digitsOnly
}

private enum BracketRead<Value> {
    case found(Value)
    case noCloser
    case rejected
    /// A closer was found and the link was not kept. `resume` is the index just past that closer.
    case rejectedClosed(resume: Int)
}

private struct FoundClock {
    var start: ExternalClockTime
    var end: ExternalClockTime?
}

extension ExternalFormatReader {
    /// `\r\n` is one Swift character, so a split on `"\n"` leaves that pair intact.
    /// Walk the scalars and break on `\n`, `\r\n`, and a lone `\r`.
    fileprivate static func splitLines(_ text: String) -> [String] {
        if text.isEmpty { return [] }
        let scalars = Array(text.unicodeScalars)
        var lines: [String] = []
        var current: [Unicode.Scalar] = []
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "\n" || scalar == "\r" {
                lines.append(String(String.UnicodeScalarView(current)))
                current.removeAll(keepingCapacity: true)
                if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" {
                    index += 2
                } else {
                    index += 1
                }
                continue
            }
            current.append(scalar)
            index += 1
        }
        if !current.isEmpty {
            lines.append(String(String.UnicodeScalarView(current)))
        }
        return lines
    }

    fileprivate static func readLine(_ line: String, in context: ExternalNoteContext) -> ExternalLine {
        let (indent, body) = indentAndBody(line)
        if body.isEmpty {
            return blankLine(indent: indent)
        }
        let (kind, content) = classify(body)
        return interpret(content: content, kind: kind, indent: indent, context: context)
    }

    fileprivate static func indentAndBody(_ line: String) -> (Int, String) {
        let chars = Array(line)
        var index = 0
        while index < chars.count, chars[index] == "\t" {
            index += 1
        }
        return (index, String(chars[index...]))
    }

    fileprivate static func classify(_ body: String) -> (ExternalLineKind, String) {
        if let heading = heading(body) {
            return heading
        }
        if body.hasPrefix("* ") {
            let content = String(body.dropFirst(2))
            // AidanOS choice, pending case 14
            if content.hasPrefix("[X]") {
                return (.unsettled, content)
            }
            let (state, rest) = takeBox(content)
            return (taskKind(state), rest)
        }
        if body.hasPrefix("- ") {
            let content = String(body.dropFirst(2))
            let (state, rest) = takeBox(content)
            if state == nil {
                return (.bullet, content)
            }
            return (taskKind(state), rest)
        }
        if body.hasPrefix("+ ") {
            let content = String(body.dropFirst(2))
            // AidanOS choice, pending case 9
            if content.hasPrefix("[x]") {
                return (.unsettled, content)
            }
            return (.openChecklist, content)
        }
        return (.plain, body)
    }

    fileprivate static func heading(_ body: String) -> (ExternalLineKind, String)? {
        let chars = Array(body)
        guard chars.first == "#" else { return nil }
        var index = 0
        while index < chars.count, chars[index] == "#" {
            index += 1
        }
        guard index < chars.count, chars[index] == " " else { return nil }
        let level = index
        let content = String(chars[(index + 1)...])
        return (.heading(level: level), content)
    }

    fileprivate static func takeBox(_ content: String) -> (BoxState?, String) {
        let boxes: [(String, BoxState)] = [
            ("[ ]", .open),
            ("[x]", .done),
            ("[-]", .cancelled),
            ("[>]", .scheduled),
        ]
        for (token, state) in boxes where content.hasPrefix(token) {
            var rest = String(content.dropFirst(token.count))
            if rest.hasPrefix(" ") { rest.removeFirst() }
            return (state, rest)
        }
        return (nil, content)
    }

    fileprivate static func taskKind(_ state: BoxState?) -> ExternalLineKind {
        switch state {
        case .done:
            return .doneTask
        case .cancelled:
            return .cancelledTask
        case .scheduled:
            return .scheduledTask
        case .open, nil:
            return .openTask
        }
    }

    fileprivate static func blankLine(indent: Int) -> ExternalLine {
        ExternalLine(
            kind: .empty,
            indentTabs: indent,
            countsAsOpen: false,
            leftOutOfOverdue: false,
            completion: nil,
            scheduleDates: [],
            referencedDays: [],
            timeBlock: nil,
            tags: [],
            flaggedTokens: [],
            mentions: [],
            wikiLinks: [],
            markdownLinks: [],
            childIndexes: []
        )
    }

    fileprivate static func interpret(
        content: String,
        kind: ExternalLineKind,
        indent: Int,
        context: ExternalNoteContext
    ) -> ExternalLine {
        let marks = scan(content)
        let unsettled = kind == .unsettled
        let resolved: ExternalLineKind = unsettled ? .unsettled : kind
        // AidanOS choice, pending case 97
        let closed = resolved == .doneTask || resolved == .cancelledTask || resolved == .scheduledTask
        let block = (unsettled || closed) ? nil : timeBlock(in: content, marks: marks, kind: resolved, context: context)
        let completion = unsettled ? nil : marks.mentions.first { $0.name == "done" }?.value.flatMap(readCompletion)
        return ExternalLine(
            kind: resolved,
            indentTabs: indent,
            countsAsOpen: resolved == .openTask,
            leftOutOfOverdue: resolved == .openChecklist || resolved == .unsettled,
            completion: completion,
            scheduleDates: unsettled ? [] : marks.scheduleDates,
            referencedDays: unsettled ? [] : references(marks: marks, kind: resolved, context: context),
            timeBlock: block,
            tags: unsettled ? [] : marks.tags,
            flaggedTokens: unsettled ? [] : marks.flaggedTokens,
            mentions: unsettled ? [] : marks.mentions,
            wikiLinks: unsettled ? [] : marks.wikiLinks,
            markdownLinks: unsettled ? [] : marks.markdownLinks,
            childIndexes: []
        )
    }

    /// Drops every field a list could read. The line stays in the note as unsettled.
    fileprivate static func leaveOutOfLists(_ line: ExternalLine) -> ExternalLine {
        var line = line
        line.kind = .unsettled
        line.countsAsOpen = false
        line.leftOutOfOverdue = true
        line.completion = nil
        line.scheduleDates = []
        line.referencedDays = []
        line.timeBlock = nil
        line.tags = []
        line.flaggedTokens = []
        line.mentions = []
        line.wikiLinks = []
        line.markdownLinks = []
        return line
    }

    fileprivate static func isCodeFence(_ line: String) -> Bool {
        let (_, body) = indentAndBody(line)
        let chars = Array(body)
        var index = 0
        while index < chars.count, chars[index] == " " {
            index += 1
        }
        guard index < chars.count else { return false }
        let marker = chars[index]
        guard marker == "`" || marker == "~" else { return false }
        let start = index
        while index < chars.count, chars[index] == marker {
            index += 1
        }
        guard index - start >= 3 else { return false }
        if index == chars.count { return true }
        guard chars[index] == " " else { return false }
        while index < chars.count {
            if chars[index] == marker { return false }
            index += 1
        }
        return true
    }

    /// A `>YYYY-MM-DD` on a task in a project note is also listed on that day.
    /// The same mark in a day note is not. A day link is listed from either note.
    fileprivate static func references(
        marks: InlineMarks,
        kind: ExternalLineKind,
        context: ExternalNoteContext
    ) -> [ExternalDate] {
        var days: [ExternalDate] = []
        for link in marks.wikiLinks {
            if let day = link.day, !days.contains(day) {
                days.append(day)
            }
        }
        if kind.isTask, case .project = context {
            for date in marks.scheduleDates where !days.contains(date) {
                days.append(date)
            }
        }
        return days
    }

    fileprivate static func timeBlock(
        in content: String,
        marks: InlineMarks,
        kind: ExternalLineKind,
        context: ExternalNoteContext
    ) -> ExternalTimeBlock? {
        guard kind.allowsTimeBlock, let found = findClock(blanked(content, blocking: marks.blocked)) else {
            return nil
        }
        let day: ExternalDate?
        switch context {
        case .day(let contextDay):
            day = contextDay
        case .project:
            day = marks.scheduleDates.first
        }
        guard let day else { return nil }
        return ExternalTimeBlock(
            start: found.start,
            end: found.end,
            day: day,
            fromHeading: kind.isHeading
        )
    }

    /// Indented lines belong to a task until a blank line, a heading, or a line
    /// back at the task's own indent. A typed rule line is not settled, so it is not a stop.
    fileprivate static func attachChildren(_ lines: inout [ExternalLine]) {
        for index in lines.indices {
            guard lines[index].kind.isTask else { continue }
            let parentIndent = lines[index].indentTabs
            var child = index + 1
            while child < lines.count {
                let line = lines[child]
                if line.kind == .empty || line.kind.isHeading || line.indentTabs <= parentIndent {
                    break
                }
                lines[index].childIndexes.append(child)
                child += 1
            }
        }
    }
}

extension ExternalFormatReader {
    fileprivate static func scan(_ content: String) -> InlineMarks {
        let chars = Array(content)
        var marks = InlineMarks()
        var index = 0
        // An unclosed opener has no closer later in the line. Remember that
        // so the next opener does not walk to the end again.
        var wikiHasNoCloser = false
        var markdownHasNoCloser = false
        var mentionParenHasNoCloser = false
        while index < chars.count {
            if chars[index] == "[", index + 1 < chars.count, chars[index + 1] == "[" {
                if !wikiHasNoCloser {
                    switch readWiki(chars, at: index) {
                    case .found((let link, let range)):
                        marks.wikiLinks.append(link)
                        marks.blocked.append(range)
                        index = range.upperBound
                        continue
                    case .noCloser:
                        wikiHasNoCloser = true
                    case .rejectedClosed(let resume):
                        // The closer was found and the link was not kept. Skip the span
                        // so a later opener does not walk to that same closer.
                        if resume > index {
                            index = resume
                            continue
                        }
                    case .rejected:
                        break
                    }
                }
            }
            if chars[index] == "[" {
                if !markdownHasNoCloser {
                    switch readMarkdown(chars, at: index) {
                    case .found((let link, let range, let address)):
                        marks.markdownLinks.append(link)
                        marks.blocked.append(address)
                        index = range.upperBound
                        continue
                    case .noCloser:
                        markdownHasNoCloser = true
                    case .rejected, .rejectedClosed:
                        break
                    }
                }
            }
            if chars[index] == "#", !wordBefore(chars, index), let (tag, range, issue) = readTag(chars, at: index) {
                switch issue {
                case .hyphen:
                    // AidanOS choice, pending case 95
                    marks.flaggedTokens.append(String(chars[range]))
                case .digitsOnly:
                    // AidanOS choice, pending case 39
                    marks.flaggedTokens.append(String(chars[range]))
                case .none:
                    marks.tags.append(tag)
                }
                index = range.upperBound
                continue
            }
            if chars[index] == "@", !wordBefore(chars, index),
               let (_, end) = readISODate(chars, at: index + 1) {
                // AidanOS choice, pending case 22
                marks.flaggedTokens.append(String(chars[index..<end]))
                index = end
                continue
            }
            if chars[index] == "@", !wordBefore(chars, index),
               let (mention, range, valueRange, unclosedParen) = readMention(
                   chars,
                   at: index,
                   parenHasNoCloser: mentionParenHasNoCloser
               ) {
                if unclosedParen {
                    mentionParenHasNoCloser = true
                }
                marks.mentions.append(mention)
                if let valueRange {
                    marks.blocked.append(valueRange)
                }
                index = range.upperBound
                continue
            }
            if chars[index] == ">", boundaryBefore(chars, index),
               let (date, end) = readISODate(chars, at: index + 1) {
                marks.scheduleDates.append(date)
                index = end
                continue
            }
            index += 1
        }
        return marks
    }

    fileprivate static func readWiki(
        _ chars: [Character],
        at start: Int
    ) -> BracketRead<(ExternalWikiLink, Range<Int>)> {
        guard start + 1 < chars.count, chars[start] == "[", chars[start + 1] == "[" else { return .rejected }
        var index = start + 2
        var inner: [Character] = []
        while index + 1 < chars.count {
            if chars[index] == "]", chars[index + 1] == "]" {
                guard let link = makeWiki(String(inner)) else { return .rejectedClosed(resume: index + 2) }
                return .found((link, start..<(index + 2)))
            }
            inner.append(chars[index])
            index += 1
        }
        return .noCloser
    }

    fileprivate static func makeWiki(_ inner: String) -> ExternalWikiLink? {
        let trimmed = trim(inner)
        guard !trimmed.isEmpty else { return nil }
        let pipe = trimmed.split(separator: "|", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let left = trim(pipe[0])
        let shown = pipe.count == 2 ? emptyToNil(trim(pipe[1])) : nil
        let hash = left.split(separator: "#", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
        let target = trim(hash[0])
        guard !target.isEmpty else { return nil }
        let heading = hash.count == 2 ? emptyToNil(trim(hash[1])) : nil
        return ExternalWikiLink(target: target, heading: heading, shownText: shown, day: ExternalDate.parse(target))
    }

    fileprivate static func readMarkdown(
        _ chars: [Character],
        at start: Int
    ) -> BracketRead<(ExternalMarkdownLink, Range<Int>, Range<Int>)> {
        guard chars[start] == "[" else { return .rejected }
        if start + 1 < chars.count, chars[start + 1] == "[" { return .rejected }
        var index = start + 1
        var shown: [Character] = []
        while index < chars.count, chars[index] != "]" {
            shown.append(chars[index])
            index += 1
        }
        guard index < chars.count, chars[index] == "]" else { return .noCloser }
        index += 1
        guard index < chars.count, chars[index] == "(" else { return .rejected }
        let addressStart = index
        index += 1
        var address: [Character] = []
        while index < chars.count, chars[index] != ")" {
            address.append(chars[index])
            index += 1
        }
        guard index < chars.count, chars[index] == ")" else { return .noCloser }
        index += 1
        let shownText = trim(String(shown))
        let addr = trim(String(address))
        guard !shownText.isEmpty, !addr.isEmpty else { return .rejected }
        let link = ExternalMarkdownLink(shownText: shownText, address: addr)
        return .found((link, start..<index, addressStart..<index))
    }

    fileprivate static func readTag(_ chars: [Character], at start: Int) -> (ExternalTag, Range<Int>, TagIssue)? {
        guard chars[start] == "#" else { return nil }
        var index = start + 1
        guard let first = readTagGroup(chars, from: &index) else { return nil }
        var groups = [first]
        var hyphen = false
        while index < chars.count {
            let saved = index
            let separator = chars[index]
            guard separator == "/" || separator == "-" else { break }
            index += 1
            if let next = readTagGroup(chars, from: &index) {
                if separator == "-" {
                    hyphen = true
                }
                groups.append(next)
            } else {
                index = saved
                break
            }
        }
        let digitsOnly = groups.allSatisfy { group in group.allSatisfy(isASCIIDigit) }
        let issue: TagIssue = hyphen ? .hyphen : (digitsOnly ? .digitsOnly : .none)
        let name = groups.joined(separator: "/")
        let parent = groups.count > 1 && issue == .none ? groups.dropLast().joined(separator: "/") : nil
        return (ExternalTag(name: name, parent: parent), start..<index, issue)
    }

    fileprivate static func readTagGroup(_ chars: [Character], from index: inout Int) -> String? {
        let start = index
        while index < chars.count, isTagChar(chars[index]) {
            index += 1
        }
        guard index > start else { return nil }
        return String(chars[start..<index])
    }

    fileprivate static func readMention(
        _ chars: [Character],
        at start: Int,
        parenHasNoCloser: Bool
    ) -> (ExternalMention, Range<Int>, Range<Int>?, Bool)? {
        guard chars[start] == "@" else { return nil }
        var index = start + 1
        guard let name = readTagGroup(chars, from: &index) else { return nil }
        if index < chars.count, chars[index] == "(" {
            if parenHasNoCloser {
                return (ExternalMention(name: name, value: nil), start..<index, nil, false)
            }
            let open = index
            index += 1
            let valueStart = index
            while index < chars.count, chars[index] != ")" {
                index += 1
            }
            if index < chars.count, chars[index] == ")" {
                let value = String(chars[valueStart..<index])
                index += 1
                return (ExternalMention(name: name, value: value), start..<index, open..<index, false)
            }
            return (ExternalMention(name: name, value: nil), start..<open, nil, true)
        }
        return (ExternalMention(name: name, value: nil), start..<index, nil, false)
    }

    fileprivate static func readCompletion(_ value: String) -> ExternalCompletion? {
        let chars = Array(value)
        guard let (day, next) = readISODate(chars, at: 0) else { return nil }
        if next == chars.count {
            return ExternalCompletion(day: day, time: nil)
        }
        guard chars[next] == " " else { return nil }
        guard let (time, end) = readHourMinute(chars, at: next + 1), end == chars.count else { return nil }
        return ExternalCompletion(day: day, time: time)
    }

    fileprivate static func findClock(_ chars: [Character]) -> FoundClock? {
        var index = 0
        while index < chars.count {
            if let (start, endIndex) = readClock(chars, at: index) {
                if let (endTime, _) = readRangeEnd(chars, after: endIndex) {
                    return FoundClock(start: start, end: endTime)
                }
                return FoundClock(start: start, end: nil)
            }
            index += 1
        }
        return nil
    }

    fileprivate static func readRangeEnd(_ chars: [Character], after end: Int) -> (ExternalClockTime, Int)? {
        var index = end
        guard index < chars.count, chars[index] == " " else { return nil }
        while index < chars.count, chars[index] == " " {
            index += 1
        }
        guard index < chars.count, chars[index] == "-" else { return nil }
        index += 1
        guard index < chars.count, chars[index] == " " else { return nil }
        while index < chars.count, chars[index] == " " {
            index += 1
        }
        guard let (time, next) = readClock(chars, at: index) else { return nil }
        return (time, next)
    }

    fileprivate static func readClock(_ chars: [Character], at start: Int) -> (ExternalClockTime, Int)? {
        guard !wordBefore(chars, start) else { return nil }
        var index = start
        var hour = 0
        var digits = 0
        while index < chars.count, digits < 2, isASCIIDigit(chars[index]) {
            hour = hour * 10 + digitValue(chars[index])
            index += 1
            digits += 1
        }
        guard digits >= 1, index < chars.count, chars[index] == ":" else { return nil }
        index += 1
        guard index + 1 < chars.count, isASCIIDigit(chars[index]), isASCIIDigit(chars[index + 1]) else {
            return nil
        }
        let minute = digitValue(chars[index]) * 10 + digitValue(chars[index + 1])
        index += 2
        guard (0...59).contains(minute) else { return nil }
        if let suffix = meridian(chars, at: index) {
            guard let hour24 = hourOn12HourClock(hour, pm: suffix.pm) else { return nil }
            return (ExternalClockTime(hour: hour24, minute: minute), suffix.end)
        }
        guard (0...23).contains(hour) else { return nil }
        if index < chars.count, isWordChar(chars[index]) { return nil }
        return (ExternalClockTime(hour: hour, minute: minute), index)
    }

    fileprivate static func meridian(_ chars: [Character], at index: Int) -> (pm: Bool, end: Int)? {
        guard index + 1 < chars.count else { return nil }
        let suffix = String(chars[index...(index + 1)])
        guard suffix == "am" || suffix == "pm" else { return nil }
        let end = index + 2
        if end < chars.count, isWordChar(chars[end]) { return nil }
        return (suffix == "pm", end)
    }

    fileprivate static func hourOn12HourClock(_ hour: Int, pm: Bool) -> Int? {
        guard (1...12).contains(hour) else { return nil }
        if hour == 12 { return pm ? 12 : 0 }
        return pm ? hour + 12 : hour
    }

    fileprivate static func readHourMinute(_ chars: [Character], at start: Int) -> (ExternalClockTime, Int)? {
        var index = start
        var hour = 0
        var digits = 0
        while index < chars.count, digits < 2, isASCIIDigit(chars[index]) {
            hour = hour * 10 + digitValue(chars[index])
            index += 1
            digits += 1
        }
        guard digits >= 1, index < chars.count, chars[index] == ":" else { return nil }
        index += 1
        guard index + 1 < chars.count, isASCIIDigit(chars[index]), isASCIIDigit(chars[index + 1]) else {
            return nil
        }
        let minute = digitValue(chars[index]) * 10 + digitValue(chars[index + 1])
        index += 2
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        return (ExternalClockTime(hour: hour, minute: minute), index)
    }

    fileprivate static func blanked(_ content: String, blocking ranges: [Range<Int>]) -> [Character] {
        var chars = Array(content)
        for range in ranges {
            for index in range where index < chars.count {
                chars[index] = " "
            }
        }
        return chars
    }

    fileprivate static func wordBefore(_ chars: [Character], _ index: Int) -> Bool {
        index > 0 && isWordChar(chars[index - 1])
    }

    fileprivate static func boundaryBefore(_ chars: [Character], _ index: Int) -> Bool {
        index == 0 || chars[index - 1] == " " || chars[index - 1] == "\t"
    }

    fileprivate static func isWordChar(_ char: Character) -> Bool {
        char.isLetter || char.isNumber
    }

    fileprivate static func isNameChar(_ char: Character) -> Bool {
        char.isLetter || isASCIIDigit(char) || char == "_"
    }

    /// Emoji may sit inside a tag or a mention, including at the top of a nested tag.
    /// ASCII digits and marks are not emoji here. Trademark and copyright signs are not either.
    fileprivate static func isTagChar(_ char: Character) -> Bool {
        if isNameChar(char) { return true }
        guard char.asciiValue == nil else { return false }
        for scalar in char.unicodeScalars {
            if scalar.value == 0x00A9 || scalar.value == 0x2122 {
                return false
            }
        }
        return char.unicodeScalars.contains { $0.properties.isEmoji }
    }

    fileprivate static func isASCIIDigit(_ char: Character) -> Bool {
        guard let ascii = char.asciiValue, let zero = Character("0").asciiValue, let nine = Character("9").asciiValue else {
            return false
        }
        return ascii >= zero && ascii <= nine
    }

    fileprivate static func digitValue(_ char: Character) -> Int {
        guard let ascii = char.asciiValue, let zero = Character("0").asciiValue else { return 0 }
        return Int(ascii - zero)
    }

    fileprivate static func trim(_ text: String) -> String {
        var chars = Array(text)
        while chars.first == " " || chars.first == "\t" {
            chars.removeFirst()
        }
        while chars.last == " " || chars.last == "\t" {
            chars.removeLast()
        }
        return String(chars)
    }

    fileprivate static func emptyToNil(_ text: String) -> String? {
        text.isEmpty ? nil : text
    }
}

private func readISODate(_ chars: [Character], at start: Int) -> (ExternalDate, Int)? {
    guard let year = readDigits(4, chars, start) else { return nil }
    var index = year.end
    guard index < chars.count, chars[index] == "-" else { return nil }
    index += 1
    guard let month = readDigits(2, chars, index) else { return nil }
    index = month.end
    guard index < chars.count, chars[index] == "-" else { return nil }
    index += 1
    guard let day = readDigits(2, chars, index) else { return nil }
    index = day.end
    if index < chars.count, chars[index] >= "0", chars[index] <= "9" { return nil }
    guard let date = calendarDate(year: year.value, month: month.value, day: day.value) else { return nil }
    return (date, index)
}

private func readDigits(_ count: Int, _ chars: [Character], _ start: Int) -> (value: Int, end: Int)? {
    guard start + count <= chars.count else { return nil }
    var value = 0
    for offset in 0..<count {
        let char = chars[start + offset]
        guard char >= "0", char <= "9", let ascii = char.asciiValue else { return nil }
        value = value * 10 + Int(ascii - Character("0").asciiValue!)
    }
    return (value, start + count)
}

private func calendarDate(year: Int, month: Int, day: Int) -> ExternalDate? {
    guard year >= 1, month >= 1, month <= 12 else { return nil }
    var length = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    if month == 2, isLeapYear(year) { length = 29 }
    guard day >= 1, day <= length else { return nil }
    return ExternalDate(year: year, month: month, day: day)
}

private func isLeapYear(_ year: Int) -> Bool {
    if year % 400 == 0 { return true }
    if year % 100 == 0 { return false }
    return year % 4 == 0
}
