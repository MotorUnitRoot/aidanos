import Foundation

// NotePlan syntax below is claimed, from NotePlan documentation, and has not been
// checked against a real NotePlan folder. Citations sit on the types that use them.
//
// Tasks: https://help.noteplan.co/article/42-elements-task
//        https://help.noteplan.co/article/109-digital-bullet-journal
//        https://help.noteplan.co/article/46-change-existing-markdown
//        https://help.noteplan.co/article/110-how-to-schedule-tasks
// Dates: https://help.noteplan.co/article/63-part-3-project-notes-and-backlinks
//        https://noteplan.co/changelog/web-2025-01-24
//        https://help.noteplan.co/article/216-how-to-import-notes-from-obsidian
//        https://noteplan.co/plugins/jgclark.EventHelpers (`>YYYY-Wnn`)
// Times: https://help.noteplan.co/article/121-time-blocking
//        https://noteplan.co/changelog/v3.8-checklists-and-new-time-blocking-actions
//        https://noteplan.co/blog/getting-started-with-timeblocking
// Names: https://help.noteplan.co/article/116-nested-tags
//        `@done(...)` is the parenthetical form in the elements-of-a-task article.

/// How a line without a checkbox is read.
/// The caller chooses. There is no hidden default.
public enum PlainMarkerReading: Equatable, Sendable {
    /// Claimed, from NotePlan documentation (bullet journal, and the elements article's `*` row):
    /// a plain `*` is an open task. A plain `-`, `+`, or numbered line is a list item.
    case asteriskIsOpenTask
    /// Claimed, from NotePlan documentation (elements article: recognize `-`, `*`, and `1.` as active tasks).
    /// A plain `+` stays a list item. The theme article's numbered form `1)` is treated like `1.`.
    case plainMarkersAreOpenTasks
}

/// Open, done, cancelled, or scheduled. NotePlan's documentation spells cancelled as "canceled"
/// and calls `[>]` re-scheduled or postponed.
public enum TaskState: Equatable, Hashable, Sendable {
    case open
    case done
    case cancelled
    case scheduled
}

public struct TaskRead: Equatable, Sendable {
    public let state: TaskState
    /// True when the line has no checkbox. A plain `*` is an open task in both readings.
    public let plain: Bool

    public init(state: TaskState, plain: Bool) {
        self.state = state
        self.plain = plain
    }
}

/// A clock time on a 24-hour clock. `2pm` is stored as 14:00. `9:30` with no am/pm stays 9:30.
public struct ClockTime: Equatable, Sendable {
    public let hour: Int
    public let minute: Int

    public init?(hour: Int, minute: Int) {
        guard (0...23).contains(hour), (0...59).contains(minute) else { return nil }
        self.hour = hour
        self.minute = minute
    }
}

public struct NoteTimeMark: Equatable, Sendable {
    /// The time text as it appears on the line, including a range such as `09:00 - 11:00`.
    public let raw: String
    public let start: ClockTime
    public let end: ClockTime?

    public init(raw: String, start: ClockTime, end: ClockTime?) {
        self.raw = raw
        self.start = start
        self.end = end
    }
}

public enum NoteDateKind: Equatable, Sendable {
    /// `>YYYY-MM-DD`. Claimed, from NotePlan documentation.
    case day(CalendarDay)
    /// `>today`. Claimed, from NotePlan documentation. It means the day the caller is asking about.
    case today
    /// `>YYYY-Www`. Claimed, from NotePlan documentation (weekly notes, and `>YYYY-Wnn` in Event Helpers).
    case week(year: Int, week: Int)
    /// `<YYYY-MM-DD`, the link back to the day a task was moved from. Claimed, from NotePlan documentation.
    case sourceDay(CalendarDay)
    /// `>nextweek`. Claimed, from NotePlan documentation (project notes article).
    case nextWeek
    /// `>Friday` and the other weekday names. Claimed, from NotePlan documentation
    /// (the project notes article names `>Friday` and says "and more").
    case weekday(String)
}

public struct NoteDateMark: Equatable, Sendable {
    public let raw: String
    public let kind: NoteDateKind

    public init(raw: String, kind: NoteDateKind) {
        self.raw = raw
        self.kind = kind
    }
}

/// `@name` and the parenthetical form `@done(YYYY-MM-DD)`, including `@done(YYYY-MM-DD hh:mm)`.
public struct NoteMention: Equatable, Sendable {
    public let raw: String
    public let name: String
    /// The text inside parentheses, when the mention has them.
    public let detail: String?

