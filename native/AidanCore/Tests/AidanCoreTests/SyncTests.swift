@testable import AidanCore
import Foundation
import XCTest

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

private let testToken = "aidanos-test-token-0123456789abcdef"

final class SyncTests: XCTestCase {
    func testAirplaneModeMerge() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let phoneVault = try temporaryVault()
        let macVault = try temporaryVault()
        let path = "log/\(UUID().uuidString)/2026-10-21.md"
        let phone = try AidanSession(vault: phoneVault)
        let mac = try AidanSession(vault: macVault)
        try phone.connect(relayURL: relay.url, token: relay.token)
        try mac.connect(relayURL: relay.url, token: relay.token)
        try phone.replace(path, with: "Hello")
        let shared = try waitUntil(seconds: 8) {
            guard (try? phone.text(path)) == "Hello", (try? mac.text(path)) == "Hello" else { return false }
            if let relayVault = relay.vault {
                let file = try? String(contentsOf: relayVault.appendingPathComponent(path), encoding: .utf8)
                return file == "Hello"
            }
            return true
        }
        XCTAssertTrue(shared)
        phone.disconnect()
        mac.disconnect()
        try phone.replace(path, with: "Hello PHONE")
        try mac.replace(path, with: "Hello MAC")
        #if !os(iOS)
        try relay.restart()
        #endif
        try phone.connect(relayURL: relay.url, token: relay.token)
        try mac.connect(relayURL: relay.url, token: relay.token)
        let allowed = ["Hello PHONE MAC", "Hello MAC PHONE"]
        let merged = try waitUntil(seconds: 12) {
            guard let left = try? phone.text(path), let right = try? mac.text(path) else { return false }
            return left == right && allowed.contains(left)
        }
        let phoneText = try phone.text(path)
        let macText = try mac.text(path)
        XCTAssertTrue(merged, "phone=\(phoneText) mac=\(macText)")
        XCTAssertEqual(phoneText, macText)
        XCTAssertTrue(allowed.contains(phoneText))
        let phoneFile = try String(contentsOf: phoneVault.appendingPathComponent(path), encoding: .utf8)
        let macFile = try String(contentsOf: macVault.appendingPathComponent(path), encoding: .utf8)
        XCTAssertEqual(phoneFile, phoneText)
        XCTAssertEqual(macFile, macText)
        if let relayVault = relay.vault {
            let copied = try waitUntil(seconds: 8) {
                let text = try? String(contentsOf: relayVault.appendingPathComponent(path), encoding: .utf8)
                return text == phoneText
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
        let allowed = ["morning lineevening line", "evening linemorning line"]
        let merged = try waitUntil(seconds: 12) {
            guard let a = try? left.text(path), let b = try? right.text(path) else { return false }
            return a == b && allowed.contains(a)
        }
        let leftText = try left.text(path)
        let rightText = try right.text(path)
        XCTAssertTrue(merged, "left=\(leftText) right=\(rightText)")
        XCTAssertEqual(leftText, rightText)
        XCTAssertTrue(left.conflicts().isEmpty)
        XCTAssertTrue(right.conflicts().isEmpty)
        left.disconnect()
        right.disconnect()
    }

    func testOutsideEditWhileOpenThenKeystrokeKeepsBoth() throws {
        let vault = try temporaryVault()
        let session = try AidanSession(vault: vault)
        let path = "notes/outside.md"
        try session.replace(path, with: "Hello")
        let url = vault.appendingPathComponent(path)
        try "Hello world".write(to: url, atomically: true, encoding: .utf8)
        var shown: String?
        session.onText = { _, value in shown = value }
        session.foldOutsideEdits()
        XCTAssertEqual(try session.text(path), "Hello world")
        XCTAssertEqual(shown, "Hello world")
        let merged = try session.applyEdit(path, from: "Hello", to: "Hello!")
        XCTAssertEqual(merged, "Hello! world")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "Hello! world")
    }

