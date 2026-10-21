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

    static func save(_ token: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
        var add = query
        add[kSecValueData as String] = Data(token.utf8)
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(add as CFDictionary, nil)
    }
}

@MainActor
final class TodayModel: ObservableObject {
    @Published var text = ""
    @Published var address: String
    @Published var token: String
    @Published var status = "Not connected"
    @Published var conflict: NoteConflict?
    @Published var draftingConflict = false

    private var session: AidanSession?
    private var path: String
    private var applyingRemote = false
    private var dayTimer: Timer?

    init() {
        let defaults = UserDefaults.standard
        address = defaults.string(forKey: "aidanos.relayAddress") ?? "ws://127.0.0.1:3750"
        let stored = RelayTokenStore.load()
        if stored.isEmpty, let old = defaults.string(forKey: "aidanos.relayToken"), !old.isEmpty {
            token = old
            RelayTokenStore.save(old)
            defaults.removeObject(forKey: "aidanos.relayToken")
        } else {
            token = stored
        }
        path = AidanSession.todayPath()
        do {
            let session = try AidanSession(vault: TodayModel.vaultURL())
            self.session = session
            text = try session.open(path)
            session.onText = { [weak self] notePath, value in
                Task { @MainActor in
                    guard let self, notePath == self.path, !self.draftingConflict else { return }
                    self.applyingRemote = true
                    self.text = value
                    self.applyingRemote = false
                    self.refreshConflict()
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
        } catch {
            status = String(describing: error)
        }
        refreshConflict()
        dayTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.considerDay() }
        }
    }

    func considerDay(now: Date = Date()) {
        guard let next = AidanSession.changedDay(from: path, now: now) else { return }
        path = next
        draftingConflict = false
        guard let session else { return }
        applyingRemote = true
        text = (try? session.open(next)) ?? ""
        applyingRemote = false
        refreshConflict()
    }

    func userEdited(base: String, edited: String) {
        if conflict != nil && !draftingConflict {
            return
        }
        if draftingConflict {
            text = edited
            return
        }
        guard !applyingRemote, let session else {
            text = edited
            return
        }
        do {
            let merged = try session.applyEdit(path, from: base, to: edited)
            applyingRemote = true
            text = merged
            applyingRemote = false
            refreshConflict()
        } catch {
            status = String(describing: error)
        }
    }

    func connect() {
        UserDefaults.standard.set(address, forKey: "aidanos.relayAddress")
        RelayTokenStore.save(token)
        UserDefaults.standard.removeObject(forKey: "aidanos.relayToken")
        guard let session else { return }
        status = ConnectionState.connecting.label
        do {
            try session.connect(relayURL: address, token: token)
        } catch {
            if status == ConnectionState.connecting.label {
                status = String(describing: error)
            }
        }
        refreshConflict()
    }

    func beginConflictEdit() {
        guard let conflict else { return }
        draftingConflict = true
        applyingRemote = true
        text = ConflictDraft.bothVersions(mine: conflict.mine, theirs: conflict.theirs)
        applyingRemote = false
    }

    func saveConflictEdit() {
        guard draftingConflict, let session else { return }
        do {
            try session.resolve(path, choice: .edit(text))
            draftingConflict = false
            applyingRemote = true
            text = try session.text(path)
            applyingRemote = false
            status = "Saved"
        } catch {
            status = String(describing: error)
        }
        refreshConflict()
    }

    func choose(_ choice: ConflictChoice) {
        guard let session else { return }
        draftingConflict = false
        do {
            try session.resolve(path, choice: choice)
            applyingRemote = true
            text = try session.text(path)
            applyingRemote = false
        } catch {
            status = String(describing: error)
        }
        refreshConflict()
    }

    private func refreshConflict() {
        conflict = session?.conflicts().first { $0.path == path }
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