    public init(raw: String, name: String, detail: String?) {
        self.raw = raw
        self.name = name
        self.detail = detail
    }
}

public struct NoteTag: Equatable, Sendable {
    public let raw: String
    public let name: String

    public init(raw: String, name: String) {
        self.raw = raw
        self.name = name
    }
}

public struct NoteWikiLink: Equatable, Sendable {
    public let raw: String
    public let target: String

    public init(raw: String, target: String) {
        self.raw = raw
        self.target = target
    }
}

/// One line, unchanged. `text` is the line exactly as it was read, without the line break.
public struct ParsedLine: Equatable, Sendable {
    public let lineNumber: Int
    public let text: String
    /// 1 through 6 when the line is a Markdown heading. `#tag` is not a heading.
    public let headingLevel: Int?
    public let isListItem: Bool
    /// The bullet as written, such as `*`, `-`, `+`, `1.`, or `1)`.
    public let listMarker: String?
    /// Words after the bullet and checkbox. For any other line, the whole line.
    public let content: String
    public let task: TaskRead?
    /// A bracket mark this reader does not know, such as `[?]`. The line is not given a task state.
    public let unknownMark: String?
    public let dates: [NoteDateMark]
    /// Times, and only on a heading, list item, task, or checklist.
    /// Claimed, from NotePlan documentation: plain text does not count.
    public let times: [NoteTimeMark]
    public let mentions: [NoteMention]
    public let tags: [NoteTag]
    public let wikiLinks: [NoteWikiLink]

    public init(
        lineNumber: Int,
        text: String,
        headingLevel: Int?,
        isListItem: Bool,
        listMarker: String?,
        content: String,
        task: TaskRead?,
        unknownMark: String?,
        dates: [NoteDateMark],
        times: [NoteTimeMark],
        mentions: [NoteMention],
        tags: [NoteTag],
        wikiLinks: [NoteWikiLink]
    ) {
        self.lineNumber = lineNumber
        self.text = text
        self.headingLevel = headingLevel
        self.isListItem = isListItem
        self.listMarker = listMarker
        self.content = content
        self.task = task
        self.unknownMark = unknownMark
        self.dates = dates
        self.times = times
        self.mentions = mentions
        self.tags = tags
        self.wikiLinks = wikiLinks
    }
}

public enum NoteText {
    /// The file's text, or nil when the bytes are not UTF-8. Empty bytes are an empty note.
    public static func decode(_ data: Data) -> String? {
        String(data: data, encoding: .utf8)
    }
}

public enum NoteLines {
    /// The time text this reader writes: zero-padded 24-hour `HH:MM`, such as `09:30` or `14:00`.
    /// Claimed, from NotePlan documentation: the time-blocking article says `14:00` and `15:00` are detected.
    /// This still has to be checked in NotePlan itself before it is used on a real note.
    public static func canonicalTime(_ time: ClockTime) -> String {
        String(format: "%02d:%02d", time.hour, time.minute)
    }

    /// Appends `canonicalTime` at the end of `line` and returns the new line.
    /// The input line is not modified. Nothing is inserted in the middle.
    public static func appendingTime(_ time: ClockTime, to line: String) -> String {
        let token = canonicalTime(time)
        if line.isEmpty { return token }
        if let last = line.last, last == " " || last == "\t" { return line + token }
        return line + " " + token
    }

    public static func parse(line text: String, plainMarkers: PlainMarkerReading, lineNumber: Int = 1) -> ParsedLine {
        let heading = headingLevel(in: text)
        let list = heading == nil ? parseList(text, reading: plainMarkers) : nil
        let dates = scanDates(text)
        let mentions = scanMentions(text)
        let tags = scanTags(text)
        let links = scanWikiLinks(text)
        let qualifies = heading != nil || list != nil
        var blocked: [Range<String.Index>] = []
        blocked.append(contentsOf: dates.ranges)
        blocked.append(contentsOf: mentions.ranges)
        blocked.append(contentsOf: links.ranges)
        let times = qualifies ? scanTimes(text, avoiding: blocked) : []
        return ParsedLine(
            lineNumber: lineNumber,
            text: text,
            headingLevel: heading,
            isListItem: list != nil,
            listMarker: list?.marker,
            content: list?.content ?? text,
            task: list?.task,
            unknownMark: list?.unknownMark,
            dates: dates.values,
            times: times,
            mentions: mentions.values,
            tags: tags,
            wikiLinks: links.values
        )
    }

