import Foundation

/// What one note looks like on screen. Both the iPhone and the Mac use this.
///
/// A conflict the relay raises arrives on a later turn than the keystroke that follows it.
/// Until `showChoiceIfNeeded()` copies that conflict onto the surface, typing and pastes
/// still belong to this device: they are folded into Keep mine. Once the choice is visible,
/// further edits wait for Keep mine, Take theirs, or Edit.
public final class NoteSurface {
    private let session: AidanSession
    public private(set) var path: String
    public private(set) var text: String
    public private(set) var conflict: NoteConflict?
    public private(set) var draftingConflict = false
    public private(set) var statusMessage: String?

    public init(session: AidanSession, path: String, text: String) {
        self.session = session
        self.path = path
        self.text = text
        showChoiceIfNeeded()
    }

    public func focus(path: String, text: String) {
        self.path = path
        self.text = text
        draftingConflict = false
        statusMessage = nil
        showChoiceIfNeeded()
    }

    public func replaceText(_ value: String) {
        text = value
    }

    public func showChoiceIfNeeded() {
        conflict = session.conflicts().first { $0.path == path }
    }

    public func clearStatus() {
        statusMessage = nil
    }

    /// Applies what the person typed. Returns the text the screen should show.
    @discardableResult
    public func userEdited(base: String, edited: String) -> String {
        if conflict != nil && !draftingConflict {
            return text
        }
        if draftingConflict {
            text = edited
            return text
        }
        let waiting = session.conflicts().contains { $0.path == path }
        if conflict == nil && waiting {
            session.includeInMine(path, from: base, to: edited)
            showChoiceIfNeeded()
            if let mine = conflict?.mine {
                text = mine
            }
            return text
        }
        do {
            text = try session.applyEdit(path, from: base, to: edited)
            showChoiceIfNeeded()
        } catch {
            statusMessage = String(describing: error)
        }
        return text
    }

    public func beginDraft() {
        guard let conflict else { return }
        draftingConflict = true
        text = ConflictDraft.bothVersions(mine: conflict.mine, theirs: conflict.theirs)
    }

    public func clearDraft() {
        draftingConflict = false
    }
}
