import AidanCore
import Foundation
import Security
import SwiftUI

enum RelayTokenStore {
    private static let service = "aidanos.relay-token"
    private static let account = "token"

    static func load() -> String {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)
        guard status == errSecSuccess, let data = item as? Data, let text = String(data: data, encoding: .utf8) else {
            return ""
        }
        return text
    }

    @discardableResult
    static func save(_ token: String) -> Bool {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let value: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let updated = SecItemUpdate(query as CFDictionary, value as CFDictionary)
        if updated == errSecSuccess { return true }
        if updated == errSecItemNotFound {
            var add = query
            for (key, item) in value { add[key] = item }
            let added = SecItemAdd(add as CFDictionary, nil)
            if added == errSecSuccess { return true }
            NSLog("AidanOS could not save the relay token (%d). The previous token is unchanged.", Int(added))
            return false
        }
        NSLog("AidanOS could not update the relay token (%d). The previous token is unchanged.", Int(updated))
        return false
    }
}

@MainActor
final class TodayModel: ObservableObject {
    @Published var text = ""
    @Published var address: String
    @Published var token: String
    @Published var status = "Not connected"
    @Published var notice = ""
    @Published var conflict: NoteConflict?
    @Published var draftingConflict = false
    @Published var context: ExternalNoteContext = .project

    private var session: AidanSession?
    private var surface: NoteSurface?
    private var editor = LiveNoteEditor()
    private var path: String
    private var applyingRemote = false
    private var dayTimer: Timer?

    init() {
        let defaults = UserDefaults.standard
        address = defaults.string(forKey: "aidanos.relayAddress") ?? "ws://127.0.0.1:3750"
        let stored = RelayTokenStore.load()
        if stored.isEmpty, let old = defaults.string(forKey: "aidanos.relayToken"), !old.isEmpty {
            token = old
            if RelayTokenStore.save(old) {
                defaults.removeObject(forKey: "aidanos.relayToken")
            }
        } else {
            token = stored
        }
        path = AidanSession.todayPath()
        context = EditorNoteContext.forPath(path)
        do {
            let session = try AidanSession(vault: TodayModel.vaultURL())
            self.session = session
            text = try session.open(path)
            editor = LiveNoteEditor(text: text, context: context)
            let surface = NoteSurface(session: session, path: path, text: text)
            self.surface = surface
            conflict = surface.conflict
            session.onText = { [weak self] notePath, value in
                Task { @MainActor in
                    guard let self, notePath == self.path, !self.draftingConflict else { return }
                    self.applyingRemote = true
                    self.text = value
                    self.editor.reset(value)
                    self.editor.context = self.context
                    self.surface?.replaceText(value)
                    self.notice = ""
                    self.applyingRemote = false
                    self.publishConflict()
                }
            }
            session.onConnection = { [weak self] state in
                Task { @MainActor in
                    self?.status = state.label
                }
            }
            session.onError = { [weak self] message in
                Task { @MainActor in
                    self?.status = message
                }
            }
            session.onConflict = { [weak self] in
                Task { @MainActor in
                    self?.publishConflict()
                }
            }
        } catch {
            status = String(describing: error)
        }
        publishConflict()
        dayTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.considerDay() }
        }
    }

    func considerDay(now: Date = Date()) {
        guard let next = AidanSession.changedDay(from: path, now: now) else { return }
        path = next
        context = EditorNoteContext.forPath(next)
        draftingConflict = false
        notice = ""
        guard let session else { return }
        applyingRemote = true
        let opened = (try? session.open(next)) ?? ""
        text = opened
        editor = LiveNoteEditor(text: opened, context: context)
        surface?.focus(path: next, text: opened)
        applyingRemote = false
        publishConflict()
    }

    func userEdited(base: String, edited: String) {
        guard !applyingRemote, let surface else {
            if conflict != nil && !draftingConflict { return }
            text = edited
            return
        }
        if editor.text != base { editor.reset(base) }
        editor.context = context
        let kept = editor.type(edited)
        let merged = surface.userEdited(base: base, edited: kept)
        if merged != kept {
            editor.reset(merged)
            editor.context = context
        }
        applyingRemote = true
        text = merged
        applyingRemote = false
        conflict = surface.conflict
        draftingConflict = surface.draftingConflict
        if surface.statusMessage != nil {
            status = "Unsaved"
            notice = "This change is kept on this device."
            surface.clearStatus()
        } else if merged == kept {
            notice = ""
            if status == "Unsaved" { status = "Saved" }
        }
    }

    func connect() {
        UserDefaults.standard.set(address, forKey: "aidanos.relayAddress")
        if RelayTokenStore.save(token) {
            UserDefaults.standard.removeObject(forKey: "aidanos.relayToken")
        }
        guard let session else { return }
        status = ConnectionState.connecting.label
        let url = address
        let secret = token
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            do {
                try session.connect(relayURL: url, token: secret)
                Task { @MainActor in self?.publishConflict() }
            } catch {
                Task { @MainActor in
                    guard let self else { return }
                    if self.status == ConnectionState.connecting.label {
                        self.status = String(describing: error)
                    }
                    self.publishConflict()
                }
            }
        }
    }

    func beginConflictEdit() {
        guard let surface, surface.conflict != nil else { return }
        surface.beginDraft()
        draftingConflict = true
        applyingRemote = true
        text = surface.text
        applyingRemote = false
    }

    func saveConflictEdit() {
        guard draftingConflict, let session else { return }
        do {
            try session.resolve(path, choice: .edit(text))
            surface?.clearDraft()
            draftingConflict = false
            applyingRemote = true
            text = try session.text(path)
            surface?.replaceText(text)
            applyingRemote = false
            status = "Saved"
        } catch {
            status = String(describing: error)
        }
        publishConflict()
    }

    func choose(_ choice: ConflictChoice) {
        guard let session else { return }
        surface?.clearDraft()
        draftingConflict = false
        do {
            try session.resolve(path, choice: choice)
            applyingRemote = true
            text = try session.text(path)
            surface?.replaceText(text)
            applyingRemote = false
        } catch {
            status = String(describing: error)
        }
        publishConflict()
    }

    private func publishConflict() {
        surface?.showChoiceIfNeeded()
        conflict = surface?.conflict
    }

    private static func vaultURL() -> URL {
        #if os(macOS)
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("AidanOS/vault", isDirectory: true)
        #else
        let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSTemporaryDirectory())
        return base.appendingPathComponent("vault", isDirectory: true)
        #endif
    }
}