    public static func parse(note text: String, plainMarkers: PlainMarkerReading) -> [ParsedLine] {
        if text.isEmpty { return [] }
        // Swift treats CRLF as one character, so splitting on "\n" alone leaves the pair intact.
        let normalized = text
            .replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n")
        var parts = normalized.components(separatedBy: "\n")
        if normalized.hasSuffix("\n") {
            parts.removeLast()
        }
        return parts.enumerated().map { index, part in
            parse(line: part, plainMarkers: plainMarkers, lineNumber: index + 1)
        }
    }
}

/// The words used to tell the same task apart across notes.
/// Checkbox, schedule markers, source-day links, and `@done(...)` are not part of the words.
public enum TaskText {
    public static func key(for line: ParsedLine) -> String? {
        guard line.task != nil else { return nil }
        var body = line.content
        var removals = line.dates.map(\.raw)
        for mention in line.mentions where mention.detail != nil && mention.name.lowercased() == "done" {
            removals.append(mention.raw)
        }
        for raw in removals.sorted(by: { $0.count > $1.count }) {
            body = body.replacingOccurrences(of: raw, with: " ")
        }
        let key = body.split(whereSeparator: { $0 == " " || $0 == "\t" }).joined(separator: " ")
        return key.isEmpty ? nil : key
    }
}

// MARK: - Line structure

private struct ListBits {
    var marker: String
    var content: String
    var task: TaskRead?
    var unknownMark: String?
}

private func headingLevel(in text: String) -> Int? {
    var index = text.startIndex
    index = skipIndent(text, from: index)
    var level = 0
    while index < text.endIndex, text[index] == "#" {
        level += 1
        index = text.index(after: index)
    }
    guard (1...6).contains(level), index < text.endIndex else { return nil }
    let mark = text[index]
    guard mark == " " || mark == "\t" else { return nil }
    return level
}

private func parseList(_ text: String, reading: PlainMarkerReading) -> ListBits? {
    var index = skipIndent(text, from: text.startIndex)
    guard index < text.endIndex else { return nil }
    let markerStart = index
    let markerChar = text[index]
    let marker: String
    if markerChar == "*" || markerChar == "-" || markerChar == "+" {
        let next = text.index(after: index)
        if next < text.endIndex, text[next] == markerChar { return nil }
        guard next < text.endIndex, text[next] == " " || text[next] == "\t" else { return nil }
        marker = String(markerChar)
        index = text.index(after: next)
    } else if isDigit(markerChar) {
        var cursor = index
        while cursor < text.endIndex, isDigit(text[cursor]) {
            cursor = text.index(after: cursor)
        }
        guard cursor < text.endIndex, text[cursor] == "." || text[cursor] == ")" else { return nil }
        let afterPunct = text.index(after: cursor)
        guard afterPunct < text.endIndex, text[afterPunct] == " " || text[afterPunct] == "\t" else { return nil }
        marker = String(text[markerStart...cursor])
        index = text.index(after: afterPunct)
    } else {
        return nil
    }

    let rest = text[index...]
    if let checkbox = checkbox(in: rest) {
        return ListBits(marker: marker, content: checkbox.content, task: checkbox.task, unknownMark: checkbox.unknown)
    }
    return ListBits(marker: marker, content: String(rest), task: plainTask(marker: marker, reading: reading), unknownMark: nil)
}

private func checkbox(in rest: Substring) -> (content: String, task: TaskRead?, unknown: String?)? {
    guard rest.first == "[" else { return nil }
    guard let close = rest.firstIndex(of: "]") else { return nil }
    let inside = rest[rest.index(after: rest.startIndex)..<close]
    guard !inside.isEmpty, inside.count <= 8, !inside.contains("[") else { return nil }
    let after = rest[rest.index(after: close)...]
    if let first = after.first, first != " " && first != "\t" { return nil }
    let content = after.first == nil ? "" : String(after.dropFirst())
    let mark = "[" + inside + "]"
    switch inside {
    case " ":
        return (content, TaskRead(state: .open, plain: false), nil)
    case "x", "X":
        // `[x]` is the documented done mark. `[X]` is the same mark.
        return (content, TaskRead(state: .done, plain: false), nil)
    case "-":
        return (content, TaskRead(state: .cancelled, plain: false), nil)
    case ">":
        return (content, TaskRead(state: .scheduled, plain: false), nil)
    default:
        return (content, nil, mark)
    }
}

