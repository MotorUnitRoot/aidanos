import Automerge
import Foundation

/// One vault, its markdown files, and the Automerge histories beside them.
public final class AidanSession: SyncHost {
    public let vault: URL
    public var onText: ((String, String) -> Void)?

    private let lock = NSLock()
    private let deviceActor: ActorId
    private var index: Document
    private var notes: [String: NoteState] = [:]
    private var slots: [String: SyncSlot] = [:]
    private var openConflicts: [NoteConflict] = []
    private var lastWritten: [String: String] = [:]
    private var suppressWatch = 0
    private var link: RelayLink?
    private var watcher: DispatchSourceTimer?
    private let peerId: String
    private let storageId: String

    public init(vault: URL) throws {
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
        try loadFromDisk()
        try saveIndex()
        for note in notes.values { try save(note) }
        startWatcher()
    }

    public static func todayPath(on date: Date = Date(), timeZone: TimeZone = .current) -> String {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "log/%04d-%02d-%02d.md", parts.year ?? 1970, parts.month ?? 1, parts.day ?? 1)
    }

    public func open(_ path: String) throws -> String {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        defer { lock.unlock() }
        let note = try ensureNoteLocked(notePath, initial: readIfPresent(notePath) ?? "")
        let text = try note.doc.text(obj: note.textObj)
        try writeFileLocked(notePath, text)
        return text
    }

    public func text(_ path: String) throws -> String {
        let notePath = try VaultPaths.check(path)
        lock.lock()
        defer { lock.unlock() }
        guard let note = notes[notePath] else { return "" }
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
        try writeFileLocked(notePath, text)
        try save(note)
        let docId = note.docId
        DispatchQueue.global().async { [weak self] in
            self?.link?.kick(docId)
        }
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
        notes[notePath] = note
        try writeFileLocked(notePath, chosen)
        try save(note)
        openConflicts.removeAll { $0.path == notePath }
        try saveMeta()
        let docId = note.docId
        DispatchQueue.global().async { [weak self] in
            self?.link?.kick(docId)
        }
    }

    public func connect(relayURL: String, token: String) throws {
        if token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            throw AidanError.authRejected
        }
        lock.lock()
        link?.close()
        let next = RelayLink()
        link = next
        slots = [DocumentIds.indexId: SyncSlot()]
        for path in Array(notes.keys) {
            var note = notes[path]!
            if note.rebuilt {
                let fresh = try AidanSession.makeDocument(docId: note.docId, kind: "note", actor: deviceActor)
                note.doc = fresh.0
                note.textObj = fresh.1!
                notes[path] = note
            }
            slots[note.docId] = SyncSlot()
        }
        let peer = peerId
        let storage = storageId
        lock.unlock()
        do {
            try next.connect(url: relayURL, token: token, peerId: peer, storageId: storage, host: self)
        } catch {
            next.close()
            throw error
        }
    }

    public func disconnect() {
        lock.lock()
        let current = link
        link = nil
        slots = [:]
        lock.unlock()
        current?.close()
    }

    public func foldOutsideEdits() {
        lock.lock()
        foldLocked()
        lock.unlock()
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
        guard let slot = slots[docId], let doc = documentLocked(docId) else {
            lock.unlock()
            return
        }
        let path = pathLocked(for: docId)
        let before = path.flatMap { _ in try? textLocked(docId) }
        try doc.receiveSyncMessage(state: slot.state, message: bytes)
        slot.sawReply = true
        var callback: ((String, String) -> Void)?
        var changed: (String, String)?
        if let path, let after = try? textLocked(docId), after != before {
            suppressWatch += 1
            try writeFileLocked(path, after)
            suppressWatch -= 1
            if let note = notes[path] {
                try save(note)
            }
            callback = onText
            changed = (path, after)
        }
        try saveIndex()
        lock.unlock()
        if let changed { callback?(changed.0, changed.1) }
    }

    func markUnavailable(docId: String) {
        lock.lock()
        slots[docId]?.sawReply = true
        lock.unlock()
    }

    func settled(docId: String) {
        lock.lock()
        let ready = slots[docId]?.sawReply == true
        guard ready, let path = pathLocked(for: docId), var note = notes[path], note.rebuilt else {
            lock.unlock()
            return
        }
        let remote = (try? note.doc.text(obj: note.textObj)) ?? ""
        let mine = readIfPresent(path) ?? ""
        if remote == mine {
            note.rebuilt = false
            notes[path] = note
            openConflicts.removeAll { $0.path == path }
            try? save(note)
            try? saveMeta()
            lock.unlock()
            return
        }
        if remote.isEmpty {
            try? setText(&note, mine)
            note.rebuilt = false
            notes[path] = note
            try? writeFileLocked(path, mine)
            try? save(note)
            try? saveMeta()
            let id = note.docId
            lock.unlock()
            link?.kick(id)
            return
        }
        note.rebuilt = false
        notes[path] = note
        let conflict = NoteConflict(
            path: path,
            mine: mine,
            theirs: remote,
            reason: "This device rebuilt the note from the file, and the relay already has different text. Choosing automatically would wipe one side."
        )
        openConflicts.removeAll { $0.path == path }
        openConflicts.append(conflict)
        try? save(note)
        try? saveMeta()
        lock.unlock()
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
            if fromFile {
                let current = try existing.doc.text(obj: existing.textObj)
                if current != initial && !existing.rebuilt && openConflicts.contains(where: { $0.path == path }) == false {
                    try setText(&existing, initial)
                    notes[path] = existing
                    try save(existing)
                }
            }
            return notes[path]!
        }
        let docId = DocumentIds.noteId(path)
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
        return notes.values.first { $0.docId == docId }?.doc
    }

    private func pathLocked(for docId: String) -> String? {
        notes.first { $0.value.docId == docId }?.key
    }

    private func textLocked(_ docId: String) throws -> String? {
        guard let path = pathLocked(for: docId), let note = notes[path] else { return nil }
        return try note.doc.text(obj: note.textObj)
    }

    private func writeFileLocked(_ path: String, _ text: String) throws {
        let url = vault.appendingPathComponent(path)
        try AtomicFile.write(Data(text.utf8), to: url)
        lastWritten[path] = text
    }

    private func readIfPresent(_ path: String) -> String? {
        let url = vault.appendingPathComponent(path)
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

    private func foldLocked() {
        if suppressWatch > 0 { return }
        let files = (try? VaultPaths.markdownFiles(in: vault)) ?? []
        for path in files {
            guard let fileText = readIfPresent(path) else { continue }
            if lastWritten[path] == fileText { continue }
            guard var note = notes[path] else {
                if let created = try? ensureNoteLocked(path, initial: fileText, fromFile: true) {
                    notes[path] = created
                }
                continue
            }
            if openConflicts.contains(where: { $0.path == path }) { continue }
            let current = (try? note.doc.text(obj: note.textObj)) ?? ""
            if current == fileText {
                lastWritten[path] = fileText
                continue
            }
            if (try? setText(&note, fileText)) != nil {
                notes[path] = note
                lastWritten[path] = fileText
                try? save(note)
                let docId = note.docId
                DispatchQueue.global().async { [weak self] in self?.link?.kick(docId) }
            }
        }
        let known = Set(files)
        for path in notes.keys where !known.contains(path) {
            let text = (try? notes[path]?.doc.text(obj: notes[path]!.textObj)) ?? ""
            if text.isEmpty || lastWritten[path] == nil { continue }
            if openConflicts.contains(where: { $0.path == path }) { continue }
            openConflicts.append(NoteConflict(
                path: path,
                mine: "",
                theirs: text,
                reason: "The file was deleted on this device while the synced note still has text."
            ))
        }
    }

    private func startWatcher() {
        let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "aidanos.watch"))
        timer.schedule(deadline: .now() + .milliseconds(200), repeating: .milliseconds(200))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            self.lock.lock()
            self.foldLocked()
            self.lock.unlock()
        }
        timer.resume()
        watcher = timer
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
}

private struct NoteState {
    var docId: String
    var doc: Document
    var textObj: ObjId
    var rebuilt: Bool
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
