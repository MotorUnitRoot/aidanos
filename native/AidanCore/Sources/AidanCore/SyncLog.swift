import Automerge
import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Timestamped sync lines. They go to stderr so a test log can quote them.
enum SyncLog {
    static func write(_ message: String, at date: Date = Date()) {
        let line = format(message, at: date)
        line.withCString { pointer in
            _ = fputs(pointer, stderr)
        }
    }

    static func format(_ message: String, at date: Date = Date()) -> String {
        stamp(date) + " " + message + "\n"
    }

    static func heads(_ set: Set<ChangeHash>) -> String {
        set.map(\.debugDescription).sorted().joined(separator: ",")
    }

    private static func stamp(_ date: Date) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0) ?? calendar.timeZone
        let parts = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second, .nanosecond], from: date)
        let millis = (parts.nanosecond ?? 0) / 1_000_000
        return String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d.%03dZ",
            parts.year ?? 0,
            parts.month ?? 0,
            parts.day ?? 0,
            parts.hour ?? 0,
            parts.minute ?? 0,
            parts.second ?? 0,
            millis
        )
    }
}