    func testRemoteTextWhileTypingKeepsBoth() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let phone = try AidanSession(vault: try temporaryVault())
        let mac = try AidanSession(vault: try temporaryVault())
        let path = "notes/typing.md"
        try phone.connect(relayURL: relay.url, token: relay.token)
        try mac.connect(relayURL: relay.url, token: relay.token)
        try phone.replace(path, with: "Hello")
        XCTAssertTrue(try waitUntil(seconds: 8) { (try? mac.text(path)) == "Hello" })
        try mac.replace(path, with: "Hello there")
        XCTAssertTrue(try waitUntil(seconds: 8) { (try? phone.text(path)) == "Hello there" })
        let merged = try phone.applyEdit(path, from: "Hello", to: "Hello!")
        XCTAssertEqual(merged, "Hello! there")
        XCTAssertTrue(try waitUntil(seconds: 8) { (try? mac.text(path)) == "Hello! there" })
        phone.disconnect()
        mac.disconnect()
    }

    func testOutsideEditWhileClosedSurvivesLaunch() throws {
        let vault = try temporaryVault()
        let path = "notes/outside.md"
        do {
            let session = try AidanSession(vault: vault)
            try session.replace(path, with: "Hello")
        }
        let url = vault.appendingPathComponent(path)
        try "Hello world".write(to: url, atomically: true, encoding: .utf8)
        let again = try AidanSession(vault: vault)
        XCTAssertEqual(try again.text(path), "Hello world")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "Hello world")
        XCTAssertEqual(try again.open(path), "Hello world")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "Hello world")
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

    func testRebuildWhileConnectedKeepsBoth() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let author = try AidanSession(vault: try temporaryVault())
        let path = "notes/rebuilt.md"
        try author.connect(relayURL: relay.url, token: relay.token)
        try author.replace(path, with: "from the relay")
        let witness = try AidanSession(vault: try temporaryVault())
        try witness.connect(relayURL: relay.url, token: relay.token)
        let arrived = try waitUntil(seconds: 15) {
            (try? witness.text(path)) == "from the relay"
        }
        XCTAssertTrue(arrived)
        if let relayVault = relay.vault {
            XCTAssertTrue(try waitUntil(seconds: 8) {
                let text = try? String(contentsOf: relayVault.appendingPathComponent(path), encoding: .utf8)
                return text == "from the relay"
            })
        }
        witness.disconnect()
        author.disconnect()
        let fileVault = try temporaryVault()
        let fileURL = fileVault.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "from the file".write(to: fileURL, atomically: true, encoding: .utf8)
        let reader = try AidanSession(vault: fileVault)
        try reader.connect(relayURL: relay.url, token: relay.token)
        let raised = try waitUntil(seconds: 20) {
            guard let conflict = reader.conflicts().first(where: { $0.path == path }) else { return false }
            return conflict.mine == "from the file" && conflict.theirs == "from the relay"
        }
        XCTAssertTrue(raised)
        let conflict = reader.conflicts().first { $0.path == path }
        XCTAssertEqual(conflict?.mine, "from the file")
        XCTAssertEqual(conflict?.theirs, "from the relay")
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "from the file")
        reader.disconnect()
    }

    func testCrashBetweenHistoryAndFileDoesNotDuplicate() throws {
        let vault = try temporaryVault()
        let path = "notes/crash.md"
        do {
            let session = try AidanSession(vault: vault)
            try session.replace(path, with: "Hello!")
        }
        let url = vault.appendingPathComponent(path)
        try "Hello".write(to: url, atomically: true, encoding: .utf8)
        let hashes = ["notes/crash.md": Digests.sha256Hex("Hello")]
        try JSONEncoder().encode(hashes).write(to: vault.appendingPathComponent(".aidanos/written.json"))
        let again = try AidanSession(vault: vault)
        XCTAssertEqual(try again.text(path), "Hello!")
        XCTAssertEqual(try String(contentsOf: url, encoding: .utf8), "Hello!")
    }

    func testNoteCreatedAfterConnectSyncs() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let left = try AidanSession(vault: try temporaryVault())
        let right = try AidanSession(vault: try temporaryVault())
        try left.connect(relayURL: relay.url, token: relay.token)
        try right.connect(relayURL: relay.url, token: relay.token)
        let path = AidanSession.todayPath(on: Date(timeIntervalSince1970: 1_800_000_000), timeZone: TimeZone(secondsFromGMT: 0)!)
        try left.replace(path, with: "created after")
        XCTAssertTrue(try waitUntil(seconds: 8) { (try? right.text(path)) == "created after" })
        left.disconnect()
        right.disconnect()
    }

    func testTodayPathChangesAtMidnight() {
        let zone = TimeZone(secondsFromGMT: 0)!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let before = calendar.date(from: DateComponents(year: 2026, month: 10, day: 21, hour: 23, minute: 30))!
        let after = calendar.date(from: DateComponents(year: 2026, month: 10, day: 22, hour: 0, minute: 5))!
        let path = AidanSession.todayPath(on: before, timeZone: zone)
        XCTAssertEqual(path, "log/2026-10-21.md")
        XCTAssertNil(AidanSession.changedDay(from: path, now: before, timeZone: zone))
        XCTAssertEqual(AidanSession.changedDay(from: path, now: after, timeZone: zone), "log/2026-10-22.md")
    }

    func testReconnectsAfterTheRelayDrops() throws {
        #if os(iOS)
        throw XCTSkip("The simulator shares a relay this test cannot restart.")
        #else
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let session = try AidanSession(vault: try temporaryVault())
        session.reconnectPause = 0.05
        try session.connect(relayURL: relay.url, token: relay.token)
        XCTAssertEqual(session.connection, .connected)
        relay.stop()
        XCTAssertTrue(try waitUntil(seconds: 8) {
            session.connection == .reconnecting || session.connection == .connecting
        })
        XCTAssertNotEqual(session.connection, .connected)
        try relay.restart()
        XCTAssertTrue(try waitUntil(seconds: 8) { session.connection == .connected })
        try session.replace("notes/back.md", with: "still here")
        if let relayVault = relay.vault {
            XCTAssertTrue(try waitUntil(seconds: 8) {
                let text = try? String(contentsOf: relayVault.appendingPathComponent("notes/back.md"), encoding: .utf8)
                return text == "still here"
            })
        }
        session.disconnect()
        #endif
    }

    func testHiddenGitPathIsRefused() throws {
        let vault = try temporaryVault()
        let session = try AidanSession(vault: vault)
        XCTAssertThrowsError(try session.replace(".git/config", with: "[core]\n\tfake = true\n"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: vault.appendingPathComponent(".git/config").path))
        let outside = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("aidanos-outside-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
        try FileManager.default.createSymbolicLink(at: vault.appendingPathComponent("jump"), withDestinationURL: outside)
        XCTAssertThrowsError(try session.replace("jump/pwn.md", with: "nope"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: outside.appendingPathComponent("pwn.md").path))
    }

    func testConflictEditStartsWithBothVersions() {
        XCTAssertEqual(ConflictDraft.bothVersions(mine: "mine", theirs: "theirs"), "mine\ntheirs")
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

#if !os(iOS)
private final class RunningRelay {
    let process: Process
    let log: URL
    let output: FileHandle
    init(process: Process, log: URL, output: FileHandle) {
        self.process = process
        self.log = log
        self.output = output
    }

    var port: Int? {
        guard let text = try? String(contentsOf: log, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") where line.hasPrefix("LISTENING") {
            let parts = line.split(separator: " ")
            if parts.count >= 3, let value = Int(parts[2]) { return value }
        }
        return nil
    }

    var errorText: String {
        (try? String(contentsOf: log, encoding: .utf8)) ?? ""
    }
}
#endif

private final class TestRelay {
    let url: String
    let token: String
    let vault: URL?
    #if !os(iOS)
    private var running: RunningRelay?
    private let data: URL
    private let port: Int
    private let server: URL
    #endif

    static func start() throws -> TestRelay {
        #if os(iOS)
        return TestRelay(url: "ws://127.0.0.1:3757", token: testToken, vault: nil)
        #else
        return try spawn()
        #endif
    }

    func stop() {
        #if !os(iOS)
        guard let running, running.process.isRunning else { return }
        running.process.terminate()
        let deadline = Date().addingTimeInterval(2)
        while running.process.isRunning && Date() < deadline {
            Thread.sleep(forTimeInterval: 0.05)
        }
        if running.process.isRunning {
            kill(running.process.processIdentifier, SIGKILL)
            running.process.waitUntilExit()
        }
        #endif
    }

    #if !os(iOS)
    func restart() throws {
        stop()
        Thread.sleep(forTimeInterval: 0.3)
        guard let vault else { throw AidanError.io("This relay has no folder.") }
        running = try Self.launch(server: server, vault: vault, data: data, port: port, token: token)
        _ = try Self.waitPort(running!)
    }
    #endif

    #if os(iOS)
    private init(url: String, token: String, vault: URL?) {
        self.url = url
        self.token = token
        self.vault = vault
    }
    #else
    private init(url: String, token: String, vault: URL, data: URL, port: Int, server: URL, running: RunningRelay) {
        self.url = url
        self.token = token
        self.vault = vault
        self.data = data
        self.port = port
        self.server = server
        self.running = running
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
        let running = try launch(server: server, vault: vault, data: data, port: 0, token: testToken)
        let port = try waitPort(running)
        return TestRelay(
            url: "ws://127.0.0.1:\(port)",
            token: testToken,
            vault: vault,
            data: data,
            port: port,
            server: server,
            running: running
        )
    }

    private static func launch(server: URL, vault: URL, data: URL, port: Int, token: String) throws -> RunningRelay {
        _ = signal(SIGPIPE, SIG_IGN)
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = [
            "node", server.path,
            "--vault", vault.path,
            "--data", data.path,
            "--port", String(port),
        ]
        var environment = ProcessInfo.processInfo.environment
        environment["AIDANOS_RELAY_TOKEN"] = token
        environment["AIDANOS_MIRROR_DEBOUNCE_MS"] = "30"
        environment["AIDANOS_VAULT_GIT_URL"] = ""
        process.environment = environment
        process.currentDirectoryURL = server.deletingLastPathComponent().deletingLastPathComponent()
        let log = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
            .appendingPathComponent("aidanos-relay-\(UUID().uuidString).log")
        FileManager.default.createFile(atPath: log.path, contents: nil)
        let handle = try FileHandle(forWritingTo: log)
        process.standardOutput = handle
        process.standardError = handle
        try process.run()
        return RunningRelay(process: process, log: log, output: handle)
    }

    private static func waitPort(_ running: RunningRelay) throws -> Int {
        let deadline = Date().addingTimeInterval(15)
        while Date() < deadline {
            if let port = running.port { return port }
            if !running.process.isRunning { break }
            Thread.sleep(forTimeInterval: 0.05)
        }
        if let port = running.port { return port }
        running.process.terminate()
        throw AidanError.io("The test relay did not start. \(running.errorText)")
    }
    #endif
}
