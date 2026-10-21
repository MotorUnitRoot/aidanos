import SwiftUI

#if os(iOS)
import UIKit

struct NoteEditor: UIViewRepresentable {
    @Binding var text: String
    var onEdit: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = UIFont.preferredFont(forTextStyle: .body)
        view.delegate = context.coordinator
        view.text = text
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            let end = view.endOfDocument
            view.selectedTextRange = view.textRange(from: end, to: end)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        if context.coordinator.editing { return }
        if view.text != text { view.text = text }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NoteEditor
        var editing = false
        init(_ parent: NoteEditor) { self.parent = parent }
        func textViewDidChange(_ textView: UITextView) {
            editing = true
            parent.onEdit(textView.text)
            editing = false
        }
    }
}
#else
import AppKit

struct NoteEditor: NSViewRepresentable {
    @Binding var text: String
    var onEdit: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSTextView {
        let view = NSTextView()
        view.isRichText = false
        view.font = NSFont.preferredFont(forTextStyle: .body)
        view.delegate = context.coordinator
        view.string = text
        DispatchQueue.main.async {
            view.window?.makeFirstResponder(view)
            let end = (view.string as NSString).length
            view.setSelectedRange(NSRange(location: end, length: 0))
        }
        return view
    }

    func updateNSView(_ view: NSTextView, context: Context) {
        if context.coordinator.editing { return }
        if view.string != text { view.string = text }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NoteEditor
        var editing = false
        init(_ parent: NoteEditor) { self.parent = parent }
        func textDidChange(_ notification: Notification) {
            guard let view = notification.object as? NSTextView else { return }
            editing = true
            parent.onEdit(view.string)
            editing = false
        }
    }
}
#endif
