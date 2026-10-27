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

    static var logSyncFailure: (String) -> Void = { name in
        fputs("sync failed: \(name)\n", stderr)
    }

    static func writeInPlace(
        _ data: Data,
        to url: URL,
        beforeOpen: (() -> Void)? = nil,
        beforeWrite: (() throws -> Void)? = nil,
        afterOpen: (() -> Void)? = nil,
        afterRecovery: (() -> Void)? = nil,
        failAfterBytes: Int? = nil,
        failRestore: (() throws -> Void)? = nil,
        failSync: Bool = false,
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
            if creating { removeCreatedFile(fd) }
            throw error
        }
        let folder = try openCheckedDirectory(chain, name)
        defer { _ = close(folder) }
        let previous = before == nil ? Data() : try readAll(fd, Int(opened.st_size), name)
        let recovery = try writeRecovery(previous, dirfd: folder, noteName: name)
        let recoveryURL = directory.appendingPathComponent(recovery.name)
        afterRecovery?()
        let same = entryMatches(folder, recovery.name, recovery.dev, recovery.ino)
        let folders = parentsMatch(chain)
        if !same || !folders {
            _ = unlinkAtIfSame(folder, recovery.name, recovery.dev, recovery.ino)
            throw AidanError.io("Could not save \(name).")
        }
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
                _ = unlinkAtIfSame(folder, recovery.name, recovery.dev, recovery.ino)
            } catch {
                logRestoreFailure(recoveryRelativeName(vaultRoot: vaultRoot, file: recoveryURL))
                throw writeError
            }
            throw writeError
        }
        do {
            if failSync {
                throw AidanError.io("Could not save \(name).")
            }
            if fsync(fd) != 0 {
                throw AidanError.io("Could not save \(name).")
            }
        } catch {
            logSyncFailure(recoveryRelativeName(vaultRoot: vaultRoot, file: recoveryURL))
            throw error
        }
        _ = unlinkAtIfSame(folder, recovery.name, recovery.dev, recovery.ino)
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
        let name: String
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
        if !parentsMatch(parents) {
            throw AidanError.io("Could not save \(name).")
        }
    }

    private static func parentsMatch(_ parents: [DirectoryIdentity]) -> Bool {
        for parent in parents {
            var info = stat()
            if lstat(parent.path, &info) != 0
                || (info.st_mode & S_IFMT) != S_IFDIR
                || info.st_dev != parent.dev
                || info.st_ino != parent.ino {
                return false
            }
        }
        return true
    }

    private static func openCheckedDirectory(_ chain: [DirectoryIdentity], _ name: String) throws -> Int32 {
        guard let parent = chain.last else {
            throw AidanError.io("Could not save \(name).")
        }
        let fd = parent.path.withCString { open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, mode_t(0)) }
        if fd < 0 {
            throw AidanError.io("Could not save \(name).")
        }
        var info = stat()
        if fstat(fd, &info) != 0
            || (info.st_mode & S_IFMT) != S_IFDIR
            || info.st_dev != parent.dev
            || info.st_ino != parent.ino {
            _ = close(fd)
            throw AidanError.io("Could not save \(name).")
        }
        return fd
    }

    private static func entryMatches(_ dirfd: Int32, _ name: String, _ dev: dev_t, _ ino: ino_t) -> Bool {
        var listed = stat()
        let rc = name.withCString { fstatat(dirfd, $0, &listed, AT_SYMLINK_NOFOLLOW) }
        if rc != 0 { return false }
        if (listed.st_mode & S_IFMT) == S_IFLNK { return false }
        return listed.st_dev == dev && listed.st_ino == ino
    }

    @discardableResult
    private static func unlinkAtIfSame(_ dirfd: Int32, _ name: String, _ dev: dev_t, _ ino: ino_t) -> Bool {
        if !entryMatches(dirfd, name, dev, ino) { return false }
        let rc = name.withCString { unlinkat(dirfd, $0, 0) }
        return rc == 0
    }

    private static func removeCreatedFile(_ fd: Int32) {
        var opened = stat()
        if fstat(fd, &opened) != 0 { return }
        guard let full = pathOfOpenFile(fd) else { return }
        let dir = (full as NSString).deletingLastPathComponent
        let base = (full as NSString).lastPathComponent
        if base.isEmpty || base == "." || base == ".." || base.contains("/") { return }
        let dirfd = dir.withCString { open($0, O_RDONLY | O_DIRECTORY | O_NOFOLLOW, mode_t(0)) }
        if dirfd < 0 { return }
        defer { _ = close(dirfd) }
        _ = unlinkAtIfSame(dirfd, base, opened.st_dev, opened.st_ino)
    }

    private static func pathOfOpenFile(_ fd: Int32) -> String? {
        var buffer = [CChar](repeating: 0, count: 4096)
#if canImport(Darwin)
        let rc = buffer.withUnsafeMutableBufferPointer { pointer -> Int32 in
            guard let base = pointer.baseAddress else { return -1 }
            return fcntl(fd, F_GETPATH, base)
        }
        if rc != 0 { return nil }
        return String(cString: buffer)
#else
        let link = "/proc/self/fd/\(fd)"
        let n = link.withCString { cLink in
            buffer.withUnsafeMutableBufferPointer { pointer -> Int in
                guard let base = pointer.baseAddress else { return -1 }
                return Int(readlink(cLink, base, 4095))
            }
        }
        if n < 0 { return nil }
        buffer[Int(n)] = 0
        var text = String(cString: buffer)
        let suffix = " (deleted)"
        if text.hasSuffix(suffix) { text.removeLast(suffix.count) }
        return text
#endif
    }

    private static func writeRecovery(_ previous: Data, dirfd: Int32, noteName: String) throws -> RecoveryFile {
        let recoveryName = "\(noteName).\(UUID().uuidString).recover"
        let fd = recoveryName.withCString { openat(dirfd, $0, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_NONBLOCK, mode_t(0o644)) }
        if fd < 0 {
            throw AidanError.io("Could not save \(noteName).")
        }
        defer { _ = close(fd) }
        var opened = stat()
        if fstat(fd, &opened) != 0 {
            throw AidanError.io("Could not save \(noteName).")
        }
        do {
            try writeAll(fd, previous, noteName)
            if fsync(fd) != 0 {
                throw AidanError.io("Could not save \(noteName).")
            }
        } catch {
            _ = unlinkAtIfSame(dirfd, recoveryName, opened.st_dev, opened.st_ino)
            throw error
        }
        return RecoveryFile(name: recoveryName, dev: opened.st_dev, ino: opened.st_ino)
    }

    private static func recoveryRelativeName(vaultRoot: URL?, file: URL) -> String {
        let filePath = file.resolvingSymlinksInPath().path
        guard let rootURL = vaultRoot else { return filePath }
        let root = rootURL.resolvingSymlinksInPath().path
        let prefix = root.hasSuffix("/") ? root : root + "/"
        if filePath.hasPrefix(prefix) {
            return String(filePath.dropFirst(prefix.count))
        }
        return filePath
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
                if name.hasPrefix(".") || name.hasSuffix(".recover") { continue }
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

    static func recoveryFiles(in vault: URL) -> [String] {
        var found: [String] = []
        func walk(_ directory: String, prefix: String) {
            var info = stat()
            if lstat(directory, &info) != 0 || (info.st_mode & S_IFMT) != S_IFDIR { return }
            guard let items = try? FileManager.default.contentsOfDirectory(atPath: directory) else { return }
            for name in items {
                if name == ".git" || name == "." || name == ".." { continue }
                let abs = (directory as NSString).appendingPathComponent(name)
                var listed = stat()
                if lstat(abs, &listed) != 0 { continue }
                let kind = listed.st_mode & S_IFMT
                if kind == S_IFLNK { continue }
                let relative = prefix.isEmpty ? name : prefix + "/" + name
                if kind == S_IFDIR {
                    walk(abs, prefix: relative)
                } else if name.hasSuffix(".recover") {
                    found.append(relative)
                }
            }
        }
        walk(vault.path, prefix: "")
        return found.sorted()
    }
}
