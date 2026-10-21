import Foundation

enum TextDiff {
    struct Edit: Equatable {
        var start: Int
        var delete: Int
        var insert: String
    }

    /// Shared start, shared end, and the middle that changed. Applying it turns `old` into `new`.
    static func diff(from old: String, to new: String) -> Edit {
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
        let delete = left.count - prefix - suffix
        var insert = ""
        insert.unicodeScalars.append(contentsOf: right[prefix..<(right.count - suffix)])
        return Edit(start: prefix, delete: delete, insert: insert)
    }
}
