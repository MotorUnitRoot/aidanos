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
    @StateObject private var model = TodayModel()

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.status)
                .font(.caption)
            TextField("Relay address", text: $model.address)
                .textFieldStyle(.roundedBorder)
            TextField("Token", text: $model.token)
                .textFieldStyle(.roundedBorder)
            Button("Connect") { model.connect() }
            if let conflict = model.conflict {
                Text(conflict.reason)
                    .font(.caption)
                HStack {
                    Button("Keep mine") { model.choose(.keepMine) }
                    Button("Take theirs") { model.choose(.takeTheirs) }
                }
            }
            NoteEditor(text: $model.text) { model.userEdited($0) }
        }
        .padding()
    }
}
