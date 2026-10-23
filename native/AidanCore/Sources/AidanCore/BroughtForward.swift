import Foundation

/// Which brought-forward list to build. The caller passes one. There is no default.
///
/// Both modes use the same rules:
/// 1. Only day notes from the last 30 calendar days before today, in the time zone passed in.
///    The day 30 days before today is included. Today is not. A note older than that stays in
///    the set for move marks and for "done in another note", but its open tasks are not listed.
/// 2. A ticked or cancelled line is not listed. The same task text ticked or cancelled in any
///    note, including a project note, is not listed either.
/// 3. An open task whose `>YYYY-MM-DD` is after today is not listed. It belongs on that later day.
///    `>today` and a date on or before today are not "after today".
/// 4. Nothing here rewrites a note. Each item carries the source path, the 1-based line number,
///    and the line's exact text, so a later tick can find that line and change only it.
/// 5. Move count = calendar days from the shown day note to today, plus each NotePlan `[>]`
///    line with the same task text on a day note earlier than that day. Marks older than 30 days
///    still count. The words "moved twice" on a screen are for a count of 2. This number is the formula.
/// 6. The same task text on several day notes is returned once, from the newest of those day notes.
///
/// `everyOpenTaskFromEarlierDays` returns every open task that survives those rules.
/// A task he never marked `[>]` is included. Its count is just how many days it has waited.
///
/// `onlyTasksMovedForward` uses the same rules, then keeps a task only when rule 5 found at
/// least one earlier `[>]` mark. Waiting alone does not put it on this list.
///
/// Project tasks are separate from the mode and from the 30-day window: an open task in a note
/// that is not a daily note, with `>YYYY-MM-DD` equal to today or with `>today`.
public enum BroughtForwardMode: Equatable, Sendable {
    case everyOpenTaskFromEarlierDays
    case onlyTasksMovedForward
}

/// A line a later tick can find again. `text` is the original line, not a rewritten one.
public struct SourceLine: Equatable, Sendable {
    public let path: String
    public let lineNumber: Int
    public let text: String

    public init(path: String, lineNumber: Int, text: String) {
        self.path = path
        self.lineNumber = lineNumber
        self.text = text
    }

    public func matches(note: ReadNote) -> Bool {
        guard note.path == path, lineNumber >= 1, lineNumber <= note.lines.count else { return false }
        return note.lines[lineNumber - 1].text == text
    }
}

public struct BroughtForwardTask: Equatable, Sendable {
    public let source: SourceLine
    public let sourceDay: CalendarDay
    public let moveCount: Int
    public let line: ParsedLine

    public init(source: SourceLine, sourceDay: CalendarDay, moveCount: Int, line: ParsedLine) {
        self.source = source
        self.sourceDay = sourceDay
        self.moveCount = moveCount
        self.line = line
    }
}

public struct BroughtForwardGroup: Equatable, Sendable {
    public let sourceDay: CalendarDay
    /// Tasks from that day, in line order.
    public let tasks: [BroughtForwardTask]

    public init(sourceDay: CalendarDay, tasks: [BroughtForwardTask]) {
        self.sourceDay = sourceDay
        self.tasks = tasks
    }
}

public struct ProjectTaskDue: Equatable, Sendable {
    public let source: SourceLine
    public let line: ParsedLine

    public init(source: SourceLine, line: ParsedLine) {
        self.source = source
        self.line = line
    }
}

public struct BroughtForwardResult: Equatable, Sendable {
    public let mode: BroughtForwardMode
    public let today: CalendarDay
    /// Newest source day first.
    public let groups: [BroughtForwardGroup]
    public let projectTasksDueToday: [ProjectTaskDue]

    public init(
        mode: BroughtForwardMode,
        today: CalendarDay,
        groups: [BroughtForwardGroup],
        projectTasksDueToday: [ProjectTaskDue]
    ) {
        self.mode = mode
        self.today = today
        self.groups = groups
        self.projectTasksDueToday = projectTasksDueToday
    }
}

public struct ReadNote: Equatable, Sendable {
    public let path: String
    public let text: String
    public let lines: [ParsedLine]
    public let pathKind: NotePathKind

