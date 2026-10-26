import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

enum AtomicFile {
    /// Swap-in: a reader never sees a half-written file. Do not use this for a
    /// note that lives inside a NotePlan folder. See `NoteFolderSave`.
    /// `beforeRename` runs after the temp file is ready and before the rename.
    /// A throw leaves the destination untouched and removes the temp file.
    static func write(_ data: Data, to url: URL, beforeRename: (() throws -> Void)? = nil) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if NoteFolderSave.isSymbolicLink(url.path) {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        do {
            try data.write(to: temporary)
            let descriptor = temporary.path.withCString { open($0, O_RDONLY) }
            if descriptor >= 0 {
                _ = fsync(descriptor)
                _ = close(descriptor)
            }
            try beforeRename?()
            if NoteFolderSave.isSymbolicLink(url.path) {
                throw AidanError.io("Could not save \(url.lastPathComponent).")
            }
            let renamed = temporary.path.withCString { source in
                url.path.withCString { destination in
                    rename(source, destination)
                }
            }
            if renamed != 0 {
                throw AidanError.io("Could not finish saving \(url.lastPathComponent).")
            }
        } catch {
            try? FileManager.default.removeItem(at: temporary)
            throw error
        }
    }
}

public enum NoteSaveStyle: Equatable, Sendable {
    case inPlace
    case swapIn
}

    /// Notes inside a NotePlan vault are saved in place. The vault is recognized
    /// from the real path: a path part starting with "iCloud~co~noteplan~" or
    /// "co.noteplan.", in any letter case. A folder merely named NotePlan is not
    /// one. AIDANOS_VAULT_KIND=noteplan forces the same in-place save. A caller
    /// cannot choose swap-in there. Other folders may swap in.
    ///
    /// An in-place save compares the opened descriptor with the file seen
    /// before the open, then checks every directory recorded from the vault
    /// root down, before the first new byte. A file this call just created is
    /// removed when that check fails, once its dev+ino still matches the
    /// descriptor. The previous bytes are written to a recovery file in the
    /// same folder, created with O_EXCL. A failed write or truncate puts those
    /// bytes back and removes the recovery file. If the restore itself fails,
    /// the recovery file stays and its vault-relative name is logged.
public enum NoteFolderSave {
    private static let prefixes = ["icloud~co~noteplan~", "co.noteplan."]

    public static func isNotePlanFolder(_ url: URL) -> Bool {
        resolvedPath(url).split(separator: "/").contains { part in
            let name = part.lowercased()
            return prefixes.contains { name.hasPrefix($0) }
        }
    }

    public static func style(for url: URL, swapInRequested: Bool) -> NoteSaveStyle {
        if isNotePlanFolder(url) || vaultKindForcesInPlace() { return .inPlace }
        return swapInRequested ? .swapIn : .inPlace
    }

    public static func swapInRequested() -> Bool {
        let raw = env("AIDANOS_SAVE_SWAP_IN")
        if raw == "0" || raw == "false" || raw == "no" { return false }
        if raw == "1" || raw == "true" || raw == "yes" { return true }
        return true
    }

    public static func vaultKindForcesInPlace() -> Bool {
        env("AIDANOS_VAULT_KIND") == "noteplan"
    }

    public static func write(_ data: Data, to url: URL, beforeRename: (() throws -> Void)? = nil) throws {
        try write(data, to: url, parents: [], beforeRename: beforeRename)
    }

    static func write(
        _ data: Data,
        to url: URL,
        parents: [DirectoryIdentity],
        vaultRoot: URL? = nil,
        beforeRename: (() throws -> Void)? = nil
    ) throws {
        let name = url.lastPathComponent
        if !parents.isEmpty {
            try assertParents(parents, name)
        }
        switch style(for: url, swapInRequested: swapInRequested()) {
        case .inPlace:
            try writeInPlace(data, to: url, parents: parents, vaultRoot: vaultRoot)
        case .swapIn:
            try AtomicFile.write(data, to: url, beforeRename: {
                if !parents.isEmpty {
                    try assertParents(parents, name)
                }
                try beforeRename?()
            })
        }
    }

    struct DirectoryIdentity {
        let path: String
        let dev: dev_t
        let ino: ino_t
    }

