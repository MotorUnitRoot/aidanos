import AidanCore
import Foundation
import SwiftUI

@MainActor
final class TodayModel: ObservableObject {
    @Published var text = ""
    @Published var address: String
    @Published var token: String
    @Published var status = "Not connected"
    @Published var conflict: NoteConflict?

    private var session: AidanSession?
    private let path: String
    private var applyingRemote = false

    init() {
        let defaults = UserDefaults.standard
        address = defaults.string(forKey: "aidanos.relayAddress") ?? "ws://127.0.0.1:3750"
        token = defaults.string(forKey: "aidanos.relayToken") ?? ""
        path = AidanSession.todayPath()
        do {
            let session = try AidanSession(vault: TodayModel.vaultURL())
            self.session = session
            text = try session.open(path)
            session.onText = { [weak self] notePath, value in
                guard let self, notePath == self.path else { return }
                Task { @MainActor in
                    self.applyingRemote = true
                    self.text = value
                    self.applyingRemote = false
                    self.refreshConflict()
                }
            }
        } catch {
            status = String(describing: error)
        }
        refreshConflict()
    }

    func userEdited(_ value: String) {
        text = value
        guard !applyingRemote, let session else { return }
        do {
            try session.replace(path, with: value)
        } catch {
            status = String(describing: error)
        }
    }

    func connect() {
        UserDefaults.standard.set(address, forKey: "aidanos.relayAddress")
        UserDefaults.standard.set(token, forKey: "aidanos.relayToken")
        guard let session else { return }
        do {
            try session.connect(relayURL: address, token: token)
            status = "Connected"
        } catch {
            status = String(describing: error)
        }
        refreshConflict()
    }

    func choose(_ choice: ConflictChoice) {
        guard let session else { return }
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
