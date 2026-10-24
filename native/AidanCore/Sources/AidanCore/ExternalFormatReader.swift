import Foundation

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
        let stage = text.utf8.count >= 100_000
        let started = stage ? Date() : nil
        var lines: [ExternalLine] = []
        var cost = ScanCost()
        // Marker, length, and whether the opening line is only that marker.
        var openFence: (marker: Character, length: Int, bare: Bool)?
        let pieces = splitLines(text)
        let splitAt = stage ? Date() : nil
        for piece in pieces {
            if let fence = codeFence(piece) {
                if let open = openFence {
                    if fence.bare, fence.marker == open.marker, fence.length >= open.length {
                        openFence = nil
                        let line = readLine(piece, in: context, cost: &cost)
                        // AidanOS choice, pending case 93
                        lines.append(leaveOutOfLists(line))
                        continue
                    }
                } else {
                    // An opening fence with no closer stays open for the rest of the note.
                    openFence = fence
                    let line = readLine(piece, in: context, cost: &cost)
                    // AidanOS choice, pending case 93
                    lines.append(leaveOutOfLists(line))
                    continue
                }
            }
            var line = readLine(piece, in: context, cost: &cost)
            if openFence != nil, line.kind != .empty {
                if line.kind.isTask {
                    // AidanOS choice, pending case 49
                    line = leaveOutOfLists(line)
                } else {
                    // AidanOS choice, pending case 93
                    line = leaveOutOfLists(line)
                }
            }
            lines.append(line)
        }
        let readAt = stage ? Date() : nil
        attachChildren(&lines)
        if stage, let started, let splitAt, let readAt {
            let done = Date()
            print(String(
                format: "reader-stage split %.4f prepare %.4f bytes %.4f walk %.4f attach %.4f mentions %d utf8 %d",
                splitAt.timeIntervalSince(started),
                cost.prepare,
                cost.byteCopy,
                cost.walk,
                done.timeIntervalSince(readAt),
                cost.mentions,
                text.utf8.count
            ))
        }
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

/// Times recorded while reading one large note. Small notes leave this at zero.
private struct ScanCost {
    var prepare: TimeInterval = 0
    var byteCopy: TimeInterval = 0
    var walk: TimeInterval = 0
    var mentions: Int = 0
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

/// How far a search for one closer has read. `read` is the first index not yet examined.
private struct CloserSearch {
    var read: Int = 0
    var closer: Int? = nil
    /// The bracket closer was found and the link was not kept.
    var rejected = false
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
        // UTF-8 never hides a CR or LF inside another scalar. A note with no
        // line break is already one line, so do not copy its scalars.
        let breaks = text.utf8.contains { $0 == 10 || $0 == 13 }
        if !breaks { return [text] }
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

    fileprivate static func readLine(
        _ line: String,
        in context: ExternalNoteContext,
        cost: inout ScanCost
    ) -> ExternalLine {
        let stage = line.utf8.count >= 100_000
        let started = stage ? Date() : nil
        let (indent, body) = indentAndBody(line)
        if body.isEmpty {
            return blankLine(indent: indent)
        }
        let (kind, content) = classify(body)
        if let started {
            cost.prepare += Date().timeIntervalSince(started)
        }
        return interpret(content: content, kind: kind, indent: indent, context: context, cost: &cost)
    }

