import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

enum AtomicFile {
    static func write(_ data: Data, to url: URL) throws {
        let directory = url.deletingLastPathComponent()
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let temporary = directory.appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString).tmp")
        try data.write(to: temporary)
        let descriptor = temporary.path.withCString { open($0, O_RDONLY) }
        if descriptor >= 0 {
            _ = fsync(descriptor)
            _ = close(descriptor)
        }
        let renamed = temporary.path.withCString { source in
            url.path.withCString { destination in
                rename(source, destination)
            }
        }
        if renamed != 0 {
            throw AidanError.io("Could not finish saving \(url.lastPathComponent).")
        }
    }
}

enum VaultPaths {
    static func check(_ path: String) throws -> String {
        let parts = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        if parts.isEmpty || parts.contains(where: { $0.isEmpty || $0 == "." || $0 == ".." }) {
            throw AidanError.badPath(path)
        }
        return parts.joined(separator: "/")
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
