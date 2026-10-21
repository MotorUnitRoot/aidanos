import SwiftUI

@main
struct AidanOSApp: App {
    var body: some Scene {
        WindowGroup {
            TodayScreen()
        }
    }
}

struct TodayScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = TodayModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.status)
                .font(.caption)
            TextField("Relay address", text: $model.address)
                .textFieldStyle(.roundedBorder)
            SecureField("Token", text: $model.token)
                .textFieldStyle(.roundedBorder)
            Button("Connect") { model.connect() }
            if let conflict = model.conflict {
                Text(conflict.reason)
                    .font(.caption)
                HStack {
                    Button("Keep mine") { model.choose(.keepMine) }
                    Button("Take theirs") { model.choose(.takeTheirs) }
                    Button("Edit") { model.beginConflictEdit() }
                }
                if model.draftingConflict {
                    Button("Save edit") { model.saveConflictEdit() }
                }
            }
            NoteEditor(text: $model.text, editable: model.conflict == nil || model.draftingConflict) { base, edited in
                model.userEdited(base: base, edited: edited)
            }
        }
        .padding()
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.considerDay() }
        }
    }
}