    static var logRestoreFailure: (String) -> Void = { name in
        fputs("restore failed: \(name)\n", stderr)
    }

    static func writeInPlace(
        _ data: Data,
        to url: URL,
        beforeOpen: (() -> Void)? = nil,
        beforeWrite: (() throws -> Void)? = nil,
        afterOpen: (() -> Void)? = nil,
        failAfterBytes: Int? = nil,
        failRestore: (() throws -> Void)? = nil,
        parents: [DirectoryIdentity] = [],
        vaultRoot: URL? = nil
    ) throws {
        let name = url.lastPathComponent
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let chain = parents.isEmpty ? [try directoryIdentity(directory.path, name)] : parents
        let before = try identity(url.path)
        if let before, before.isLink || !before.isRegular {
            throw AidanError.io("Could not save \(name).")
        }
        beforeOpen?()
        // O_RDWR so a failed write can read the previous bytes back onto the
        // same descriptor. An existing note is not created: a swapped parent
        // must not receive a new file.
        let creating = before == nil
        let flags: Int32 = O_RDWR | O_NOFOLLOW | O_NONBLOCK | (creating ? (O_CREAT | O_EXCL) : 0)
        let fd = url.path.withCString { open($0, flags, mode_t(0o644)) }
        if fd < 0 {
            throw AidanError.io("Could not save \(name).")
        }
        defer { _ = close(fd) }
        var opened = stat()
        if fstat(fd, &opened) != 0 {
            throw AidanError.io("Could not save \(name).")
        }
        if let before {
            if opened.st_dev != before.dev || opened.st_ino != before.ino {
                throw AidanError.io("Could not save \(name).")
            }
        }
        if (opened.st_mode & S_IFMT) != S_IFREG || opened.st_nlink > 1 {
            throw AidanError.io("Could not save \(name).")
        }
        do {
            afterOpen?()
            try assertParents(chain, name)
        } catch {
            if creating { unlinkIfSame(url.path, fd) }
            throw error
        }
        let previous = before == nil ? Data() : try readAll(fd, Int(opened.st_size), name)
        let recovery = try writeRecovery(previous, nextTo: url, name: name)
        do {
            try beforeWrite?()
            if let failAfterBytes {
                let count = min(max(failAfterBytes, 0), data.count)
                if count > 0 {
                    try writeAll(fd, Data(data.prefix(count)), name)
                }
                throw AidanError.io("Could not save \(name).")
            }
            try writeAll(fd, data, name)
            if ftruncate(fd, off_t(data.count)) != 0 {
                throw AidanError.io("Could not save \(name).")
            }
        } catch let writeError {
            do {
                try failRestore?()
                try restore(fd, previous, name)
                unlinkIfSame(recovery.url.path, recovery.dev, recovery.ino)
            } catch {
                logRestoreFailure(recoveryRelativeName(vaultRoot: vaultRoot, file: recovery.url))
                throw writeError
            }
            throw writeError
        }
        if fsync(fd) != 0 {
            throw AidanError.io("Could not save \(name).")
        }
        unlinkIfSame(recovery.url.path, recovery.dev, recovery.ino)
    }

    static func isSymbolicLink(_ path: String) -> Bool {
        (try? identity(path))?.isLink == true
    }

    private struct FileIdentity {
        let dev: dev_t
        let ino: ino_t
        let isLink: Bool
        let isRegular: Bool
    }

    private struct RecoveryFile {
        let url: URL
        let dev: dev_t
        let ino: ino_t
    }

    static func directoryIdentity(_ path: String, _ name: String) throws -> DirectoryIdentity {
        var info = stat()
        if lstat(path, &info) != 0 || (info.st_mode & S_IFMT) != S_IFDIR {
            throw AidanError.io("Could not save \(name).")
        }
        return DirectoryIdentity(path: path, dev: info.st_dev, ino: info.st_ino)
    }

    private static func assertParents(_ parents: [DirectoryIdentity], _ name: String) throws {
        for parent in parents {
            var info = stat()
            if lstat(parent.path, &info) != 0
                || (info.st_mode & S_IFMT) != S_IFDIR
                || info.st_dev != parent.dev
                || info.st_ino != parent.ino {
                throw AidanError.io("Could not save \(name).")
            }
        }
    }

