import Automerge
import Crypto
import Foundation

public enum ConnectionState: Equatable, Sendable {
    case disconnected
    case connecting
    case connected
    case reconnecting

    public var label: String {
        switch self {
        case .disconnected: return "Not connected"
        case .connecting: return "Connecting…"
        case .connected: return "Connected"
        case .reconnecting: return "Reconnecting…"
        }
    }
}

public enum ConflictDraft {
    /// Edit starts with both versions, one after the other.
    public static func bothVersions(mine: String, theirs: String) -> String {
        if mine.isEmpty { return theirs }
        if theirs.isEmpty { return mine }
        return mine + "\n" + theirs
    }
}

enum Digests {
    static func sha256Hex(_ text: String) -> String {
        SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

/// One vault, its markdown files, and the Automerge histories beside them.
public final class AidanSession: SyncHost {
    fileprivate static let rebuildConflictReason = "This device rebuilt the note from the file, and the relay already has different text. Choosing automatically would wipe one side."
    public let vault: URL
    public var onText: ((String, String) -> Void)?
    public var onConnection: ((ConnectionState) -> Void)?
    public var onError: ((String) -> Void)?
    private var storedConnection: ConnectionState = .disconnected
    public var connection: ConnectionState {
        lock.lock()
        defer { lock.unlock() }
        return storedConnection
    }
    /// First retry wait. Later waits double, up to 30 seconds.
    public var reconnectPause: TimeInterval = 1

    private let lock = NSLock()
    private let deviceActor: ActorId
    private var index: Document
    private var notes: [String: NoteState] = [:]
    private var loose: [String: NoteState] = [:]
    private var slots: [String: SyncSlot] = [:]
    private var openConflicts: [NoteConflict] = []
    private var lastWritten: [String: String] = [:]
    private var writtenHash: [String: String] = [:]
    private var suppressWatch = 0
    private var link: RelayLink?
    private var watcher: DispatchSourceTimer?
    private let peerId: String
    private let storageId: String
    private var desiredURL: String?
    private var desiredToken: String?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var opening = false

    public init(vault: URL) throws {
        if Self.looksLikeRelayFolder(vault) {
            throw AidanError.io("This folder belongs to the relay. The app keeps its notes in a different folder.")
        }
        self.vault = vault
        try FileManager.default.createDirectory(at: vault, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: vault.appendingPathComponent(".aidanos"), withIntermediateDirectories: true)
        self.deviceActor = try AidanSession.loadActor(in: vault)
        self.peerId = "aidanos-" + UUID().uuidString.lowercased()
        self.storageId = try AidanSession.loadStorageId(in: vault)
        if let data = try? Data(contentsOf: AidanSession.indexURL(vault)),
           let loaded = try? Document(data) {
            loaded.actor = deviceActor
            self.index = loaded
        } else {
            self.index = try AidanSession.makeDocument(docId: DocumentIds.indexId, kind: "index", actor: deviceActor).0
        }
        writtenHash = Self.loadWritten(in: vault)
        try loadFromDisk()
        loadMeta()
        _ = foldLocked()
        try saveIndex()
        for note in notes.values { try save(note) }
        try saveMeta()
        startWatcher()
    }

    deinit {
        watcher?.cancel()
        reconnectWork?.cancel()
        link?.close()
    }

    public static func todayPath(on date: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "log/%04d-%02d-%02d.md", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    public static func changedDay(from current: String, now: Date = Date(), timeZone: TimeZone = .current) -> String? {
        let next = todayPath(on: now, timeZone: timeZone)
        return next == current ? nil : next
    }

    public func open(_ path: String) throws -> String {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        defer { lock.unlock() }
        _ = try ensureNoteLocked(notePath, initial: readIfPresent(notePath) ?? "")
        if let note = notes[notePath], note.rebuilt {
            return readIfPresent(notePath) ?? ""
        }
        if var note = notes[notePath], !note.rebuilt, !conflicted(notePath) {
            if let file = readIfPresent(notePath), writtenHash[notePath] != Self.sha(file) {
                let current = try note.doc.text(obj: note.textObj)
                if current != file {
                    try setText(&note, file)
                    notes[notePath] = note
                    try save(note)
                }
            }
        }
        guard let note = notes[notePath] else { return "" }
        let text = try note.doc.text(obj: note.textObj)
        if !note.rebuilt && !conflicted(notePath) && readIfPresent(notePath) != text {
            try writeFileLocked(notePath, text)
        }
        return text
    }

    public func text(_ path: String) throws -> String {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        defer { lock.unlock() }
        guard let note = notes[notePath] else { return "" }
        if note.rebuilt {
            return readIfPresent(notePath) ?? ""
        }
        return try note.doc.text(obj: note.textObj)
    }

    public func replace(_ path: String, with text: String) throws {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        suppressWatch += 1
        defer {
            suppressWatch -= 1
            lock.unlock()
        }
        var note = try ensureNoteLocked(notePath, initial: text)
        try setText(&note, text)
        notes[notePath] = note
        try save(note)
        try writeFileLocked(notePath, text)
        trackAndKick(note.docId)
    }

    /// Applies the edit from `base` to `edited` onto the current note, even if the note moved on.
    @discardableResult
    public func applyEdit(_ path: String, from base: String, to edited: String) throws -> String {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        suppressWatch += 1
        defer {
            suppressWatch -= 1
            lock.unlock()
        }
        let note = try ensureNoteLocked(notePath, initial: readIfPresent(notePath) ?? "")
        if conflicted(notePath) {
            return base
        }
        let edit = TextDiff.diff(from: base, to: edited)
        // A rebuilt note's file is the text on screen, including keystrokes typed while waiting.
        // The sync document is a blank root during a connection attempt, so those keystrokes
        // stay in the file and are what we compare when the relay answers.
        if note.rebuilt {
            let file = readIfPresent(notePath) ?? ""
            let merged = TextDiff.apply(edit, to: file)
            if merged != file {
                try writeFileLocked(notePath, merged)
            }
            if !note.awaitingRelay {
                var updated = note
                try setText(&updated, merged)
                notes[notePath] = updated
                try save(updated)
                trackAndKick(updated.docId)
            }
            return merged
        }
        if edit.delete != 0 || !edit.insert.isEmpty {
            let current = try note.doc.text(obj: note.textObj)
            let remote = TextDiff.diff(from: base, to: current)
            let mapped = TextDiff.map(edit, through: remote)
            let count = Array(current.unicodeScalars).count
            let start = min(max(mapped.start, 0), count)
            let delete = min(mapped.delete, count - start)
            if delete != 0 || !mapped.insert.isEmpty {
                try note.doc.spliceText(
                    obj: note.textObj,
                    start: UInt64(start),
                    delete: Int64(delete),
                    value: mapped.insert.isEmpty ? nil : mapped.insert
                )
                note.doc.commitWith()
            }
        }
        notes[notePath] = note
        try save(note)
        let merged = try note.doc.text(obj: note.textObj)
        try writeFileLocked(notePath, merged)
        trackAndKick(note.docId)
        return merged
    }

    public func conflicts() -> [NoteConflict] {
        lock.lock()
        defer { lock.unlock() }
        return openConflicts
    }

    public func resolve(_ path: String, choice: ConflictChoice) throws {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        defer { lock.unlock() }
        guard let conflict = openConflicts.first(where: { $0.path == notePath }) else { return }
        let chosen: String
        switch choice {
        case .keepMine: chosen = conflict.mine
        case .takeTheirs: chosen = conflict.theirs
        case .edit(let value): chosen = value
        }
        suppressWatch += 1
        defer { suppressWatch -= 1 }
        var note = try ensureNoteLocked(notePath, initial: chosen)
        try setText(&note, chosen)
        note.rebuilt = false
        note.awaitingRelay = false
        notes[notePath] = note
        try save(note)
        try writeFileLocked(notePath, chosen)
        openConflicts.removeAll { $0.path == notePath }
        try saveMeta()
        trackAndKick(note.docId)
    }

    public func connect(relayURL: String, token: String) throws {
        let trimmed = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { throw AidanError.authRejected }
        lock.lock()
        desiredURL = relayURL
        desiredToken = trimmed
        reconnectAttempt = 0
        reconnectWork?.cancel()
        lock.unlock()
        setConnection(.connecting)
        do {
            try openLink(url: relayURL, token: trimmed)
        } catch AidanError.authRejected {
            stopTrying()
            throw AidanError.authRejected
        } catch AidanError.payloadTooLarge {
            stopTrying()
            throw AidanError.payloadTooLarge
        } catch {
            setConnection(.reconnecting)
            scheduleReconnect()
            throw error
        }
    }

    public func disconnect() {
        lock.lock()
        desiredURL = nil
        desiredToken = nil
        reconnectWork?.cancel()
        let current = link
        link = nil
        slots = [:]
        lock.unlock()
        current?.close()
        setConnection(.disconnected)
    }

    public func foldOutsideEdits() {
        lock.lock()
        let updates = foldLocked()
        let callback = onText
        lock.unlock()
        for update in updates { callback?(update.0, update.1) }
    }

    func documentIds() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(slots.keys)
    }

    func takeOutgoing(docId: String) -> (type: String, bytes: Data)? {
        lock.lock()
        defer { lock.unlock() }
        guard let slot = slots[docId], let doc = documentLocked(docId) else { return nil }
        guard let message = doc.generateSyncMessage(state: slot.state), !message.isEmpty else { return nil }
        let type = slot.requested ? "sync" : "request"
        slot.requested = true
        return (type, message)
    }

    func applyIncoming(docId: String, bytes: Data) throws {
        lock.lock()
        if docId != DocumentIds.indexId && documentLocked(docId) == nil {
            if let made = try? Self.makeDocument(docId: docId, kind: "note", actor: deviceActor), let textObj = made.1 {
                loose[docId] = NoteState(docId: docId, doc: made.0, textObj: textObj, rebuilt: false)
                if slots[docId] == nil { slots[docId] = SyncSlot() }
            }
        }
        guard let slot = slots[docId], let doc = documentLocked(docId) else {
            lock.unlock()
            return
        }
        let path = pathLocked(for: docId)
        let rebuilt = path.flatMap { notes[$0]?.rebuilt } ?? false
        let blocked = path.map { conflicted($0) } ?? false
        let before = path.flatMap { _ in try? textLocked(docId) }
        try doc.receiveSyncMessage(state: slot.state, message: bytes)
        slot.sawReply = true
        // A partial handshake can arrive before the peer's text. Don't treat
        // the note as empty just because an earlier check saw nothing.
        slot.emptyChecks = 0
        var changed: [(String, String)] = []
        if let path, var note = notes[path] {
            let after = (try? note.doc.text(obj: note.textObj)) ?? ""
            try? save(note)
            if rebuilt {
                let mine = readIfPresent(path) ?? ""
                if !after.isEmpty && after != mine {
                    // The relay's text is here. Compare now, before a later
                    // idle check can upload the file and erase the difference.
                    // `mine` is the file, including anything typed while waiting.
                    note.rebuilt = false
                    note.awaitingRelay = false
                    notes[path] = note
                    openConflicts.removeAll { $0.path == path }
                    openConflicts.append(NoteConflict(
                        path: path,
                        mine: mine,
                        theirs: after,
                        reason: Self.rebuildConflictReason
                    ))
                    try? saveMeta()
                }
            } else if blocked, let index = openConflicts.firstIndex(where: { $0.path == path }),
                      !after.isEmpty, openConflicts[index].theirs != after {
                let old = openConflicts[index]
                openConflicts[index] = NoteConflict(path: old.path, mine: old.mine, theirs: after, reason: old.reason)
                try? saveMeta()
            } else if !blocked && after != before {
                try? writeFileLocked(path, after)
                changed.append((path, after))
            }
        } else if let note = loose[docId] {
            try? save(note)
        }
        if docId == DocumentIds.indexId {
            try? saveIndex()
            changed.append(contentsOf: adoptIndexLocked())
        }
        let callback = onText
        lock.unlock()
        for update in changed { callback?(update.0, update.1) }
    }

    func markUnavailable(docId: String) {
        lock.lock()
        slots[docId]?.unavailable = true
        lock.unlock()
    }

    func settled(docId: String) {
        lock.lock()
        guard let slot = slots[docId], slot.sawReply || slot.unavailable,
              let path = pathLocked(for: docId), var note = notes[path], note.rebuilt else {
            lock.unlock()
            return
        }
        let remote = (try? note.doc.text(obj: note.textObj)) ?? ""
        let mine = readIfPresent(path) ?? ""
        let caughtUp = peerCaughtUp(slot, note)
        if remote == mine && (caughtUp || !remote.isEmpty) {
            note.rebuilt = false
            note.awaitingRelay = false
            notes[path] = note
            openConflicts.removeAll { $0.path == path }
            try? save(note)
            try? saveMeta()
            lock.unlock()
            return
        }
        if remote.isEmpty {
            // An empty document here is usually the handshake, not the peer's
            // note. Uploading now would clear `rebuilt`, and the real text
            // would merge over the file instead of raising a conflict.
            let attempts = slot.emptyChecks + 1
            slot.emptyChecks = attempts
            let peerHasNothing = slot.unavailable && !slot.sawReply && attempts >= 8
            // Heads can match the shared root before the peer's text arrives.
            // Wait through a quiet period instead of uploading on that match.
            let peerDocIsEmpty = caughtUp && attempts >= 40
            if !peerHasNothing && !peerDocIsEmpty {
                lock.unlock()
                let active = link
                DispatchQueue.global().asyncAfter(deadline: .now() + 0.25) {
                    active?.kick(docId)
                }
                return
            }
            try? setText(&note, mine)
            note.rebuilt = false
            note.awaitingRelay = false
            notes[path] = note
            try? save(note)
            try? writeFileLocked(path, mine)
            try? saveMeta()
            let id = note.docId
            lock.unlock()
            link?.kick(id)
            return
        }
        let conflict = NoteConflict(
            path: path,
            mine: mine,
            theirs: remote,
            reason: Self.rebuildConflictReason
        )
        note.rebuilt = false
        note.awaitingRelay = false
        notes[path] = note
        openConflicts.removeAll { $0.path == path }
        openConflicts.append(conflict)
        try? save(note)
        try? saveMeta()
        lock.unlock()
    }

    func linkClosed() {
        DispatchQueue.global().async { [weak self] in
            self?.handleDrop()
        }
    }

    func linkFailed(_ error: Error) {
        guard Self.isTerminal(error) else {
            linkClosed()
            return
        }
        lock.lock()
        desiredURL = nil
        desiredToken = nil
        reconnectWork?.cancel()
        let callback = onError
        lock.unlock()
        setConnection(.disconnected)
        callback?(String(describing: error))
    }

    private func openLink(url: String, token: String) throws {
        lock.lock()
        if opening {
            lock.unlock()
            return
        }
        opening = true
        let next = RelayLink()
        link?.close()
        link = next
        slots = [DocumentIds.indexId: SyncSlot()]
        do {
            for path in Array(notes.keys) {
                var note = notes[path]!
                if note.rebuilt {
                    let fresh = try AidanSession.makeDocument(docId: note.docId, kind: "note", actor: deviceActor)
                    note.doc = fresh.0
                    note.textObj = fresh.1!
                    note.awaitingRelay = true
                    notes[path] = note
                }
                slots[note.docId] = SyncSlot()
            }
            for docId in loose.keys {
                slots[docId] = SyncSlot()
            }
            try saveMeta()
        } catch {
            restoreAwaitingLocked()
            opening = false
            lock.unlock()
            throw error
        }
        let peer = peerId
        let storage = storageId
        lock.unlock()
        defer {
            lock.lock()
            opening = false
            lock.unlock()
        }
        do {
            try next.connect(url: url, token: token, peerId: peer, storageId: storage, host: self)
            lock.lock()
            reconnectAttempt = 0
            lock.unlock()
            setConnection(.connected)
        } catch {
            next.close()
            lock.lock()
            restoreAwaitingLocked()
            lock.unlock()
            throw error
        }
    }

    /// A note that is rebuilt from the file keeps that file, including keystrokes, when a connection attempt fails.
    private func restoreAwaitingLocked() {
        for path in Array(notes.keys) {
            guard var note = notes[path], note.awaitingRelay else { continue }
            let file = readIfPresent(path) ?? ""
            if let made = try? Self.makeDocument(docId: note.docId, kind: "note", actor: deviceActor), let textObj = made.1 {
                note.doc = made.0
                note.textObj = textObj
            }
            try? setText(&note, file)
            note.awaitingRelay = false
            notes[path] = note
            try? save(note)
        }
    }

    private func stopTrying() {
        lock.lock()
        desiredURL = nil
        desiredToken = nil
        reconnectWork?.cancel()
        storedConnection = .disconnected
        lock.unlock()
    }

    private static func isTerminal(_ error: Error) -> Bool {
        if case AidanError.payloadTooLarge = error { return true }
        if case AidanError.authRejected = error { return true }
        return false
    }

    /// The relay's note folder and its data folder are not an app vault.
    private static func looksLikeRelayFolder(_ vault: URL) -> Bool {
        let manager = FileManager.default
        if manager.fileExists(atPath: vault.appendingPathComponent(".aidanos/relay-folder").path) {
            return true
        }
        if manager.fileExists(atPath: vault.appendingPathComponent("relay-folder").path) {
            return true
        }
        var isDirectory: ObjCBool = false
        let nested = vault.appendingPathComponent(".aidanos/relay").path
        if manager.fileExists(atPath: nested, isDirectory: &isDirectory), isDirectory.boolValue {
            return true
        }
        return false
    }

    private func handleDrop() {
        lock.lock()
        let wanted = desiredURL != nil
        lock.unlock()
        guard wanted else { return }
        setConnection(.reconnecting)
        scheduleReconnect()
    }

    private func scheduleReconnect() {
        lock.lock()
        reconnectWork?.cancel()
        let attempt = reconnectAttempt
        reconnectAttempt += 1
        let pause = min(30, reconnectPause * pow(2.0, Double(min(attempt, 5))))
        guard desiredURL != nil, desiredToken != nil else {
            lock.unlock()
            return
        }
        let work = DispatchWorkItem { [weak self] in
            self?.retry()
        }
        reconnectWork = work
        lock.unlock()
        DispatchQueue.global().asyncAfter(deadline: .now() + pause, execute: work)
    }

    private func retry() {
        lock.lock()
        let url = desiredURL
        let token = desiredToken
        lock.unlock()
        guard let url, let token else { return }
        setConnection(.reconnecting)
        do {
            try openLink(url: url, token: token)
        } catch AidanError.authRejected {
            lock.lock()
            desiredURL = nil
            desiredToken = nil
            lock.unlock()
            setConnection(.disconnected)
        } catch AidanError.payloadTooLarge {
            stopTrying()
            setConnection(.disconnected)
            lock.lock()
            let callback = onError
            lock.unlock()
            callback?(String(describing: AidanError.payloadTooLarge))
        } catch {
            scheduleReconnect()
        }
    }

    private func setConnection(_ state: ConnectionState) {
        lock.lock()
        storedConnection = state
        let callback = onConnection
        lock.unlock()
        callback?(state)
    }

    private func loadFromDisk() throws {
        let files = try VaultPaths.markdownFiles(in: vault)
        for path in files {
            let text = readIfPresent(path) ?? ""
            _ = try ensureNoteLocked(path, initial: text, fromFile: true)
        }
    }

    @discardableResult
    private func ensureNoteLocked(_ path: String, initial: String, fromFile: Bool = false) throws -> NoteState {
        if var existing = notes[path] {
            if fromFile && !existing.rebuilt && !conflicted(path) {
                let current = try existing.doc.text(obj: existing.textObj)
                if current != initial && writtenHash[path] != Self.sha(initial) {
                    try setText(&existing, initial)
                    notes[path] = existing
                    try save(existing)
                }
            }
            return notes[path]!
        }
        let docId = DocumentIds.noteId(path)
        if let pending = loose.removeValue(forKey: docId) {
            notes[path] = pending
            try remember(path: path, docId: docId)
            return pending
        }
        let url = Self.docURL(vault, docId)
        let cached = (try? Data(contentsOf: url)).flatMap { try? Document($0) }
        let note: NoteState
        if let cached, let textObj = try? Self.textObject(cached) {
            cached.actor = deviceActor
            note = NoteState(docId: docId, doc: cached, textObj: textObj, rebuilt: false)
        } else {
            let made = try Self.makeDocument(docId: docId, kind: "note", actor: deviceActor)
            var created = NoteState(docId: docId, doc: made.0, textObj: made.1!, rebuilt: fromFile)
            if !initial.isEmpty {
                try setText(&created, initial)
            }
            note = created
        }
        notes[path] = note
        try remember(path: path, docId: docId)
        try save(note)
        return note
    }

    private func setText(_ note: inout NoteState, _ newText: String) throws {
        let current = try note.doc.text(obj: note.textObj)
        let edit = TextDiff.diff(from: current, to: newText)
        if edit.delete == 0 && edit.insert.isEmpty { return }
        try note.doc.spliceText(
            obj: note.textObj,
            start: UInt64(edit.start),
            delete: Int64(edit.delete),
            value: edit.insert.isEmpty ? nil : edit.insert
        )
        note.doc.commitWith()
    }

    private func remember(path: String, docId: String) throws {
        guard (try? VaultPaths.check(path)) != nil else { return }
        guard let value = try index.get(obj: .ROOT, key: "paths"), case .Object(let map, .Map) = value else {
            throw AidanError.io("The index is missing its path list.")
        }
        if let current = try index.get(obj: map, key: path), case .Scalar(.String(let existing)) = current, existing == docId {
            return
        }
        try index.put(obj: map, key: path, value: .String(docId))
        index.commitWith()
        try saveIndex()
    }

    private func documentLocked(_ docId: String) -> Document? {
        if docId == DocumentIds.indexId { return index }
        if let note = notes.values.first(where: { $0.docId == docId }) { return note.doc }
        return loose[docId]?.doc
    }

    private func pathLocked(for docId: String) -> String? {
        notes.first { $0.value.docId == docId }?.key
    }

    private func textLocked(_ docId: String) throws -> String? {
        guard let path = pathLocked(for: docId), let note = notes[path] else { return nil }
        return try note.doc.text(obj: note.textObj)
    }

    private func conflicted(_ path: String) -> Bool {
        openConflicts.contains { $0.path == path }
    }

    private func writeFileLocked(_ path: String, _ text: String) throws {
        let url = try VaultPaths.fileURL(vault: vault, path: path)
        try AtomicFile.write(Data(text.utf8), to: url)
        lastWritten[path] = text
        writtenHash[path] = Self.sha(text)
        persistWritten()
    }

    private func readIfPresent(_ path: String) -> String? {
        guard let url = try? VaultPaths.fileURL(vault: vault, path: path) else { return nil }
        return try? String(contentsOf: url, encoding: .utf8)
    }

    private func save(_ note: NoteState) throws {
        try AtomicFile.write(note.doc.save(), to: Self.docURL(vault, note.docId))
    }

    private func saveIndex() throws {
        try AtomicFile.write(index.save(), to: Self.indexURL(vault))
    }

    private func saveMeta() throws {
        let payload = MetaFile(
            rebuilt: notes.filter { $0.value.rebuilt }.map(\.key).sorted(),
            conflicts: openConflicts.map {
                MetaConflict(path: $0.path, mine: $0.mine, theirs: $0.theirs, reason: $0.reason)
            }
        )
        let data = try JSONEncoder().encode(payload)
        try AtomicFile.write(data, to: vault.appendingPathComponent(".aidanos/meta.json"))
    }

    private func loadMeta() {
        let url = vault.appendingPathComponent(".aidanos/meta.json")
        guard let data = try? Data(contentsOf: url),
              let meta = try? JSONDecoder().decode(MetaFile.self, from: data) else { return }
        for path in meta.rebuilt {
            if var note = notes[path] {
                note.rebuilt = true
                notes[path] = note
            }
        }
        openConflicts = meta.conflicts.map {
            NoteConflict(path: $0.path, mine: $0.mine, theirs: $0.theirs, reason: $0.reason)
        }
    }

    private func indexPairsLocked() -> [(String, String)] {
        guard let value = try? index.get(obj: .ROOT, key: "paths"), case .Object(let map, .Map) = value else { return [] }
        var pairs: [(String, String)] = []
        for key in index.keys(obj: map) {
            guard (try? VaultPaths.check(key)) != nil else { continue }
            if let current = try? index.get(obj: map, key: key), case .Scalar(.String(let docId)) = current {
                pairs.append((key, docId))
            }
        }
        return pairs
    }

    private func adoptIndexLocked() -> [(String, String)] {
        var updates: [(String, String)] = []
        for (path, docId) in indexPairsLocked() where notes[path] == nil {
            if let pending = loose.removeValue(forKey: docId) {
                notes[path] = pending
                let text = (try? pending.doc.text(obj: pending.textObj)) ?? ""
                try? save(pending)
                if !text.isEmpty { try? writeFileLocked(path, text) }
                if slots[docId] == nil { slots[docId] = SyncSlot() }
                updates.append((path, text))
            } else if let note = try? ensureNoteLocked(path, initial: readIfPresent(path) ?? "") {
                if slots[note.docId] == nil { slots[note.docId] = SyncSlot() }
                let active = link
                let id = note.docId
                DispatchQueue.global().async { active?.kick(id) }
            }
        }
        return updates
    }

    private func trackAndKick(_ docId: String) {
        if link != nil {
            if slots[docId] == nil { slots[docId] = SyncSlot() }
            if slots[DocumentIds.indexId] == nil { slots[DocumentIds.indexId] = SyncSlot() }
        }
        let active = link
        DispatchQueue.global().async {
            active?.kick(docId)
            active?.kick(DocumentIds.indexId)
        }
    }

    private func foldLocked() -> [(String, String)] {
        if suppressWatch > 0 { return [] }
        var updates: [(String, String)] = []
        var dirty = false
        let files = (try? VaultPaths.markdownFiles(in: vault)) ?? []
        for path in files {
            guard let fileText = readIfPresent(path) else { continue }
            let fileHash = Self.sha(fileText)
            if writtenHash[path] == fileHash {
                lastWritten[path] = fileText
                if let note = notes[path], !note.rebuilt, !conflicted(path) {
                    let current = (try? note.doc.text(obj: note.textObj)) ?? ""
                    if current != fileText { try? writeFileLocked(path, current) }
                }
                continue
            }
            if lastWritten[path] == fileText { continue }
            guard var note = notes[path] else {
                if (try? ensureNoteLocked(path, initial: fileText, fromFile: true)) != nil {
                    updates.append((path, fileText))
                }
                continue
            }
            if conflicted(path) || note.rebuilt { continue }
            let current = (try? note.doc.text(obj: note.textObj)) ?? ""
            if current == fileText {
                lastWritten[path] = fileText
                writtenHash[path] = fileHash
                dirty = true
                continue
            }
            if (try? setText(&note, fileText)) != nil {
                notes[path] = note
                lastWritten[path] = fileText
                writtenHash[path] = fileHash
                dirty = true
                try? save(note)
                updates.append((path, fileText))
                let docId = note.docId
                let active = link
                DispatchQueue.global().async { active?.kick(docId) }
            }
        }
        if dirty { persistWritten() }
        let known = Set(files)
        for path in notes.keys where !known.contains(path) {
            let text = (try? notes[path]?.doc.text(obj: notes[path]!.textObj)) ?? ""
            if text.isEmpty || lastWritten[path] == nil { continue }
            if conflicted(path) { continue }
            openConflicts.append(NoteConflict(
                path: path,
                mine: "",
                theirs: text,
                reason: "The file was deleted on this device while the synced note still has text."
            ))
        }
        return updates
    }

    private func startWatcher() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "aidanos.watch"))
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let updates = self.foldLocked()
            let callback = self.onText
            self.lock.unlock()
            for update in updates { callback?(update.0, update.1) }
        }
        timer.resume()
        watcher = timer
    }

    private static func sha(_ text: String) -> String {
        Digests.sha256Hex(text)
    }

    private static func loadWritten(in vault: URL) -> [String: String] {
        let url = vault.appendingPathComponent(".aidanos/written.json")
        guard let data = try? Data(contentsOf: url),
              let parsed = try? JSONDecoder().decode([String: String].self, from: data) else { return [:] }
        return parsed
    }

    private func persistWritten() {
        guard let data = try? JSONEncoder().encode(writtenHash) else { return }
        try? AtomicFile.write(data, to: vault.appendingPathComponent(".aidanos/written.json"))
    }

    private static func makeDocument(docId: String, kind: String, actor: ActorId) throws -> (Document, ObjId?) {
        let doc = Document(textEncoding: .unicodeScalar)
        guard let root = ActorId(data: DocumentIds.rootActor(documentId: docId)) else {
            throw AidanError.io("Could not start a note.")
        }
        doc.actor = root
        try doc.put(obj: .ROOT, key: "kind", value: .String(kind))
        let textObj: ObjId?
        if kind == "note" {
            textObj = try doc.putObject(obj: .ROOT, key: "text", ty: .Text)
        } else {
            _ = try doc.putObject(obj: .ROOT, key: "paths", ty: .Map)
            textObj = nil
        }
        doc.commitWith(message: "aidanos-root", timestamp: Date(timeIntervalSince1970: 0))
        doc.actor = actor
        return (doc, textObj)
    }

    private static func textObject(_ doc: Document) throws -> ObjId {
        guard let value = try doc.get(obj: .ROOT, key: "text"), case .Object(let id, .Text) = value else {
            throw AidanError.io("This note's history has no text.")
        }
        return id
    }

    private static func loadActor(in vault: URL) throws -> ActorId {
        let url = vault.appendingPathComponent(".aidanos/actor")
        if let data = try? Data(contentsOf: url), let actor = ActorId(data: data) {
            return actor
        }
        var bytes = Data(count: 16)
        for index in 0..<16 { bytes[index] = UInt8.random(in: 0...255) }
        try AtomicFile.write(bytes, to: url)
        guard let actor = ActorId(data: bytes) else { throw AidanError.io("Could not make a device identity.") }
        return actor
    }

    private static func loadStorageId(in vault: URL) throws -> String {
        let url = vault.appendingPathComponent(".aidanos/storage-id")
        if let text = try? String(contentsOf: url, encoding: .utf8), !text.isEmpty {
            return text.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        let text = UUID().uuidString.lowercased()
        try AtomicFile.write(Data(text.utf8), to: url)
        return text
    }

    private static func indexURL(_ vault: URL) -> URL {
        vault.appendingPathComponent(".aidanos/index")
    }

    private static func docURL(_ vault: URL, _ docId: String) -> URL {
        vault.appendingPathComponent(".aidanos/docs/\(docId)")
    }
}

private final class SyncSlot {
    var state = SyncState()
    var requested = false
    var sawReply = false
    var unavailable = false
    var emptyChecks = 0
}

private func peerCaughtUp(_ slot: SyncSlot, _ note: NoteState) -> Bool {
    guard slot.sawReply, let theirs = slot.state.theirHeads, !theirs.isEmpty else { return false }
    return theirs.isSubset(of: note.doc.heads())
}

private struct NoteState {
    var docId: String
    var doc: Document
    var textObj: ObjId
    var rebuilt: Bool
    var awaitingRelay = false
}

private struct MetaFile: Codable {
    var rebuilt: [String]
    var conflicts: [MetaConflict]
}

private struct MetaConflict: Codable {
    var path: String
    var mine: String
    var theirs: String
    var reason: String
}
