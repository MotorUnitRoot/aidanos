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
        let phone = try AidanSession(vault: try temporaryVault())
        let mac = try AidanSession(vault: try temporaryVault())
        defer {
            phone.disconnect()
            mac.disconnect()
            relay.stop()
        }
        let path = "notes/typing.md"
        try phone.connect(relayURL: relay.url, token: relay.token)
        try mac.connect(relayURL: relay.url, token: relay.token)
        try phone.replace(path, with: "Hello")
        let helloArrived = try waitUntil(seconds: 20) { (try? mac.text(path)) == "Hello" }
        XCTAssertTrue(helloArrived)
        if !helloArrived { return }
        try mac.replace(path, with: "Hello there")
        let thereArrived = try waitUntil(seconds: 20) { (try? phone.text(path)) == "Hello there" }
        XCTAssertTrue(thereArrived)
        if !thereArrived { return }
        let merged = try phone.applyEdit(path, from: "Hello", to: "Hello!")
        XCTAssertEqual(merged, "Hello! there")
        XCTAssertTrue(try waitUntil(seconds: 20) { (try? mac.text(path)) == "Hello! there" })
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

    func testRebuiltTypingSurvivesFailedConnections() throws {
        let path = "notes/rebuilt-offline.md"
        let (vault, session) = try rebuiltSession(path: path, text: "Hello")
        defer { session.disconnect() }
        let fileURL = vault.appendingPathComponent(path)
        for attempt in 1...3 {
            let typed = "Hello" + String(repeating: "!", count: attempt)
            let stall = try StallServer()
            let finished = DispatchSemaphore(value: 0)
            DispatchQueue.global().async {
                try? session.connect(relayURL: stall.url, token: testToken)
                finished.signal()
            }
            XCTAssertTrue(try waitUntil(seconds: 3) {
                session.connection == .connecting || session.connection == .reconnecting
            })
            Thread.sleep(forTimeInterval: 0.2)
            let shown = try session.text(path)
            let merged = try session.applyEdit(path, from: shown, to: typed)
            XCTAssertEqual(merged, typed)
            stall.stop()
            XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
            XCTAssertEqual(try session.text(path), typed)
            XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), typed)
        }
    }

    func testRebuiltTypingBeforeRelayAnswers() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let path = "notes/rebuilt-typing-\(UUID().uuidString).md"
        let author = try AidanSession(vault: try temporaryVault())
        try author.connect(relayURL: relay.url, token: relay.token)
        try author.replace(path, with: "from the relay")
        let witness = try AidanSession(vault: try temporaryVault())
        try witness.connect(relayURL: relay.url, token: relay.token)
        let arrived = try waitUntil(seconds: 20) { (try? witness.text(path)) == "from the relay" }
        XCTAssertTrue(arrived)
        if !arrived { return }
        witness.disconnect()
        author.disconnect()

        let (vault, reader) = try rebuiltSession(path: path, text: "Hello")
        defer { reader.disconnect() }
        let fileURL = vault.appendingPathComponent(path)
        let stall = try StallServer()
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            try? reader.connect(relayURL: stall.url, token: testToken)
            finished.signal()
        }
        XCTAssertTrue(try waitUntil(seconds: 3) {
            reader.connection == .connecting || reader.connection == .reconnecting
        })
        Thread.sleep(forTimeInterval: 0.2)
        let typed = try reader.applyEdit(path, from: try reader.text(path), to: "Hello!")
        XCTAssertEqual(typed, "Hello!")
        stall.stop()
        XCTAssertEqual(finished.wait(timeout: .now() + 5), .success)
        XCTAssertEqual(try reader.text(path), "Hello!")
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "Hello!")

        try reader.connect(relayURL: relay.url, token: relay.token)
        let raised = try waitUntil(seconds: 20) {
            guard let conflict = reader.conflicts().first(where: { $0.path == path }) else { return false }
            return conflict.mine == "Hello!" && conflict.theirs == "from the relay"
        }
        XCTAssertTrue(raised)
        let conflict = reader.conflicts().first { $0.path == path }
        XCTAssertEqual(conflict?.mine, "Hello!")
        XCTAssertEqual(conflict?.theirs, "from the relay")
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "Hello!")
        let text = try reader.text(path)
        XCTAssertTrue(text == "Hello!" || text == "from the relay")
    }

    func testTypingWhileConflictChoiceIsIgnored() throws {
        let relay = try TestRelay.start()
        defer { relay.stop() }
        let path = "notes/conflict-typing-\(UUID().uuidString).md"
        let author = try AidanSession(vault: try temporaryVault())
        try author.connect(relayURL: relay.url, token: relay.token)
        try author.replace(path, with: "from the relay")
        let witness = try AidanSession(vault: try temporaryVault())
        try witness.connect(relayURL: relay.url, token: relay.token)
        let arrived = try waitUntil(seconds: 20) { (try? witness.text(path)) == "from the relay" }
        XCTAssertTrue(arrived)
        if !arrived { return }
        witness.disconnect()
        author.disconnect()

        let fileVault = try temporaryVault()
        let fileURL = fileVault.appendingPathComponent(path)
        try FileManager.default.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try "from the file".write(to: fileURL, atomically: true, encoding: .utf8)
        let reader = try AidanSession(vault: fileVault)
        defer { reader.disconnect() }
        try reader.connect(relayURL: relay.url, token: relay.token)
        let raised = try waitUntil(seconds: 20) {
            guard let conflict = reader.conflicts().first(where: { $0.path == path }) else { return false }
            return conflict.mine == "from the file" && conflict.theirs == "from the relay"
        }
        XCTAssertTrue(raised)
        if !raised { return }
        let shown = try reader.text(path)
        let afterKey = try reader.applyEdit(path, from: shown, to: shown + "!")
        XCTAssertEqual(afterKey, shown)
        XCTAssertEqual(try reader.text(path), shown)
        let typedFile = try reader.applyEdit(path, from: "from the file", to: "from the file!")
        XCTAssertEqual(typedFile, "from the file")
        XCTAssertEqual(try reader.text(path), shown)
        let conflict = reader.conflicts().first { $0.path == path }
        XCTAssertEqual(conflict?.mine, "from the file")
        XCTAssertEqual(conflict?.theirs, "from the relay")
        XCTAssertEqual(
            ConflictDraft.bothVersions(mine: conflict?.mine ?? "", theirs: conflict?.theirs ?? ""),
            "from the file\nfrom the relay"
        )
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "from the file")
        try reader.resolve(path, choice: .keepMine)
        XCTAssertEqual(try reader.text(path), "from the file")
        XCTAssertEqual(try String(contentsOf: fileURL, encoding: .utf8), "from the file")
    }

    func testInsertMapsThroughRemoteTextBeforeCursor() throws {
        let vault = try temporaryVault()
        let session = try AidanSession(vault: vault)
        let path = "notes/cursor-insert.md"
        try session.replace(path, with: "Hello")
        try session.replace(path, with: "XHello")
        let merged = try session.applyEdit(path, from: "Hello", to: "Hello!")
        XCTAssertEqual(merged, "XHello!")
        XCTAssertEqual(try String(contentsOf: vault.appendingPathComponent(path), encoding: .utf8), "XHello!")
    }

    func testDeleteMapsThroughRemoteTextBeforeCursor() throws {
        let vault = try temporaryVault()
        let session = try AidanSession(vault: vault)
        let path = "notes/cursor-delete.md"
        try session.replace(path, with: "Hello")
        try session.replace(path, with: "XHello")
        let merged = try session.applyEdit(path, from: "Hello", to: "Hell")
        XCTAssertEqual(merged, "XHell")
        XCTAssertEqual(try String(contentsOf: vault.appendingPathComponent(path), encoding: .utf8), "XHell")
    }

    func testOversizedCloseDoesNotRetry() throws {
        let closer = try ClosingServer(code: 1009, reason: "Max payload size exceeded")
        defer { closer.stop() }
        let session = try AidanSession(vault: try temporaryVault())
        session.reconnectPause = 0.2
        defer { session.disconnect() }
        XCTAssertThrowsError(try session.connect(relayURL: closer.url, token: testToken)) { error in
            XCTAssertEqual(error as? AidanError, .payloadTooLarge)
        }
        Thread.sleep(forTimeInterval: 0.7)
        XCTAssertEqual(session.connection, .disconnected)
        XCTAssertEqual(closer.accepts, 1)
    }

    func testAppRefusesTheRelayFolder() throws {
        let vault = try temporaryVault()
        try FileManager.default.createDirectory(at: vault.appendingPathComponent(".aidanos"), withIntermediateDirectories: true)
        try Data("relay\n".utf8).write(to: vault.appendingPathComponent(".aidanos/relay-folder"))
        XCTAssertThrowsError(try AidanSession(vault: vault))
        XCTAssertFalse(FileManager.default.fileExists(atPath: vault.appendingPathComponent(".aidanos/actor").path))

        let data = try temporaryVault()
        try Data("relay\n".utf8).write(to: data.appendingPathComponent("relay-folder"))
        XCTAssertThrowsError(try AidanSession(vault: data))
        XCTAssertFalse(FileManager.default.fileExists(atPath: data.appendingPathComponent(".aidanos/actor").path))
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

private func rebuiltSession(path: String, text: String) throws -> (URL, AidanSession) {
    let vault = try temporaryVault()
    do {
        let first = try AidanSession(vault: vault)
        try first.replace(path, with: text)
    }
    try FileManager.default.removeItem(at: vault.appendingPathComponent(".aidanos"))
    let again = try AidanSession(vault: vault)
    again.reconnectPause = 60
    return (vault, again)
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

private func closeSocket(_ fd: Int32) -> Int32 {
    #if canImport(Darwin)
    _ = Darwin.shutdown(fd, Int32(SHUT_RDWR))
    return Darwin.close(fd)
    #else
    _ = Glibc.shutdown(fd, Int32(SHUT_RDWR))
    return Glibc.close(fd)
    #endif
}

private func readSocket(_ fd: Int32, _ buffer: UnsafeMutableRawPointer, _ count: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.read(fd, buffer, count)
    #else
    return Glibc.read(fd, buffer, count)
    #endif
}

private func writeSocket(_ fd: Int32, _ buffer: UnsafeRawPointer, _ count: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.write(fd, buffer, count)
    #else
    return Glibc.write(fd, buffer, count)
    #endif
}

private func acceptSocket(_ fd: Int32) -> Int32 {
    if fd < 0 { return -1 }
    #if canImport(Darwin)
    return Darwin.accept(fd, nil, nil)
    #else
    return Glibc.accept(fd, nil, nil)
    #endif
}

private enum Loopback {
    static func listen() throws -> (fd: Int32, port: Int) {
        #if canImport(Darwin)
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        #else
        let fd = socket(AF_INET, Int32(SOCK_STREAM.rawValue), 0)
        #endif
        if fd < 0 { throw AidanError.io("Could not open a test socket.") }
        var yes: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_REUSEADDR, &yes, socklen_t(MemoryLayout.size(ofValue: yes)))
        var address = sockaddr_in()
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        if bound != 0 {
            _ = closeSocket(fd)
            throw AidanError.io("Could not bind a test socket.")
        }
        #if canImport(Darwin)
        let listening = Darwin.listen(fd, 16)
        #else
        let listening = Glibc.listen(fd, 16)
        #endif
        if listening != 0 {
            _ = closeSocket(fd)
            throw AidanError.io("Could not listen on a test socket.")
        }
        var got = sockaddr_in()
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let named = withUnsafeMutablePointer(to: &got) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                getsockname(fd, $0, &length)
            }
        }
        if named != 0 {
            _ = closeSocket(fd)
            throw AidanError.io("Could not read the test port.")
        }
        return (fd, Int(UInt16(bigEndian: got.sin_port)))
    }
}

