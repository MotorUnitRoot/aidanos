import Foundation

/// Edits between two versions of a note, in the indexes of the older version.
public enum TextDiff {
    public struct Edit: Equatable, Sendable {
        public var start: Int
        public var delete: Int
        public var insert: String

        public init(start: Int, delete: Int, insert: String) {
            self.start = start
            self.delete = delete
            self.insert = insert
        }
    }

    /// One change, in the indexes of `old`. `insert` uses the same units as the arrays passed in.
    public struct Span<Element: Equatable>: Equatable {
        public var start: Int
        public var delete: Int
        public var insert: [Element]

        public init(start: Int, delete: Int, insert: [Element]) {
            self.start = start
            self.delete = delete
            self.insert = insert
        }
    }

    /// One splice that turns `old` into `new`. Used when the whole note is being replaced.
    public static func replacement(from old: String, to new: String) -> Edit {
        let left = Array(old.unicodeScalars)
        let right = Array(new.unicodeScalars)
        var prefix = 0
        while prefix < left.count && prefix < right.count && left[prefix] == right[prefix] {
            prefix += 1
        }
        var suffix = 0
        while suffix < left.count - prefix && suffix < right.count - prefix
            && left[left.count - 1 - suffix] == right[right.count - 1 - suffix] {
            suffix += 1
        }
        var insert = ""
        insert.unicodeScalars.append(contentsOf: right[prefix..<(right.count - suffix)])
        return Edit(start: prefix, delete: left.count - prefix - suffix, insert: insert)
    }

    /// Every change from `old` to `new`, in unicode scalars. A keystroke between two remote
    /// edits needs each edit separately; one shared-prefix hunk would swallow both ends.
    public static func hunks(from old: String, to new: String) -> [Edit] {
        let spans = hunks(from: Array(old.unicodeScalars), to: Array(new.unicodeScalars))
        return spans.map { span in
            var insert = ""
            insert.unicodeScalars.append(contentsOf: span.insert)
            return Edit(start: span.start, delete: span.delete, insert: insert)
        }
    }

    public static func hunks<Element: Equatable>(from old: [Element], to new: [Element]) -> [Span<Element>] {
        if old == new { return [] }
        // Myers keeps a trace of every diagonal. Past this size a full rewrite would
        // hold too much, so fall back to a scan that still splits bookend inserts.
        if old.count + new.count <= 8_000, let script = myers(old, new) {
            return script
        }
        return bookends(from: old, to: new)
    }

    /// Moves `edit` so it still hits the same characters after every remote change.
    /// A remote change that ends before the keystroke shifts it. One that ends at the
    /// keystroke stays put, so an append and a keystroke at the same place keep their order.
    /// Later hunks stay in the original indexes: the keystroke's start is not moved
    /// before those comparisons.
    public static func map(_ edit: Edit, through remotes: [Edit]) -> Edit {
        var delta = 0
        for remote in remotes {
            let remoteEnd = remote.start + remote.delete
            if remoteEnd < edit.start {
                delta += remote.insert.unicodeScalars.count - remote.delete
            }
        }
        return Edit(start: edit.start + delta, delete: edit.delete, insert: edit.insert)
    }

    /// Where `index` lands in the new text. An index inside a replaced run lands at the
    /// end of that run's insertion. An index sitting on a change stays in front of it.
    public static func mapIndex<Element>(_ index: Int, through hunks: [Span<Element>], oldCount: Int) -> Int {
        let clamped = min(max(index, 0), max(oldCount, 0))
        var delta = 0
        for hunk in hunks {
            let remoteEnd = hunk.start + hunk.delete
            if remoteEnd < clamped {
                delta += hunk.insert.count - hunk.delete
            } else if clamped > hunk.start {
                return max(0, hunk.start + delta + hunk.insert.count)
            }
        }
        return clamped + delta
    }

    /// Applies `edits`, which describe `base`, onto `text` (which may already have moved on from `base`).
    public static func apply(_ edits: [Edit], to text: String, from base: String) -> String {
        let drift = hunks(from: base, to: text)
        let mapped = edits.map { map($0, through: drift) }
        var scalars = Array(text.unicodeScalars)
        var shift = 0
        for edit in mapped {
            let start = min(max(edit.start + shift, 0), scalars.count)
            let delete = min(max(edit.delete, 0), scalars.count - start)
            let insert = Array(edit.insert.unicodeScalars)
            if delete == 0 && insert.isEmpty { continue }
            scalars.replaceSubrange(start..<(start + delete), with: insert)
            shift += insert.count - delete
        }
        var result = ""
        result.unicodeScalars.append(contentsOf: scalars)
        return result
    }