    /// Leading tabs are ASCII, so the indent is a UTF-8 prefix. A line with no
    /// tabs keeps its original storage instead of copying every character.
    fileprivate static func indentAndBody(_ line: String) -> (Int, String) {
        var indent = 0
        let utf8 = line.utf8
        var index = utf8.startIndex
        while index < utf8.endIndex, utf8[index] == 9 {
            indent += 1
            index = utf8.index(after: index)
        }
        if indent == 0 { return (0, line) }
        return (indent, String(line[index...]))
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
        context: ExternalNoteContext,
        cost: inout ScanCost
    ) -> ExternalLine {
        let marks = scan(content, cost: &cost)
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

    /// A fence is three or more backticks, or three or more tildes. The two
    /// markers are different. Text after the marker can open a block. Only a
    /// bare marker, at least as long as the opener, closes one.
    fileprivate static func codeFence(_ line: String) -> (marker: Character, length: Int, bare: Bool)? {
        let (_, body) = indentAndBody(line)
        let chars = Array(body)
        var index = 0
        while index < chars.count, chars[index] == " " {
            index += 1
        }
        guard index < chars.count else { return nil }
        let marker = chars[index]
        guard marker == "`" || marker == "~" else { return nil }
        let start = index
        while index < chars.count, chars[index] == marker {
            index += 1
        }
        let length = index - start
        guard length >= 3 else { return nil }
        if index == chars.count { return (marker, length, true) }
        guard chars[index] == " " else { return nil }
        var sawInfo = false
        while index < chars.count {
            if chars[index] == marker { return nil }
            if chars[index] != " " { sawInfo = true }
            index += 1
        }
        return (marker, length, !sawInfo)
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
    /// ASCII lines are walked as stored UTF-8 bytes. Other lines use characters,
    /// because a tag can hold an emoji and the closer indexes have to match that.
    fileprivate static func scan(_ content: String, cost: inout ScanCost) -> InlineMarks {
        let stage = content.utf8.count >= 100_000
        let started = stage ? Date() : nil
        let bytes = Array(content.utf8)
        let ascii = bytes.allSatisfy { $0 < 128 }
        if let started {
            cost.byteCopy += Date().timeIntervalSince(started)
        }
        let walkStart = stage ? Date() : nil
        let marks = ascii ? scanASCII(bytes) : scanCharacters(Array(content))
        if let walkStart {
            cost.walk += Date().timeIntervalSince(walkStart)
            cost.mentions += marks.mentions.count
        }
        return marks
    }

    fileprivate static func scanCharacters(_ chars: [Character]) -> InlineMarks {
        var marks = InlineMarks()
        var index = 0
        // How far a search for each closer has already read. A later opener
        // continues from that point and does not read behind it.
        var wiki = CloserSearch()
        var markdown = CloserSearch()
        var mentionParen = CloserSearch()
        while index < chars.count {
            if chars[index] == "[", index + 1 < chars.count, chars[index + 1] == "[" {
                switch readWiki(chars, at: index, search: &wiki) {
                case .found((let link, let range)):
                    marks.wikiLinks.append(link)
                    marks.blocked.append(range)
                    index = range.upperBound
                    continue
                case .noCloser:
                    break
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
            if chars[index] == "[" {
                switch readMarkdown(chars, at: index, search: &markdown) {
                case .found((let link, let range, let address)):
                    marks.markdownLinks.append(link)
                    marks.blocked.append(address)
                    index = range.upperBound
                    continue
                case .noCloser:
                    break
                case .rejected, .rejectedClosed:
                    break
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
               index + 1 < chars.count, isASCIIDigit(chars[index + 1]),
               let (_, end) = readISODate(chars, at: index + 1) {
                // AidanOS choice, pending case 22
                marks.flaggedTokens.append(String(chars[index..<end]))
                index = end
                continue
            }
            if chars[index] == "@", !wordBefore(chars, index) {
                if let (mention, range, valueRange) = readMention(
                    chars,
                    at: index,
                    paren: &mentionParen
                ) {
                    marks.mentions.append(mention)
                    if let valueRange {
                        marks.blocked.append(valueRange)
                    }
                    index = range.upperBound
                    continue
                }
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

    /// One pass over UTF-8 bytes. Indexes match characters because every byte is ASCII.
    fileprivate static func scanASCII(_ bytes: [UInt8]) -> InlineMarks {
        var marks = InlineMarks()
        var index = 0
        var wiki = CloserSearch()
        var markdown = CloserSearch()
        var mentionParen = CloserSearch()
        while index < bytes.count {
            if bytes[index] == 91, index + 1 < bytes.count, bytes[index + 1] == 91 {
                switch readWikiASCII(bytes, at: index, search: &wiki) {
                case .found((let link, let range)):
                    marks.wikiLinks.append(link)
                    marks.blocked.append(range)
                    index = range.upperBound
                    continue
                case .noCloser:
                    break
                case .rejectedClosed(let resume):
                    if resume > index {
                        index = resume
                        continue
                    }
                case .rejected:
                    break
                }
            }
            if bytes[index] == 91 {
                switch readMarkdownASCII(bytes, at: index, search: &markdown) {
                case .found((let link, let range, let address)):
                    marks.markdownLinks.append(link)
                    marks.blocked.append(address)
                    index = range.upperBound
                    continue
                case .noCloser:
                    break
                case .rejected, .rejectedClosed:
                    break
                }
            }
            if bytes[index] == 35, !wordBeforeASCII(bytes, index),
               let (tag, range, issue) = readTagASCII(bytes, at: index) {
                switch issue {
                case .hyphen:
                    // AidanOS choice, pending case 95
                    marks.flaggedTokens.append(asciiText(bytes, range))
                case .digitsOnly:
                    // AidanOS choice, pending case 39
                    marks.flaggedTokens.append(asciiText(bytes, range))
                case .none:
                    marks.tags.append(tag)
                }
                index = range.upperBound
                continue
            }
            if bytes[index] == 64, !wordBeforeASCII(bytes, index),
               index + 1 < bytes.count, isDigitByte(bytes[index + 1]),
               let (_, end) = readISODateASCII(bytes, at: index + 1) {
                // AidanOS choice, pending case 22
                marks.flaggedTokens.append(asciiText(bytes, index..<end))
                index = end
                continue
            }
            if bytes[index] == 64, !wordBeforeASCII(bytes, index) {
                if let (mention, range, valueRange) = readMentionASCII(
                    bytes,
                    at: index,
                    paren: &mentionParen
                ) {
                    marks.mentions.append(mention)
                    if let valueRange {
                        marks.blocked.append(valueRange)
                    }
                    index = range.upperBound
                    continue
                }
            }
            if bytes[index] == 62, boundaryBeforeASCII(bytes, index),
               let (date, end) = readISODateASCII(bytes, at: index + 1) {
                marks.scheduleDates.append(date)
                index = end
                continue
            }
            index += 1
        }
        return marks
    }

    fileprivate static func readWikiASCII(
        _ bytes: [UInt8],
        at start: Int,
        search: inout CloserSearch
    ) -> BracketRead<(ExternalWikiLink, Range<Int>)> {
        guard start + 1 < bytes.count, bytes[start] == 91, bytes[start + 1] == 91 else { return .rejected }
        if search.closer == nil, search.read >= bytes.count, search.read > start {
            return .noCloser
        }
        if let closer = search.closer {
            if start > closer {
                search = CloserSearch()
            } else {
                return .rejectedClosed(resume: search.read)
            }
        }
        var index = start + 2
        var inner: [UInt8] = []
        while index + 1 < bytes.count {
            if bytes[index] == 93, bytes[index + 1] == 93 {
                search.read = index + 2
                search.closer = index
                guard let link = makeWiki(asciiText(inner)) else {
                    return .rejectedClosed(resume: index + 2)
                }
                return .found((link, start..<(index + 2)))
            }
            inner.append(bytes[index])
            index += 1
        }
        search.read = bytes.count
        search.closer = nil
        return .noCloser
    }

    fileprivate static func readMarkdownASCII(
        _ bytes: [UInt8],
        at start: Int,
        search: inout CloserSearch
    ) -> BracketRead<(ExternalMarkdownLink, Range<Int>, Range<Int>)> {
        guard bytes[start] == 91 else { return .rejected }
        if start + 1 < bytes.count, bytes[start + 1] == 91 { return .rejected }
        if search.closer == nil, search.read >= bytes.count, search.read > start {
            return .noCloser
        }
        if search.rejected, let closer = search.closer, start <= closer {
            return .rejected
        }
        if let closer = search.closer, start > closer {
            search = CloserSearch()
        }
        var index = start + 1
        var shown: [UInt8] = []
        while index < bytes.count, bytes[index] != 93 {
            shown.append(bytes[index])
            index += 1
        }
        guard index < bytes.count, bytes[index] == 93 else {
            search.read = bytes.count
            search.closer = nil
            search.rejected = false
            return .noCloser
        }
        search.read = index + 1
        search.closer = index
        search.rejected = false
        index += 1
        guard index < bytes.count, bytes[index] == 40 else {
            search.rejected = true
            return .rejected
        }
        let addressStart = index
        index += 1
        var address: [UInt8] = []
        while index < bytes.count, bytes[index] != 41 {
            address.append(bytes[index])
            index += 1
        }
        guard index < bytes.count, bytes[index] == 41 else {
            search.read = bytes.count
            search.closer = nil
            search.rejected = false
            return .noCloser
        }
        index += 1
        let shownText = trim(asciiText(shown))
        let addr = trim(asciiText(address))
        guard !shownText.isEmpty, !addr.isEmpty else {
            search.rejected = true
            return .rejected
        }
        let link = ExternalMarkdownLink(shownText: shownText, address: addr)
        return .found((link, start..<index, addressStart..<index))
    }

    fileprivate static func readTagASCII(
        _ bytes: [UInt8],
        at start: Int
    ) -> (ExternalTag, Range<Int>, TagIssue)? {
        guard bytes[start] == 35 else { return nil }
        var index = start + 1
        guard let first = readTagGroupASCII(bytes, from: &index) else { return nil }
        var groups = [first]
        var hyphen = false
        while index < bytes.count {
            let saved = index
            let separator = bytes[index]
            guard separator == 47 || separator == 45 else { break }
            index += 1
            if let next = readTagGroupASCII(bytes, from: &index) {
                if separator == 45 {
                    hyphen = true
                }
                groups.append(next)
            } else {
                index = saved
                break
            }
        }
        let digitsOnly = groups.allSatisfy { group in group.utf8.allSatisfy(isDigitByte) }
        let issue: TagIssue = hyphen ? .hyphen : (digitsOnly ? .digitsOnly : .none)
        let name = groups.joined(separator: "/")
        let parent = groups.count > 1 && issue == .none ? groups.dropLast().joined(separator: "/") : nil
        return (ExternalTag(name: name, parent: parent), start..<index, issue)
    }

    fileprivate static func readTagGroupASCII(_ bytes: [UInt8], from index: inout Int) -> String? {
        let start = index
        while index < bytes.count, isNameByte(bytes[index]) {
            index += 1
        }
        guard index > start else { return nil }
        return asciiText(bytes, start..<index)
    }

    fileprivate static func readMentionASCII(
        _ bytes: [UInt8],
        at start: Int,
        paren: inout CloserSearch
    ) -> (ExternalMention, Range<Int>, Range<Int>?)? {
        guard bytes[start] == 64 else { return nil }
        var index = start + 1
        guard let name = readTagGroupASCII(bytes, from: &index) else { return nil }
        guard index < bytes.count, bytes[index] == 40 else {
            return (ExternalMention(name: name, value: nil), start..<index, nil)
        }
        let open = index
        if paren.read > open {
            return (ExternalMention(name: name, value: nil), start..<open, nil)
        }
        var cursor = open + 1
        let valueStart = cursor
        while cursor < bytes.count {
            if bytes[cursor] == 41 {
                paren.read = cursor + 1
                paren.closer = cursor
                let value = asciiText(bytes, valueStart..<cursor)
                return (ExternalMention(name: name, value: value), start..<(cursor + 1), open..<(cursor + 1))
            }
            if bytes[cursor] == 64 || bytes[cursor] == 35, !wordBeforeASCII(bytes, cursor) {
                paren.read = cursor
                paren.closer = nil
                return (ExternalMention(name: name, value: nil), start..<open, nil)
            }
            cursor += 1
        }
        paren.read = bytes.count
        paren.closer = nil
        return (ExternalMention(name: name, value: nil), start..<open, nil)
    }

    fileprivate static func readISODateASCII(_ bytes: [UInt8], at start: Int) -> (ExternalDate, Int)? {
        guard let year = readDigitsASCII(4, bytes, start) else { return nil }
        var index = year.end
        guard index < bytes.count, bytes[index] == 45 else { return nil }
        index += 1
        guard let month = readDigitsASCII(2, bytes, index) else { return nil }
        index = month.end
        guard index < bytes.count, bytes[index] == 45 else { return nil }
        index += 1
        guard let day = readDigitsASCII(2, bytes, index) else { return nil }
        index = day.end
        if index < bytes.count, isDigitByte(bytes[index]) { return nil }
        guard let date = calendarDate(year: year.value, month: month.value, day: day.value) else { return nil }
        return (date, index)
    }

    fileprivate static func readDigitsASCII(
        _ count: Int,
        _ bytes: [UInt8],
        _ start: Int
    ) -> (value: Int, end: Int)? {
        guard start + count <= bytes.count else { return nil }
        var value = 0
        for offset in 0..<count {
            let byte = bytes[start + offset]
            guard isDigitByte(byte) else { return nil }
            value = value * 10 + Int(byte - 48)
        }
        return (value, start + count)
    }

    fileprivate static func asciiText(_ bytes: [UInt8], _ range: Range<Int>) -> String {
        if range.count == 1 {
            return String(Unicode.Scalar(bytes[range.lowerBound]))
        }
        return String(decoding: bytes[range], as: UTF8.self)
    }

    fileprivate static func asciiText(_ bytes: [UInt8]) -> String {
        if bytes.count == 1 {
            return String(Unicode.Scalar(bytes[0]))
        }
        return String(decoding: bytes, as: UTF8.self)
    }

    @inline(__always)
    fileprivate static func isDigitByte(_ byte: UInt8) -> Bool {
        byte >= 48 && byte <= 57
    }

    @inline(__always)
    fileprivate static func isWordByte(_ byte: UInt8) -> Bool {
        isDigitByte(byte) || (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)
    }

    @inline(__always)
    fileprivate static func isNameByte(_ byte: UInt8) -> Bool {
        byte == 95 || isWordByte(byte)
    }

    @inline(__always)
    fileprivate static func wordBeforeASCII(_ bytes: [UInt8], _ index: Int) -> Bool {
        index > 0 && isWordByte(bytes[index - 1])
    }

    @inline(__always)
    fileprivate static func boundaryBeforeASCII(_ bytes: [UInt8], _ index: Int) -> Bool {
        index == 0 || bytes[index - 1] == 32 || bytes[index - 1] == 9
    }

    fileprivate static func readWiki(
        _ chars: [Character],
        at start: Int,
        search: inout CloserSearch
    ) -> BracketRead<(ExternalWikiLink, Range<Int>)> {
        guard start + 1 < chars.count, chars[start] == "[", chars[start + 1] == "[" else { return .rejected }
        if search.closer == nil, search.read >= chars.count, search.read > start {
            return .noCloser
        }
        if let closer = search.closer {
            if start > closer {
                search = CloserSearch()
            } else {
                return .rejectedClosed(resume: search.read)
            }
        }
        var index = start + 2
        var inner: [Character] = []
        while index + 1 < chars.count {
            if chars[index] == "]", chars[index + 1] == "]" {
                search.read = index + 2
                search.closer = index
                guard let link = makeWiki(String(inner)) else { return .rejectedClosed(resume: index + 2) }
                return .found((link, start..<(index + 2)))
            }
            inner.append(chars[index])
            index += 1
        }
        search.read = chars.count
        search.closer = nil
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
        at start: Int,
        search: inout CloserSearch
    ) -> BracketRead<(ExternalMarkdownLink, Range<Int>, Range<Int>)> {
        guard chars[start] == "[" else { return .rejected }
        if start + 1 < chars.count, chars[start + 1] == "[" { return .rejected }
        if search.closer == nil, search.read >= chars.count, search.read > start {
            return .noCloser
        }
        if search.rejected, let closer = search.closer, start <= closer {
            return .rejected
        }
        if let closer = search.closer, start > closer {
            search = CloserSearch()
        }
        var index = start + 1
        var shown: [Character] = []
        while index < chars.count, chars[index] != "]" {
            shown.append(chars[index])
            index += 1
        }
        guard index < chars.count, chars[index] == "]" else {
            search.read = chars.count
            search.closer = nil
            search.rejected = false
            return .noCloser
        }
        search.read = index + 1
        search.closer = index
        search.rejected = false
        index += 1
        guard index < chars.count, chars[index] == "(" else {
            search.rejected = true
            return .rejected
        }
        let addressStart = index
        index += 1
        var address: [Character] = []
        while index < chars.count, chars[index] != ")" {
            address.append(chars[index])
            index += 1
        }
        guard index < chars.count, chars[index] == ")" else {
            // The address has no ")". Nothing later in the line can close one either.
            search.read = chars.count
            search.closer = nil
            search.rejected = false
            return .noCloser
        }
        index += 1
        let shownText = trim(String(shown))
        let addr = trim(String(address))
        guard !shownText.isEmpty, !addr.isEmpty else {
            search.rejected = true
            return .rejected
        }
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
        paren: inout CloserSearch
    ) -> (ExternalMention, Range<Int>, Range<Int>?)? {
        guard chars[start] == "@" else { return nil }
        var index = start + 1
        guard let name = readTagGroup(chars, from: &index) else { return nil }
        guard index < chars.count, chars[index] == "(" else {
            return (ExternalMention(name: name, value: nil), start..<index, nil)
        }
        let open = index
        // `read` is the first index this search has not examined. A "(" behind
        // that point already failed to close, so do not walk those characters again.
        if paren.read > open {
            return (ExternalMention(name: name, value: nil), start..<open, nil)
        }
        var cursor = open + 1
        let valueStart = cursor
        while cursor < chars.count {
            if chars[cursor] == ")" {
                paren.read = cursor + 1
                paren.closer = cursor
                let value = String(chars[valueStart..<cursor])
                return (ExternalMention(name: name, value: value), start..<(cursor + 1), open..<(cursor + 1))
            }
            // A mark that starts before any closing parenthesis means this
            // mention has no value. Remember how far the search read so the
            // next opener does not read behind this point.
            if chars[cursor] == "@" || chars[cursor] == "#", !wordBefore(chars, cursor) {
                paren.read = cursor
                paren.closer = nil
                return (ExternalMention(name: name, value: nil), start..<open, nil)
            }
            cursor += 1
        }
        paren.read = chars.count
        paren.closer = nil
        return (ExternalMention(name: name, value: nil), start..<open, nil)
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
        if let ascii = char.asciiValue {
            return (ascii >= 65 && ascii <= 90) || (ascii >= 97 && ascii <= 122) || (ascii >= 48 && ascii <= 57)
        }
        return char.isLetter || char.isNumber
    }

    fileprivate static func isNameChar(_ char: Character) -> Bool {
        if let ascii = char.asciiValue {
            return (ascii >= 65 && ascii <= 90) || (ascii >= 97 && ascii <= 122)
                || (ascii >= 48 && ascii <= 57) || ascii == 95
        }
        return char.isLetter
    }

    /// Emoji may sit inside a tag or a mention, including at the top of a nested tag.
    /// ASCII digits and marks are not emoji here. Trademark, registered, and copyright signs are not either.
    fileprivate static func isTagChar(_ char: Character) -> Bool {
        if isNameChar(char) { return true }
        guard char.asciiValue == nil else { return false }
        for scalar in char.unicodeScalars {
            // Copyright, registered, and trademark signs.
            if scalar.value == 0x00A9 || scalar.value == 0x00AE || scalar.value == 0x2122 {
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
