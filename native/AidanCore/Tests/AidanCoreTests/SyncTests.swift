import AidanCore
import Foundation
import XCTest

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

final class SyncTests: XCTestCase {
    func testAirplaneModeMerge() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let phoneVault = try temporaryVault()
        let macVault = try temporaryVault()
        let path = "log/\(UUID().uuidString)/2026-10-21.md"
        let phone = try AidanSession(vault: phoneVault)
        let mac = try AidanSession(vault: macVault)
        try phone.replace(path, with: "from the phone")
        try mac.replace(path, with: "from the mac")

        try phone.connect(relayURL: relay.url, token: relay.token)
        try mac.connect(relayURL: relay.url, token: relay.token)

        let merged = try waitUntil(seconds: 12) {
            guard let left = try? phone.text(path), let right = try? mac.text(path) else { return false }
            return left.contains("from the phone") && left.contains("from the mac")
                && right.contains("from the phone") && right.contains("from the mac")
        }
        let phoneText = try phone.text(path)
        let macText = try mac.text(path)
        XCTAssertTrue(merged, "phone=\(phoneText) mac=\(macText)")
        let phoneFile = try String(contentsOf: phoneVault.appendingPathComponent(path), encoding: .utf8)
        let macFile = try String(contentsOf: macVault.appendingPathComponent(path), encoding: .utf8)
        XCTAssertTrue(phoneFile.contains("from the phone") && phoneFile.contains("from the mac"))
        XCTAssertTrue(macFile.contains("from the phone") && macFile.contains("from the mac"))
        if let relayVault = relay.vault {
            let copied = try waitUntil(seconds: 8) {
                let text = try? String(contentsOf: relayVault.appendingPathComponent(path), encoding: .utf8)
                return text?.contains("from the phone") == true && text?.contains("from the mac") == true
            }
            XCTAssertTrue(copied)
        }
        phone.disconnect()
        mac.disconnect()
    }

    func testSameDayNoteCreatedTwice() throws {
        XCTAssertEqual(DocumentIds.indexId, "kzVG91fmPf29XccAmWvPc84XFsz")
        XCTAssertEqual(DocumentIds.noteId("log/2026-10-21.md"), "ZKoZb6F64viudVxEu95EYSVBm7p")
        let zone = TimeZone(secondsFromGMT: 0)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let date = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21))!
        let path = AidanSession.todayPath(on: date, timeZone: zone)
        XCTAssertEqual(path, "log/2026-10-21.md")

        let relay = try TestRelay.start()
        defer { relay.stop() }
        let leftVault = try temporaryVault()
        let rightVault = try temporaryVault()
        let left = try AidanSession(vault: leftVault)
        let right = try AidanSession(vault: rightVault)
        try left.replace(path, with: "morning line")
        try right.replace(path, with: "evening line")
        try left.connect(relayURL: relay.url, token: relay.token)
        try right.connect(relayURL: relay.url, token: relay.token)
        let merged = try waitUntil(seconds: 12) {
            guard let a = try? left.text(path), let b = try? right.text(path) else { return false }
            return a.contains("morning line") && a.contains("evening line")
                && b.contains("morning line") && b.contains("evening line")
        }
        let leftText = try left.text(path)
        let rightText = try right.text(path)
        XCTAssertTrue(merged, "left=\(leftText) right=\(rightText)")
        XCTAssertTrue(left.conflicts().isEmpty)
        XCTAssertTrue(right.conflicts().isEmpty)
        left.disconnect()
        right.disconnect()
    }

    func testOutsideEditFoldedIn() throws {
        let vault = try temporaryVault()
        let session = try AidanSession(vault: vault)
        let path = "notes/outside.md"
        try session.replace(path, with: "Hello")
        let url = vault.appendingPathComponent(path)
        try "Hello world".write(to: url, atomically: true, encoding: .utf8)
        session.foldOutsideEdits()
        XCTAssertEqual(try session.text(path), "Hello world")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "Hello world")
        XCTAssertTrue(session.conflicts().isEmpty)
    }

    func testCacheRebuiltFromMarkdown() throws {
        let vault = try temporaryVault()
        let first = try AidanSession(vault: vault)
        try first.replace("notes/cached.md", with: "from the file")
        try FileManager.default.removeItem(at: vault.appendingPathComponent(".aidanos"))
        let again = try AidanSession(vault: vault)
        XCTAssertEqual(try again.text("notes/cached.md"), "from the file")
        let file = try String(contentsOf: vault.appendingPathComponent("notes/cached.md"), encoding: .utf8)
        XCTAssertEqual(file, "from the file")
    }

    func testRelayRejectsBadToken() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let session = try AidanSession(vault: try temporaryVault())
        XCTAssertThrowsError(try session.connect(relayURL: relay.url, token: "not-the-token")) { error in
            XCTAssertEqual(error as? AidanError, .authRejected)
        }
        XCTAssertNoThrow(try session.connect(relayURL: relay.url, token: relay.token))
        session.disconnect()
    }
}