private func plainTask(marker: String, reading: PlainMarkerReading) -> TaskRead? {
    let numbered = marker.first.map(isDigit) ?? false
    switch reading {
    case .asteriskIsOpenTask:
        return marker == "*" ? TaskRead(state: .open, plain: true) : nil
    case .plainMarkersAreOpenTasks:
        if marker == "*" || marker == "-" || numbered {
            return TaskRead(state: .open, plain: true)
        }
        return nil
    }
}

private func skipIndent(_ text: String, from index: String.Index) -> String.Index {
    var cursor = index
    while cursor < text.endIndex, text[cursor] == " " || text[cursor] == "\t" {
        cursor = text.index(after: cursor)
    }
    return cursor
}

// MARK: - Dates, names, tags, links

private let weekdayNames = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]

private struct Marked<Value> {
    var values: [Value]
    var ranges: [Range<String.Index>]
}

private func scanDates(_ text: String) -> Marked<NoteDateMark> {
    var values: [NoteDateMark] = []
    var ranges: [Range<String.Index>] = []
    var index = text.startIndex
    while index < text.endIndex {
        let mark = text[index]
        if mark == ">" || mark == "<" {
            let next = text.index(after: index)
            if mark == ">", let end = prefixWord(text, at: next, "today") {
                record(&values, &ranges, text, index, end, .today)
                index = end
                continue
            }
            if mark == ">", let end = prefixWord(text, at: next, "nextweek") {
                record(&values, &ranges, text, index, end, .nextWeek)
                index = end
                continue
            }
            if mark == ">", let match = weekday(text, at: next) {
                record(&values, &ranges, text, index, match.end, .weekday(match.name))
                index = match.end
                continue
            }
            if mark == ">", let match = weekToken(text, at: next) {
                record(&values, &ranges, text, index, match.end, .week(year: match.year, week: match.week))
                index = match.end
                continue
            }
            if let match = dayToken(text, at: next) {
                let kind: NoteDateKind = mark == ">" ? .day(match.day) : .sourceDay(match.day)
                record(&values, &ranges, text, index, match.end, kind)
                index = match.end
                continue
            }
        }
        index = text.index(after: index)
    }
    return Marked(values: values, ranges: ranges)
}

private func record(
    _ values: inout [NoteDateMark],
    _ ranges: inout [Range<String.Index>],
    _ text: String,
    _ start: String.Index,
    _ end: String.Index,
    _ kind: NoteDateKind
) {
    values.append(NoteDateMark(raw: String(text[start..<end]), kind: kind))
    ranges.append(start..<end)
}

private func scanMentions(_ text: String) -> Marked<NoteMention> {
    var values: [NoteMention] = []
    var ranges: [Range<String.Index>] = []
    var index = text.startIndex
    while index < text.endIndex {
        if text[index] == "@", wordBoundary(text, index), let name = readName(text, at: text.index(after: index)) {
            var end = name.end
            var detail: String?
            var blocked: Range<String.Index>?
            if end < text.endIndex, text[end] == "(", let close = text[end...].firstIndex(of: ")") {
                let innerStart = text.index(after: end)
                detail = String(text[innerStart..<close])
                end = text.index(after: close)
                blocked = innerStart..<close
            }
            let raw = String(text[index..<end])
            values.append(NoteMention(raw: raw, name: name.text, detail: detail))
            if let blocked {
                ranges.append(blocked)
            }
            index = end
            continue
        }
        index = text.index(after: index)
    }
    return Marked(values: values, ranges: ranges)
}

private func scanTags(_ text: String) -> [NoteTag] {
    var values: [NoteTag] = []
    var index = text.startIndex
    while index < text.endIndex {
        if text[index] == "#", wordBoundary(text, index), let name = readName(text, at: text.index(after: index)) {
            values.append(NoteTag(raw: String(text[index..<name.end]), name: name.text))
            index = name.end
            continue
        }
        index = text.index(after: index)
    }
    return values
}