    public init(path: String, text: String, plainMarkers: PlainMarkerReading) {
        self.path = path
        self.text = text
        self.lines = NoteLines.parse(note: text, plainMarkers: plainMarkers)
        self.pathKind = NotePaths.kind(ofRelativePath: path)
    }
}

public enum BroughtForward {
    /// Day notes this many calendar days before today still contribute. Today does not.
    public static let lookbackDays = 30

    public static func tasks(
        in notes: [ReadNote],
        on instant: Date,
        timeZone: TimeZone,
        mode: BroughtForwardMode
    ) -> BroughtForwardResult {
        let today = NotePaths.calendarDay(on: instant, timeZone: timeZone)
        let windowStart = today.adding(days: -lookbackDays, timeZone: timeZone) ?? today
        let blocked = blockedKeys(in: notes)
        var newest: [String: (note: ReadNote, line: ParsedLine, day: CalendarDay)] = [:]
        for note in notes {
            guard let day = note.pathKind.day, day >= windowStart, day < today else { continue }
            for line in note.lines {
                guard line.task?.state == .open, let key = TaskText.key(for: line) else { continue }
                if blocked.contains(key) || scheduledAfter(today, line) { continue }
                if let existing = newest[key], existing.day >= day { continue }
                newest[key] = (note, line, day)
            }
        }

        var grouped: [CalendarDay: [BroughtForwardTask]] = [:]
        for (key, item) in newest {
            let marks = earlierMoveMarks(key, before: item.day, in: notes)
            if mode == .onlyTasksMovedForward, marks < 1 { continue }
            let days = item.day.daysUntil(today, timeZone: timeZone) ?? 0
            let task = BroughtForwardTask(
                source: SourceLine(path: item.note.path, lineNumber: item.line.lineNumber, text: item.line.text),
                sourceDay: item.day,
                moveCount: days + marks,
                line: item.line
            )
            grouped[item.day, default: []].append(task)
        }

        let groups = grouped.keys.sorted(by: >).map { day in
            let tasks = grouped[day]!.sorted { lhs, rhs in
                if lhs.source.path != rhs.source.path { return lhs.source.path < rhs.source.path }
                return lhs.source.lineNumber < rhs.source.lineNumber
            }
            return BroughtForwardGroup(sourceDay: day, tasks: tasks)
        }
        return BroughtForwardResult(
            mode: mode,
            today: today,
            groups: groups,
            projectTasksDueToday: projectTasks(in: notes, today: today)
        )
    }

    private static func blockedKeys(in notes: [ReadNote]) -> Set<String> {
        var blocked: Set<String> = []
        for note in notes {
            for line in note.lines {
                guard let state = line.task?.state, state == .done || state == .cancelled else { continue }
                if let key = TaskText.key(for: line) {
                    blocked.insert(key)
                }
            }
        }
        return blocked
    }

    private static func scheduledAfter(_ today: CalendarDay, _ line: ParsedLine) -> Bool {
        line.dates.contains { mark in
            if case .day(let day) = mark.kind { return day > today }
            return false
        }
    }

    private static func earlierMoveMarks(_ key: String, before day: CalendarDay, in notes: [ReadNote]) -> Int {
        var count = 0
        for note in notes {
            guard let noteDay = note.pathKind.day, noteDay < day else { continue }
            for line in note.lines {
                guard line.task?.state == .scheduled, TaskText.key(for: line) == key else { continue }
                count += 1
            }
        }
        return count
    }

    private static func projectTasks(in notes: [ReadNote], today: CalendarDay) -> [ProjectTaskDue] {
        var found: [ProjectTaskDue] = []
        for note in notes where note.pathKind.day == nil {
            for line in note.lines {
                guard line.task?.state == .open, due(today, line) else { continue }
                found.append(ProjectTaskDue(
                    source: SourceLine(path: note.path, lineNumber: line.lineNumber, text: line.text),
                    line: line
                ))
            }
        }
        return found.sorted { lhs, rhs in
            if lhs.source.path != rhs.source.path { return lhs.source.path < rhs.source.path }
            return lhs.source.lineNumber < rhs.source.lineNumber
        }
    }

    private static func due(_ today: CalendarDay, _ line: ParsedLine) -> Bool {
        line.dates.contains { mark in
            switch mark.kind {
            case .today:
                return true
            case .day(let day):
                return day == today
            default:
                return false
            }
        }
    }
}
