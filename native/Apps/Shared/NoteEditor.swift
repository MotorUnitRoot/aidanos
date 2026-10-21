import SwiftUI

#if os(iOS)
import UIKit

struct NoteEditor: UIViewRepresentable {
    @Binding var text: String
    var onEdit: (String, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.delegate = context.coordinator
        view.text = text
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
        view.isEditable = true
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
            guard let view = notification.object as? NSTextView else { return }
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
    let cursor = range.location
    let oldCount = oldText.length
    let newCount = newText.length
    var prefix = 0
    let limit = min(cursor, min(oldCount, newCount))
    while prefix < limit && oldText.character(at: prefix) == newText.character(at: prefix) {
        prefix += 1
    }
    if prefix >= cursor {
        return NSRange(location: min(cursor, newCount), length: 0)
    }
    let moved = cursor + (newCount - oldCount)
    return NSRange(location: min(newCount, max(0, moved)), length: 0)
}