    private static func unlinkIfSame(_ path: String, _ fd: Int32) {
        var opened = stat()
        if fstat(fd, &opened) != 0 { return }
        unlinkIfSame(path, opened.st_dev, opened.st_ino)
    }

    private static func unlinkIfSame(_ path: String, _ dev: dev_t, _ ino: ino_t) {
        var listed = stat()
        if lstat(path, &listed) != 0 { return }
        if (listed.st_mode & S_IFMT) == S_IFLNK { return }
        if listed.st_dev != dev || listed.st_ino != ino { return }
        _ = path.withCString { unlink($0) }
    }

    private static func writeRecovery(_ previous: Data, nextTo url: URL, name: String) throws -> RecoveryFile {
        let recovery = url.deletingLastPathComponent()
            .appendingPathComponent("\(url.lastPathComponent).\(UUID().uuidString).recover")
        let fd = recovery.path.withCString { open($0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode_t(0o644)) }
        if fd < 0 {
            throw AidanError.io("Could not save \(name).")
        }
        defer { _ = close(fd) }
        var opened = stat()
        if fstat(fd, &opened) != 0 {
            throw AidanError.io("Could not save \(name).")
        }
        do {
            try writeAll(fd, previous, name)
            if fsync(fd) != 0 {
                throw AidanError.io("Could not save \(name).")
            }
        } catch {
            unlinkIfSame(recovery.path, fd)
            throw error
        }
        return RecoveryFile(url: recovery, dev: opened.st_dev, ino: opened.st_ino)
    }

    private static func recoveryRelativeName(vaultRoot: URL?, file: URL) -> String {
        guard let root = vaultRoot?.standardizedFileURL.path, !root.isEmpty else {
            return file.lastPathComponent
        }
        let prefix = root.hasSuffix("/") ? root : root + "/"
        if file.path.hasPrefix(prefix) {
            return String(file.path.dropFirst(prefix.count))
        }
        return file.lastPathComponent
    }

    private static func readAll(_ fd: Int32, _ count: Int, _ name: String) throws -> Data {
        if count == 0 { return Data() }
        var data = Data(count: count)
        var offset = 0
        try data.withUnsafeMutableBytes { raw in
            guard let base = raw.baseAddress else {
                throw AidanError.io("Could not save \(name).")
            }
            while offset < count {
                let got = pread(fd, base.advanced(by: offset), count - offset, off_t(offset))
                if got < 0 {
                    if errno == EINTR { continue }
                    throw AidanError.io("Could not save \(name).")
                }
                if got == 0 { break }
                offset += Int(got)
            }
        }
        if offset != count {
            throw AidanError.io("Could not save \(name).")
        }
        return data
    }

    private static func restore(_ fd: Int32, _ previous: Data, _ name: String) throws {
        try writeAll(fd, previous, name)
        if ftruncate(fd, off_t(previous.count)) != 0 {
            throw AidanError.io("Could not save \(name).")
        }
    }

    private static func identity(_ path: String) throws -> FileIdentity? {
        var info = stat()
        if lstat(path, &info) != 0 {
            if errno == ENOENT { return nil }
            throw AidanError.io("Could not save \(URL(fileURLWithPath: path).lastPathComponent).")
        }
        return FileIdentity(
            dev: info.st_dev,
            ino: info.st_ino,
            isLink: (info.st_mode & S_IFMT) == S_IFLNK,
            isRegular: (info.st_mode & S_IFMT) == S_IFREG
        )
    }

    private static func writeAll(_ fd: Int32, _ data: Data, _ name: String) throws {
        var offset = 0
        let total = data.count
        try data.withUnsafeBytes { raw in
            if total == 0 { return }
            guard let base = raw.baseAddress else {
                throw AidanError.io("Could not save \(name).")
            }
            while offset < total {
                let wrote = pwrite(fd, base.advanced(by: offset), total - offset, off_t(offset))
                if wrote < 0 {
                    if errno == EINTR { continue }
                    throw AidanError.io("Could not save \(name).")
                }
                if wrote == 0 {
                    throw AidanError.io("Could not save \(name).")
                }
                offset += Int(wrote)
            }
        }
    }

