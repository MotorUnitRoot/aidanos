import Foundation

/// A calendar day in the Gregorian calendar, with no time and no time zone.
public struct CalendarDay: Equatable, Hashable, Sendable, Comparable {
    public let year: Int
    public let month: Int
    public let day: Int

    public init(year: Int, month: Int, day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    /// A real calendar day, or nil when the numbers are not one (31 February, month 13).
    public static func valid(year: Int, month: Int, day: Int) -> CalendarDay? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        var parts = DateComponents()
        parts.year = year
        parts.month = month
        parts.day = day
        parts.hour = 12
        guard let date = calendar.date(from: parts) else { return nil }
        let back = calendar.dateComponents([.year, .month, .day], from: date)
        guard back.year == year, back.month == month, back.day == day else { return nil }
        return CalendarDay(year: year, month: month, day: day)
    }

    public static func < (lhs: CalendarDay, rhs: CalendarDay) -> Bool {
        if lhs.year != rhs.year { return lhs.year < rhs.year }
        if lhs.month != rhs.month { return lhs.month < rhs.month }
        return lhs.day < rhs.day
    }

    /// The calendar day `days` away, in `timeZone`. Noon is used so a daylight-saving shift cannot change the date.
    public func adding(days: Int, timeZone: TimeZone) -> CalendarDay? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let start = Self.noon(self, calendar: calendar),
              let shifted = calendar.date(byAdding: .day, value: days, to: start) else { return nil }
        let parts = calendar.dateComponents([.year, .month, .day], from: shifted)
        guard let year = parts.year, let month = parts.month, let day = parts.day else { return nil }
        return CalendarDay(year: year, month: month, day: day)
    }

    /// Whole calendar days from this day until `later`, in `timeZone`. Negative when `later` is earlier.
    public func daysUntil(_ later: CalendarDay, timeZone: TimeZone) -> Int? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        guard let start = Self.noon(self, calendar: calendar),
              let end = Self.noon(later, calendar: calendar) else { return nil }
        return calendar.dateComponents([.day], from: start, to: end).day
    }

    private static func noon(_ day: CalendarDay, calendar: Calendar) -> Date? {
        var parts = DateComponents()
        parts.year = day.year
        parts.month = day.month
        parts.day = day.day
        parts.hour = 12
        return calendar.date(from: parts)
    }
}

/// Which kind of note a relative path is. This only recognizes names. It does not create files
/// and it does not change `AidanSession.todayPath`.
public enum NotePathKind: Equatable, Sendable {
    /// `log/YYYY-MM-DD.md`, the path `AidanSession.todayPath` writes. Verified in this repo.
    case aidanDay(CalendarDay)
    /// `Calendar/YYYYMMDD.md`, `Calendar/YYYYMMDD.txt`, or the dashed form the importer accepts.
    /// Claimed, from NotePlan documentation.
    case notePlanDay(CalendarDay)
    /// `Calendar/YYYY-Www.md` or `.txt`, for example `2023-W02`. Claimed, from NotePlan documentation.
    case notePlanWeek(year: Int, week: Int)
    /// `Calendar/YYYY-MM.md` or `.txt`. Claimed, from NotePlan documentation.
    case notePlanMonth(year: Int, month: Int)
    /// `Calendar/YYYY-Qq.md` or `.txt`, for example `2023-Q1`. Claimed, from NotePlan documentation.
    case notePlanQuarter(year: Int, quarter: Int)
    /// `Calendar/YYYY.md` or `.txt`. Claimed, from NotePlan documentation.
    case notePlanYear(Int)
    /// Anything else, including an undated file sitting in `Calendar/` and a file whose name is not a real date.
    case ordinary

    /// The day, when this path is a daily note in either layout.
    public var day: CalendarDay? {
        switch self {
        case .aidanDay(let day), .notePlanDay(let day):
            return day
        default:
            return nil
        }
    }
}

