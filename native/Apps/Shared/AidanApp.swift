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
    @FocusState private var findFocused: Bool
    @State private var findQuery = ""

    private let cream = Color(red: 242 / 255, green: 238 / 255, blue: 230 / 255)
    private let quiet = Color(red: 154 / 255, green: 148 / 255, blue: 136 / 255)
    private let charcoal = Color(red: 22 / 255, green: 21 / 255, blue: 19 / 255)
    private let hairline = Color(red: 44 / 255, green: 42 / 255, blue: 38 / 255)

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Today")
                    .font(.custom("Georgia", size: 15))
                Spacer()
                Text(model.status)
                    .font(.custom("Georgia", size: 13))
                    .foregroundStyle(quiet)
            }
            if !model.notice.isEmpty {
                Text(model.notice)
                    .font(.custom("Georgia", size: 15))
                    .foregroundStyle(quiet)
            }
            TextField("Relay address", text: $model.address)
                .textFieldStyle(.plain)
                .font(.custom("Georgia", size: 15))
            SecureField("Token", text: $model.token)
                .textFieldStyle(.plain)
                .font(.custom("Georgia", size: 15))
            Button("Connect") { model.connect() }
                .font(.custom("Georgia", size: 15))
                .buttonStyle(.plain)
            if let conflict = model.conflict {
                Text(conflict.reason)
                    .font(.custom("Georgia", size: 15))
                    .foregroundStyle(quiet)
                HStack {
                    Button("Keep mine") { model.choose(.keepMine) }
                    Button("Take theirs") { model.choose(.takeTheirs) }
                    Button("Edit") { model.beginConflictEdit() }
                }
                .font(.custom("Georgia", size: 15))
                .buttonStyle(.plain)
                if model.draftingConflict {
                    Button("Save edit") { model.saveConflictEdit() }
                        .font(.custom("Georgia", size: 15))
                        .buttonStyle(.plain)
                }
            }
            NoteEditor(
                text: $model.text,
                editable: model.conflict == nil || model.draftingConflict,
                context: model.context,
                onFind: { findFocused = true }
            ) { base, edited in
                model.userEdited(base: base, edited: edited)
            }
            #if os(iOS)
            TextField("Find in your notes", text: $findQuery)
                .textFieldStyle(.plain)
                .font(.custom("Georgia", size: 15))
                .foregroundStyle(quiet)
                .focused($findFocused)
            #endif
        }
        .padding()
        .frame(maxWidth: 672, alignment: .leading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .background(charcoal)
        .foregroundStyle(cream)
        .tint(cream)
        .overlay(alignment: .top) {
            Rectangle().fill(hairline).frame(height: 1)
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.considerDay() }
        }
    }
}