    private static func env(_ name: String) -> String {
        guard let raw = getenv(name) else { return "" }
        return String(cString: raw)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
    }

    private static func resolvedPath(_ url: URL) -> String {
        var cursor = url.standardizedFileURL.path
        var pending: [String] = []
        while true {
            if let real = realPath(cursor) {
                return pending.reversed().reduce(real) { $0 + "/" + $1 }
            }
            let parent = (cursor as NSString).deletingLastPathComponent
            if parent == cursor || parent.isEmpty {
                return url.standardizedFileURL.path
            }
            pending.append((cursor as NSString).lastPathComponent)
            cursor = parent
        }
    }

    private static func realPath(_ path: String) -> String? {
        path.withCString { cString in
            guard let resolved = realpath(cString, nil) else { return nil }
            defer { free(resolved) }
            return String(cString: resolved)
        }
    }
}

enum VaultPaths {
    static func check(_ path: String) throws -> String {
        if path.hasPrefix("/") || path.hasPrefix("\\") || path.contains("\\") || path.contains("\0") {
            throw AidanError.badPath(path)
        }
        if !path.hasSuffix(".md") {
            throw AidanError.badPath(path)
        }
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.isEmpty || parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." || $0.hasPrefix(".") }) {
            throw AidanError.badPath(path)
        }
        return parts.joined(separator: "/")
    }

    struct LocatedFile {
        let url: URL
        let parents: [NoteFolderSave.DirectoryIdentity]
    }

    /// The file inside the vault. A symlink anywhere along the path is refused.
    /// Each directory from the vault root down is recorded by dev+ino so the
    /// save can check the same folders after it opens the note.
    static func locate(vault: URL, path: String) throws -> LocatedFile {
        let safe = try check(path)
        let root = URL(fileURLWithPath: vault.path).standardizedFileURL.path
        var parents = [try NoteFolderSave.directoryIdentity(root, safe)]
        var current = root
        let parts = safe.split(separator: "/").map(String.init)
        for (index, part) in parts.enumerated() {
            current = URL(fileURLWithPath: current).appendingPathComponent(part).path
            if isSymbolicLink(current) {
                throw AidanError.badPath(path)
            }
            let isLast = index == parts.count - 1
            var isDirectory: ObjCBool = false
            let exists = FileManager.default.fileExists(atPath: current, isDirectory: &isDirectory)
            if exists && !isLast && !isDirectory.boolValue {
                throw AidanError.badPath(path)
            }
            if !exists && !isLast {
                try FileManager.default.createDirectory(atPath: current, withIntermediateDirectories: false)
            }
            if !isLast {
                parents.append(try NoteFolderSave.directoryIdentity(current, safe))
            }
        }
        let target = URL(fileURLWithPath: current).standardizedFileURL.path
        if target != root && !target.hasPrefix(root.hasSuffix("/") ? root : root + "/") {
            throw AidanError.badPath(path)
        }
        return LocatedFile(url: URL(fileURLWithPath: current), parents: parents)
    }

    static func fileURL(vault: URL, path: String) throws -> URL {
        try locate(vault: vault, path: path).url
    }

    private static func isSymbolicLink(_ path: String) -> Bool {
        var info = stat()
        if lstat(path, &info) != 0 { return false }
        return (info.st_mode & S_IFMT) == S_IFLNK
    }

    static func markdownFiles(in vault: URL) throws -> [String] {
        var found: [String] = []
        func walk(_ directory: URL, prefix: String) throws {
            let items = try FileManager.default.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: nil
            )
            for item in items {
                let name = item.lastPathComponent
                if name.hasPrefix(".") { continue }
                let relative = prefix.isEmpty ? name : prefix + "/" + name
                var isDirectory: ObjCBool = false
                if FileManager.default.fileExists(atPath: item.path, isDirectory: &isDirectory), isDirectory.boolValue {
                    try walk(item, prefix: relative)
                } else if name.lowercased().hasSuffix(".md") {
                    found.append(relative)
                }
            }
        }
        if FileManager.default.fileExists(atPath: vault.path) {
            try walk(vault, prefix: "")
        }
        return found.sorted()
    }
}
