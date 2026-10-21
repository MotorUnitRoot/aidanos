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

    /// Moves `edit` so it still hits the same characters after `remote` has already been applied.
    /// A remote change that ends before the keystroke shifts it. A remote change at the keystroke stays put,
    /// so an append and a keystroke at the same place keep their existing order.
    static func map(_ edit: Edit, through remote: Edit) -> Edit {
        let remoteEnd = remote.start + remote.delete
        if remoteEnd < edit.start {
            let delta = Array(remote.insert.unicodeScalars).count - remote.delete
            return Edit(start: edit.start + delta, delete: edit.delete, insert: edit.insert)
        }
        return edit
    }

    static func apply(_ edit: Edit, to text: String) -> String {
        var scalars = Array(text.unicodeScalars)
        let start = min(max(edit.start, 0), scalars.count)
        let delete = min(max(edit.delete, 0), scalars.count - start)
        if delete == 0 && edit.insert.isEmpty { return text }
        scalars.replaceSubrange(start..<(start + delete), with: edit.insert.unicodeScalars)
        var result = ""
        result.unicodeScalars.append(contentsOf: scalars)
        return result
    }
}