private func scanWikiLinks(_ text: String) -> Marked<NoteWikiLink> {
    var values: [NoteWikiLink] = []
    var ranges: [Range<String.Index>] = []
    var index = text.startIndex
    while index < text.endIndex {
        let next = text.index(after: index)
        if text[index] == "[", next < text.endIndex, text[next] == "[" {
            let inner = text.index(after: next)
            if let close = text[inner...].range(of: "]]"), close.lowerBound > inner {
                let target = String(text[inner..<close.lowerBound])
                if !target.isEmpty, !target.contains("\n") {
                    let rawEnd = close.upperBound
                    values.append(NoteWikiLink(raw: String(text[index..<rawEnd]), target: target))
                    ranges.append(index..<rawEnd)
                    index = rawEnd
                    continue
                }
            }
        }
        index = text.index(after: index)
    }
    return Marked(values: values, ranges: ranges)
}

private func readName(_ text: String, at start: String.Index) -> (text: String, end: String.Index)? {
    guard start < text.endIndex, isLetter(text[start]) else { return nil }
    var index = text.index(after: start)
    while index < text.endIndex, isNameChar(text[index]) {
        index = text.index(after: index)
    }
    while index < text.endIndex, text[index] == "/" {
        let afterSlash = text.index(after: index)
        guard afterSlash < text.endIndex, isNameChar(text[afterSlash]) else { break }
        index = text.index(after: afterSlash)
        while index < text.endIndex, isNameChar(text[index]) {
            index = text.index(after: index)
        }
    }
    return (String(text[start..<index]), index)
}

// MARK: - Times

private enum Meridiem {
    case am
    case pm
}

private struct RawClock {
    var hour: Int
    var minute: Int
    var meridiem: Meridiem?
    var hasMinutes: Bool
    var end: String.Index
}

private func scanTimes(_ text: String, avoiding blocked: [Range<String.Index>]) -> [NoteTimeMark] {
    var found: [NoteTimeMark] = []
    var index = text.startIndex
    while index < text.endIndex {
        if let skip = blocked.first(where: { $0.contains(index) }) {
            index = skip.upperBound
            continue
        }
        if timeBoundary(text, index), let clock = readRawClock(text, at: index) {
            if let range = readRange(text, after: clock),
               let mark = resolveRange(text, from: index, first: clock, second: range.second),
               !overlaps(index..<range.second.end, blocked) {
                found.append(mark)
                index = range.second.end
                continue
            }
            if let single = resolveClock(clock, inherit: nil), !overlaps(index..<clock.end, blocked) {
                found.append(NoteTimeMark(raw: String(text[index..<clock.end]), start: single, end: nil))
                index = clock.end
                continue
            }
        }
        index = text.index(after: index)
    }
    return found
}

private func readRange(_ text: String, after first: RawClock) -> (second: RawClock, end: String.Index)? {
    var index = skipSpaces(text, from: first.end)
    guard index < text.endIndex, text[index] == "-" else { return nil }
    index = skipSpaces(text, from: text.index(after: index))
    guard let second = readRawClock(text, at: index) else { return nil }
    return (second, second.end)
}

private func resolveRange(_ text: String, from start: String.Index, first: RawClock, second: RawClock) -> NoteTimeMark? {
    let inheritStart: Meridiem? = first.meridiem == nil ? second.meridiem : nil
    guard let startTime = resolveClock(first, inherit: inheritStart),
          let endTime = resolveClock(second, inherit: nil) else { return nil }
    return NoteTimeMark(raw: String(text[start..<second.end]), start: startTime, end: endTime)
}

private func resolveClock(_ raw: RawClock, inherit: Meridiem?) -> ClockTime? {
    let meridiem = raw.meridiem ?? inherit
    if let meridiem {
        guard (1...12).contains(raw.hour) else { return nil }
        let hour: Int
        switch meridiem {
        case .am:
            hour = raw.hour == 12 ? 0 : raw.hour
        case .pm:
            hour = raw.hour == 12 ? 12 : raw.hour + 12
        }
        return ClockTime(hour: hour, minute: raw.minute)
    }
    guard raw.hasMinutes, (0...23).contains(raw.hour) else { return nil }
    return ClockTime(hour: raw.hour, minute: raw.minute)
}