/// Accepts a connection and never answers, so a rebuilt note stays in the waiting state.
private final class StallServer {
    let url: String
    private var listenFd: Int32
    private let lock = NSLock()
    private var clients: [Int32] = []

    init() throws {
        let bound = try Loopback.listen()
        listenFd = bound.fd
        url = "ws://127.0.0.1:\(bound.port)"
        DispatchQueue.global().async { [self] in
            self.acceptLoop()
        }
    }

    private func acceptLoop() {
        while true {
            let client = acceptSocket(listenFd)
            if client < 0 { return }
            lock.lock()
            clients.append(client)
            lock.unlock()
            DispatchQueue.global().async {
                var buffer = [UInt8](repeating: 0, count: 1024)
                while true {
                    let count = buffer.withUnsafeMutableBytes { raw -> Int in
                        guard let base = raw.baseAddress else { return 0 }
                        return readSocket(client, base, raw.count)
                    }
                    if count <= 0 { return }
                }
            }
        }
    }

    func stop() {
        lock.lock()
        let open = clients
        clients = []
        let listen = listenFd
        listenFd = -1
        lock.unlock()
        for fd in open { _ = closeSocket(fd) }
        if listen >= 0 { _ = closeSocket(listen) }
    }
}

/// Completes the WebSocket handshake and then closes with a payload error.
private final class ClosingServer {
    let url: String
    private let code: Int
    private let reason: String
    private var listenFd: Int32
    private let lock = NSLock()
    private var accepted = 0

