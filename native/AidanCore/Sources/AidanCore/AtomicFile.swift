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
        switch style(for: url, swapInRequested: swapInRequested()) {
        case .inPlace:
            try writeInPlace(data, to: url)
        case .swapIn:
            try AtomicFile.write(data, to: url, beforeRename: beforeRename)
        }
    }

    static func writeInPlace(
        _ data: Data,
        to url: URL,
        beforeOpen: (() -> Void)? = nil,
        beforeWrite: (() throws -> Void)? = nil
    ) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let before = try identity(url.path)
        if let before, before.isLink || !before.isRegular {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        beforeOpen?()
        let flags: Int32 = O_WRONLY | O_NOFOLLOW | O_NONBLOCK | (before == nil ? (O_CREAT | O_EXCL) : 0)
        let fd = url.path.withCString { open($0, flags, mode_t(0o644)) }
        if fd < 0 {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        defer { _ = close(fd) }
        var opened = stat()
        if fstat(fd, &opened) != 0 {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        if let before {
            if opened.st_dev != before.dev || opened.st_ino != before.ino {
                throw AidanError.io("Could not save \(url.lastPathComponent).")
            }
        }
        if (opened.st_mode & S_IFMT) != S_IFREG || opened.st_nlink > 1 {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        try beforeWrite?()
        try writeAll(fd, data, url.lastPathComponent)
        if ftruncate(fd, off_t(data.count)) != 0 {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
        if fsync(fd) != 0 {
            throw AidanError.io("Could not save \(url.lastPathComponent).")
        }
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

    /// The file inside the vault. A symlink anywhere along the path is refused.
    static func fileURL(vault: URL, path: String) throws -> URL {
        let safe = try check(path)
        let root = URL(fileURLWithPath: vault.path).standardizedFileURL.path
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
        }
        let target = URL(fileURLWithPath: current).standardizedFileURL.path
        if target != root && !target.hasPrefix(root.hasSuffix("/") ? root : root + "/") {
            throw AidanError.badPath(path)
        }
        return URL(fileURLWithPath: current)
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