/// Read-only names for day notes. See `docs/native/day-note-paths.md`.
public enum NotePaths {
    public static func kind(ofRelativePath path: String) -> NotePathKind {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard !parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) else { return .ordinary }
        if parts.count == 2, parts[0] == "log" {
            if let stem = stem(parts[1], extensions: ["md"]), let day = dashedDay(stem) {
                return .aidanDay(day)
            }
            return .ordinary
        }
        if parts.count == 2, parts[0] == "Calendar" {
            return calendarFile(parts[1])
        }
        return .ordinary
    }

    /// The calendar day of `instant` in `timeZone`. The machine's zone is not consulted.
    public static func calendarDay(on instant: Date, timeZone: TimeZone) -> CalendarDay {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: instant)
        guard let year = parts.year, let month = parts.month, let day = parts.day else {
            return CalendarDay(year: 1970, month: 1, day: 1)
        }
        return CalendarDay(year: year, month: month, day: day)
    }

    private static func calendarFile(_ file: String) -> NotePathKind {
        guard let stem = stem(file, extensions: ["md", "txt"]) else { return .ordinary }
        if let day = compactDay(stem) { return .notePlanDay(day) }
        if let day = dashedDay(stem) { return .notePlanDay(day) }
        if let week = week(stem) { return .notePlanWeek(year: week.year, week: week.week) }
        if let quarter = quarter(stem) { return .notePlanQuarter(year: quarter.year, quarter: quarter.quarter) }
        if let month = month(stem) { return .notePlanMonth(year: month.year, month: month.month) }
        if let year = year(stem) { return .notePlanYear(year) }
        return .ordinary
    }

    private static func stem(_ file: String, extensions: [String]) -> String? {
        guard let dot = file.lastIndex(of: ".") else { return nil }
        let ext = String(file[file.index(after: dot)...])
        guard extensions.contains(ext) else { return nil }
        let stem = String(file[..<dot])
        guard !stem.isEmpty, !stem.contains(".") else { return nil }
        return stem
    }

    private static func compactDay(_ stem: String) -> CalendarDay? {
        let chars = Array(stem)
        guard chars.count == 8, chars.allSatisfy(isDigit) else { return nil }
        guard let year = number(chars[0...3]), let month = number(chars[4...5]), let day = number(chars[6...7]) else {
            return nil
        }
        return CalendarDay.valid(year: year, month: month, day: day)
    }

    private static func dashedDay(_ stem: String) -> CalendarDay? {
        let parts = stem.split(separator: "-", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, parts[0].count == 4, parts[1].count == 2, parts[2].count == 2 else { return nil }
        guard let year = digits(parts[0]), let month = digits(parts[1]), let day = digits(parts[2]) else { return nil }
        return CalendarDay.valid(year: year, month: month, day: day)
    }

    /// `2023-W02`. Claimed, from NotePlan documentation (help article 216 and the x-callback week form).
    private static func week(_ stem: String) -> (year: Int, week: Int)? {
        let chars = Array(stem)
        guard chars.count == 8, chars[4] == "-", chars[5] == "W" || chars[5] == "w" else { return nil }
        guard let year = number(chars[0...3]), let week = number(chars[6...7]), (1...53).contains(week) else { return nil }
        return (year, week)
    }

    /// `2023-Q1`. Claimed, from NotePlan documentation (help article 216).
    private static func quarter(_ stem: String) -> (year: Int, quarter: Int)? {
        let chars = Array(stem)
        guard chars.count == 7, chars[4] == "-", chars[5] == "Q" || chars[5] == "q", isDigit(chars[6]) else { return nil }
        guard let year = number(chars[0...3]), let quarter = number(chars[6...6]), (1...4).contains(quarter) else { return nil }
        return (year, quarter)
    }

    /// `YYYY-MM`. Claimed, from NotePlan documentation (help article 216).
    private static func month(_ stem: String) -> (year: Int, month: Int)? {
        let chars = Array(stem)
        guard chars.count == 7, chars[4] == "-" else { return nil }
        guard let year = number(chars[0...3]), let month = number(chars[5...6]), (1...12).contains(month) else { return nil }
        return (year, month)
    }

    /// `YYYY`. Claimed, from NotePlan documentation (help article 216).
    private static func year(_ stem: String) -> Int? {
        let chars = Array(stem)
        guard chars.count == 4, let year = number(chars[0...3]) else { return nil }
        return year
    }

    private static func isDigit(_ character: Character) -> Bool {
        character >= "0" && character <= "9"
    }

    private static func digits(_ text: String) -> Int? {
        number(Array(text)[...])
    }

    private static func number(_ chars: ArraySlice<Character>) -> Int? {
        guard !chars.isEmpty, chars.allSatisfy(isDigit) else { return nil }
        return Int(String(chars))
    }
}