    private static func bookends<Element: Equatable>(from old: [Element], to new: [Element]) -> [Span<Element>] {
        var prefix = 0
        while prefix < old.count && prefix < new.count && old[prefix] == new[prefix] {
            prefix += 1
        }
        var suffix = 0
        while suffix < old.count - prefix && suffix < new.count - prefix
            && old[old.count - 1 - suffix] == new[new.count - 1 - suffix] {
            suffix += 1
        }
        let oldMid = Array(old[prefix..<(old.count - suffix)])
        let newMid = Array(new[prefix..<(new.count - suffix)])
        if oldMid.isEmpty && newMid.isEmpty { return [] }
        if !oldMid.isEmpty, let at = indexOf(oldMid, in: newMid) {
            var found: [Span<Element>] = []
            if at > 0 {
                found.append(Span(start: prefix, delete: 0, insert: Array(newMid[0..<at])))
            }
            let tail = newMid[(at + oldMid.count)...]
            if !tail.isEmpty {
                found.append(Span(start: prefix + oldMid.count, delete: 0, insert: Array(tail)))
            }
            return found
        }
        if !newMid.isEmpty, let at = indexOf(newMid, in: oldMid) {
            var found: [Span<Element>] = []
            if at > 0 {
                found.append(Span(start: prefix, delete: at, insert: []))
            }
            let tail = oldMid.count - (at + newMid.count)
            if tail > 0 {
                found.append(Span(start: prefix + at + newMid.count, delete: tail, insert: []))
            }
            return found
        }
        return [Span(start: prefix, delete: oldMid.count, insert: newMid)]
    }

    private static func indexOf<Element: Equatable>(_ needle: [Element], in haystack: [Element]) -> Int? {
        if needle.isEmpty || needle.count > haystack.count { return nil }
        let last = haystack.count - needle.count
        var start = 0
        while start <= last {
            var matches = true
            for offset in needle.indices where haystack[start + offset] != needle[offset] {
                matches = false
                break
            }
            if matches { return start }
            start += 1
        }
        return nil
    }

    /// Shortest edit script. Returns nil if the strings are long enough that the search gives up;
    /// callers then use `bookends`.
    private static func myers<Element: Equatable>(_ old: [Element], _ new: [Element]) -> [Span<Element>]? {
        let n = old.count
        let m = new.count
        let max = n + m
        if max == 0 { return [] }
        let offset = max
        var v = [Int](repeating: 0, count: 2 * max + 1)
        var trace: [[Int]] = []
        trace.reserveCapacity(min(max, 64))
        var done = false
        let limit = min(max, 512)
        for d in 0...limit {
            let parity = d
            for k in stride(from: -d, through: d, by: 2) {
                let down = k == -parity || (k != parity && v[offset + k - 1] < v[offset + k + 1])
                var x = down ? v[offset + k + 1] : v[offset + k - 1] + 1
                var y = x - k
                while x < n && y < m && old[x] == new[y] {
                    x += 1
                    y += 1
                }
                v[offset + k] = x
                if x >= n && y >= m {
                    done = true
                    break
                }
            }
            trace.append(v)
            if done { break }
        }
        guard done else { return nil }

        var x = n
        var y = m
        var reversed: [(kind: Int, value: Element)] = []
        for d in stride(from: trace.count - 1, through: 0, by: -1) {
            let snapshot = trace[d]
            let k = x - y
            let down = k == -d || (k != d && snapshot[offset + k - 1] < snapshot[offset + k + 1])
            let prevK = down ? k + 1 : k - 1
            let prevX = snapshot[offset + prevK]
            let prevY = prevX - prevK
            while x > prevX && y > prevY {
                reversed.append((0, old[x - 1]))
                x -= 1
                y -= 1
            }
            if d > 0 {
                if x == prevX {
                    reversed.append((1, new[y - 1]))
                    y -= 1
                } else {
                    reversed.append((2, old[x - 1]))
                    x -= 1
                }
            }
        }

        var hunks: [Span<Element>] = []
        var index = 0
        var hunkStart = 0
        var deleting = 0
        var inserting: [Element] = []
        func flush() {
            if deleting == 0 && inserting.isEmpty { return }
            hunks.append(Span(start: hunkStart, delete: deleting, insert: inserting))
            deleting = 0
            inserting = []
        }
        for step in reversed.reversed() {
            if step.kind == 0 {
                flush()
                index += 1
                hunkStart = index
            } else if step.kind == 1 {
                if deleting == 0 && inserting.isEmpty { hunkStart = index }
                inserting.append(step.value)
            } else {
                if deleting == 0 && inserting.isEmpty { hunkStart = index }
                deleting += 1
                index += 1
            }
        }
        flush()
        return hunks
    }
}