private func temporaryVault() throws -> URL {
    let url = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        .appendingPathComponent("aidanos-test-\(UUID().uuidString)", isDirectory: true)
    try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

private func waitUntil(seconds: TimeInterval, _ body: () throws -> Bool) throws -> Bool {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        if try body() { return true }
        Thread.sleep(forTimeInterval: 0.05)
    }
    return try body()
}

private final class TestRelay {
    let url: String
    let token: String
    let vault: URL?
    #if !os(iOS)
    private let process: Process?
    #endif

    static func start() throws -> TestRelay {
        #if os(iOS)
        return TestRelay(url: "ws://127.0.0.1:3757", token: "aidanos-test-token", vault: nil)
        #else
        return try spawn()
        #endif
    }

    func stop() {
        #if !os(iOS)
        guard let process, process.isRunning else { return }
        process.terminate()
        process.waitUntilExit()
        #endif
    }

    #if os(iOS)
    private init(url: String, token: String, vault: URL?) {
        self.url = url
        self.token = token
        self.vault = vault
    }
    #else
    private init(url: String, token: String, vault: URL?, process: Process?) {
        self.url = url
        self.token = token
        self.vault = vault
        self.process = process
    }
    #endif

    #if !os(iOS)
    private static func spawn() throws -> TestRelay {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("aidanos-relay-\(UUID().uuidString)", isDirectory: true)
        let vault = root.appendingPathComponent("vault", isDirectory: true)
        let data = root.appendingPathComponent("data", isDirectory: true)
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: data, withIntermediateDirectories: true)
        let workspace = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
            .deletingLastPathComponent()
        let server = workspace.appendingPathComponent("relay/src/server.mjs")
        _ = signal(SIGPIPE, SIG_IGN)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "node", server.path,
            "--token", "aidanos-test-token",
            "--vault", vault.path,
            "--data", data.path,
            "--port", "0",
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["AIDANOS_MIRROR_DEBOUNCE_MS"] = "30"
        environment["AIDANOS_VAULT_GIT_URL"] = ""
        process.environment = environment
        process.currentDirectoryURL = workspace.appendingPathComponent("relay")
        let output = Pipe()
        let errors = Pipe()
        process.standardOutput = output
        process.standardError = errors
        let collected = Collected()
        let ready = DispatchSemaphore(value: 0)
        output.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if chunk.isEmpty { return }
            collected.append(chunk)
            if collected.port != nil { ready.signal() }
        }
        errors.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            if !chunk.isEmpty { collected.appendError(chunk) }
        }
        try process.run()
        let wait = ready.wait(timeout: .now() + 15)
        output.fileHandleForReading.readabilityHandler = nil
        guard wait == .success, let port = collected.port else {
            let message = collected.errorText.isEmpty ? collected.text : collected.errorText
            process.terminate()
            throw AidanError.io("The test relay did not start. \(message)")
        }
        return TestRelay(
            url: "ws://127.0.0.1:\(port)",
            token: "aidanos-test-token",
            vault: vault,
            process: process
        )
    }
    #endif
}

private final class Collected {
    private let lock = NSLock()
    private var output = ""
    private var errors = ""
    private var heard = false

    var text: String {
        lock.lock()
        defer { lock.unlock() }
        return output
    }

    var errorText: String {
        lock.lock()
        defer { lock.unlock() }
        return errors
    }

    var port: Int? {
        lock.lock()
        defer { lock.unlock() }
        for line in output.split(separator: "\n") where line.hasPrefix("LISTENING") {
            let parts = line.split(separator: " ")
            if parts.count >= 3, let value = Int(parts[2]) { return value }
        }
        return nil
    }

    func append(_ data: Data) {
        lock.lock()
        output += String(data: data, encoding: .utf8) ?? ""
        let found = portUnlocked()
        lock.unlock()
        if found { heard = true }
    }

    func appendError(_ data: Data) {
        lock.lock()
        errors += String(data: data, encoding: .utf8) ?? ""
        lock.unlock()
    }

    private func portUnlocked() -> Bool {
        for line in output.split(separator: "\n") where line.hasPrefix("LISTENING") {
            return true
        }
        return false
    }
}
