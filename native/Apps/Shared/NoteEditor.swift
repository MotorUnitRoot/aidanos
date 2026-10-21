import SwiftUI

#if os(iOS)
import UIKit

struct NoteEditor: UIViewRepresentable {
    @Binding var text: String
    var editable = true
    var onEdit: (String, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.delegate = context.coordinator
        view.text = text
        view.isEditable = editable
        view.backgroundColor = .clear
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        context.coordinator.shown = text
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            let end = (view.text as NSString).length
            view.selectedRange = NSRange(location: end, length: 0)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        view.isEditable = editable
        if context.coordinator.editing { return }
        if view.text != text {
            let cursor = view.selectedRange
            let old = view.text ?? ""
            view.text = text
            view.selectedRange = mapCursor(cursor, from: old, to: text)
            context.coordinator.shown = text
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NoteEditor
        var editing = false
        var shown = ""
        init(_ parent: NoteEditor) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            guard parent.editable else { return }
            editing = true
            let edited = textView.text ?? ""
            parent.onEdit(shown, edited)
            shown = parent.text
            if (textView.text ?? "") != parent.text {
                let cursor = textView.selectedRange
                let old = textView.text ?? ""
                textView.text = parent.text
                textView.selectedRange = mapCursor(cursor, from: old, to: parent.text)
            }
            editing = false
        }
    }
}
#elseif os(macOS)
import AppKit

struct NoteEditor: NSViewRepresentable {
    @Binding var text: String
    var editable = true
    var onEdit: (String, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        let view = NSTextView()
        view.isRichText = false
        view.isEditable = editable
        view.isSelectable = true
        view.font = NSFont.preferredFont(forTextStyle: .body)
        view.delegate = context.coordinator
        view.string = text
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        scroll.documentView = view
        context.coordinator.shown = text
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
            let end = (view.string as NSString).length
            view.setSelectedRange(NSRange(location: end, length: 0))
        }
        return scroll
    }

    func updateNSView(_ scroll: NSScrollView, context: Context) {
        guard let view = scroll.documentView as? NSTextView else { return }
        context.coordinator.parent = self
        view.isEditable = editable
        if context.coordinator.editing { return }
        if view.string != text {
            let cursor = view.selectedRange()
            let old = view.string
            view.string = text
            view.setSelectedRange(mapCursor(cursor, from: old, to: text))
            context.coordinator.shown = text
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NoteEditor
        var editing = false
        var shown = ""
        init(_ parent: NoteEditor) { self.parent = parent }

        func textDidChange(_ notification: Notification) {
            guard parent.editable, let view = notification.object as? NSTextView else { return }
            editing = true
            let edited = view.string
            parent.onEdit(shown, edited)
            shown = parent.text
            if view.string != parent.text {
                let cursor = view.selectedRange()
                let old = view.string
                view.string = parent.text
                view.setSelectedRange(mapCursor(cursor, from: old, to: parent.text))
            }
            editing = false
        }
    }
}
#endif

func mapCursor(_ range: NSRange, from old: String, to new: String) -> NSRange {
    let oldText = old as NSString
    let newText = new as NSString
    let start = mapIndex(range.location, from: oldText, to: newText)
    let end = mapIndex(range.location + range.length, from: oldText, to: newText)
    let location = min(max(0, start), newText.length)
    let limit = min(max(location, end), newText.length)
    return NSRange(location: location, length: limit - location)
}

/// Maps one end of the selection through a single remote edit. An edit that ends before the index shifts it.
/// An edit that starts at the index leaves it where it is, so the caret stays in front of remote text that landed there.
private func mapIndex(_ index: Int, from old: NSString, to new: NSString) -> Int {
    let oldCount = old.length
    let newCount = new.length
    let clamped = min(max(index, 0), oldCount)
    var prefix = 0
    let prefixLimit = min(oldCount, newCount)
    while prefix < prefixLimit && old.character(at: prefix) == new.character(at: prefix) {
        prefix += 1
    }
    var suffix = 0
    while suffix < oldCount - prefix && suffix < newCount - prefix
        && old.character(at: oldCount - 1 - suffix) == new.character(at: newCount - 1 - suffix) {
        suffix += 1
    }
    let changeEnd = oldCount - suffix
    if changeEnd < clamped {
        return min(newCount, max(0, clamped + (newCount - oldCount)))
    }
    if clamped <= prefix {
        return min(clamped, newCount)
    }
    return min(newCount, prefix + (newCount - suffix - prefix))
}