private func readRawClock(_ text: String, at start: String.Index) -> RawClock? {
    guard start < text.endIndex, isDigit(text[start]) else { return nil }
    var index = start
    var count = 0
    while index < text.endIndex, isDigit(text[index]) {
        count += 1
        if count > 2 { return nil }
        index = text.index(after: index)
    }
    guard let hour = Int(text[start..<index]) else { return nil }
    var minute = 0
    var hasMinutes = false
    if index < text.endIndex, text[index] == ":" {
        let minuteStart = text.index(after: index)
        guard let read = readDigits(text, at: minuteStart, count: 2) else { return nil }
        if read.end < text.endIndex, isDigit(text[read.end]) { return nil }
        minute = read.value
        if minute > 59 { return nil }
        hasMinutes = true
        index = read.end
    }
    let beforeMeridiem = index
    let look = skipSpaces(text, from: index)
    var meridiem: Meridiem?
    if let end = prefixWord(text, at: look, "am") {
        meridiem = .am
        index = end
    } else if let end = prefixWord(text, at: look, "pm") {
        meridiem = .pm
        index = end
    }
    if meridiem != nil, !(1...12).contains(hour) {
        meridiem = nil
        index = beforeMeridiem
    }
    return RawClock(hour: hour, minute: minute, meridiem: meridiem, hasMinutes: hasMinutes, end: index)
}

// MARK: - Small scanners

private func dayToken(_ text: String, at start: String.Index) -> (day: CalendarDay, end: String.Index)? {
    guard let year = readDigits(text, at: start, count: 4) else { return nil }
    guard year.end < text.endIndex, text[year.end] == "-" else { return nil }
    let monthStart = text.index(after: year.end)
    guard let month = readDigits(text, at: monthStart, count: 2) else { return nil }
    guard month.end < text.endIndex, text[month.end] == "-" else { return nil }
    let dayStart = text.index(after: month.end)
    guard let day = readDigits(text, at: dayStart, count: 2) else { return nil }
    if day.end < text.endIndex, isDigit(text[day.end]) { return nil }
    guard let date = CalendarDay.valid(year: year.value, month: month.value, day: day.value) else { return nil }
    return (date, day.end)
}

private func weekToken(_ text: String, at start: String.Index) -> (year: Int, week: Int, end: String.Index)? {
    guard let year = readDigits(text, at: start, count: 4) else { return nil }
    guard year.end < text.endIndex, text[year.end] == "-" else { return nil }
    let mark = text.index(after: year.end)
    guard mark < text.endIndex, text[mark] == "W" || text[mark] == "w" else { return nil }
    let weekStart = text.index(after: mark)
    guard let week = readDigits(text, at: weekStart, count: 2), (1...53).contains(week.value) else { return nil }
    if week.end < text.endIndex, isDigit(text[week.end]) { return nil }
    return (year.value, week.value, week.end)
}

private func weekday(_ text: String, at start: String.Index) -> (name: String, end: String.Index)? {
    for name in weekdayNames {
        if let end = prefixWord(text, at: start, name) {
            return (name, end)
        }
    }
    return nil
}

private func prefixWord(_ text: String, at start: String.Index, _ word: String) -> String.Index? {
    var index = start
    for character in word {
        guard index < text.endIndex else { return nil }
        if String(text[index]).lowercased() != String(character) { return nil }
        index = text.index(after: index)
    }
    if index < text.endIndex, isLetter(text[index]) || isDigit(text[index]) { return nil }
    return index
}

private func readDigits(_ text: String, at start: String.Index, count: Int) -> (value: Int, end: String.Index)? {
    var index = start
    var raw = ""
    for _ in 0..<count {
        guard index < text.endIndex, isDigit(text[index]) else { return nil }
        raw.append(text[index])
        index = text.index(after: index)
    }
    guard let value = Int(raw) else { return nil }
    return (value, index)
}

private func skipSpaces(_ text: String, from index: String.Index) -> String.Index {
    var cursor = index
    while cursor < text.endIndex, text[cursor] == " " {
        cursor = text.index(after: cursor)
    }
    return cursor
}

private func timeBoundary(_ text: String, _ index: String.Index) -> Bool {
    guard index > text.startIndex else { return true }
    let previous = text[text.index(before: index)]
    return !isLetter(previous) && !isDigit(previous)
}

private func wordBoundary(_ text: String, _ index: String.Index) -> Bool {
    guard index > text.startIndex else { return true }
    return !isNameChar(text[text.index(before: index)])
}

private func overlaps(_ range: Range<String.Index>, _ blocked: [Range<String.Index>]) -> Bool {
    blocked.contains { range.lowerBound < $0.upperBound && $0.lowerBound < range.upperBound }
}

private func isDigit(_ character: Character) -> Bool {
    character >= "0" && character <= "9"
}

private func isLetter(_ character: Character) -> Bool {
    (character >= "a" && character <= "z") || (character >= "A" && character <= "Z")
}

private func isNameChar(_ character: Character) -> Bool {
    isLetter(character) || isDigit(character) || character == "_"
}