    init(code: Int, reason: String) throws {
        self.code = code
        self.reason = reason
        let bound = try Loopback.listen()
        listenFd = bound.fd
        url = "ws://127.0.0.1:\(bound.port)"
        DispatchQueue.global().async { [self] in
            self.acceptLoop()
        }
    }

    var accepts: Int {
        lock.lock()
        defer { lock.unlock() }
        return accepted
    }

    private func acceptLoop() {
        while true {
            let client = acceptSocket(listenFd)
            if client < 0 { return }
            lock.lock()
            accepted += 1
            lock.unlock()
            reply(client)
            _ = closeSocket(client)
        }
    }

    private func reply(_ fd: Int32) {
        var header = Data()
        var buffer = [UInt8](repeating: 0, count: 1)
        while header.count < 8192 {
            let count = buffer.withUnsafeMutableBytes { raw -> Int in
                guard let base = raw.baseAddress else { return 0 }
                return readSocket(fd, base, 1)
            }
            if count <= 0 { return }
            header.append(buffer[0])
            if header.suffix(4).elementsEqual(Data([13, 10, 13, 10])) { break }
        }
        let switching = Data("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n".utf8)
        guard writeAll(fd, switching) else { return }
        let reasonBytes = Array(reason.utf8)
        var frame = [UInt8](arrayLiteral: 0x88, UInt8(2 + reasonBytes.count), UInt8((code >> 8) & 0xFF), UInt8(code & 0xFF))
        frame.append(contentsOf: reasonBytes)
        _ = writeAll(fd, Data(frame))
    }

    func stop() {
        lock.lock()
        let listen = listenFd
        listenFd = -1
        lock.unlock()
        if listen >= 0 { _ = closeSocket(listen) }
    }

    private func writeAll(_ fd: Int32, _ data: Data) -> Bool {
        let bytes = [UInt8](data)
        var offset = 0
        while offset < bytes.count {
            let wrote = bytes.withUnsafeBytes { raw -> Int in
                guard let base = raw.baseAddress else { return -1 }
                return writeSocket(fd, base + offset, bytes.count - offset)
            }
            if wrote <= 0 { return false }
            offset += wrote
        }
        return true
    }
}
