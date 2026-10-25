import AidanCore
import SwiftUI

#if os(iOS)
import UIKit

enum EditorChrome {
    static let cream = UIColor(red: 242 / 255, green: 238 / 255, blue: 230 / 255, alpha: 1)
    static let faint = UIColor(red: 154 / 255, green: 148 / 255, blue: 136 / 255, alpha: 1)
    static let charcoal = UIColor(red: 22 / 255, green: 21 / 255, blue: 19 / 255, alpha: 1)
    static let hairline = UIColor(red: 44 / 255, green: 42 / 255, blue: 38 / 255, alpha: 1)

    static func bodyFont() -> UIFont {
        UIFont(name: "Georgia", size: 17) ?? UIFont.preferredFont(forTextStyle: .body)
    }

    static func headingFont(_ level: Int) -> UIFont {
        let size: CGFloat = level <= 1 ? 28 : (level == 2 ? 22 : 18)
        return UIFont(name: "Georgia", size: size) ?? UIFont.preferredFont(forTextStyle: .title2)
    }
}

struct NoteEditor: UIViewRepresentable {
    @Binding var text: String
    var editable = true
    var context: ExternalNoteContext = .project
    var onFind: () -> Void = {}
    var onEdit: (String, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.font = EditorChrome.bodyFont()
        view.textColor = EditorChrome.cream
        view.backgroundColor = .clear
        view.tintColor = EditorChrome.cream
        view.delegate = context.coordinator
        view.text = text
        view.isEditable = editable
        view.isSelectable = true
        view.isScrollEnabled = true
        view.alwaysBounceVertical = true
        view.smartQuotesType = .no
        view.smartDashesType = .no
        view.smartInsertDeleteType = .no
        view.autocorrectionType = .no
        view.textContainer.lineFragmentPadding = 0
        view.textContainerInset = UIEdgeInsets(top: 4, left: 0, bottom: 28, right: 0)
        let bar = EditorFormatBar()
        bar.onAction = { [weak view] action in
            guard let view else { return }
            context.coordinator.perform(action, on: view)
        }
        view.inputAccessoryView = bar
        let tap = UITapGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.tappedBox(_:)))
        tap.cancelsTouchesInView = false
        view.addGestureRecognizer(tap)
        context.coordinator.view = view
        context.coordinator.shown = text
        applyEditorStyle(view.textStorage, note: self.context, around: nil)
        DispatchQueue.main.async {
            view.becomeFirstResponder()
            let end = (view.text as NSString).length
            view.selectedRange = NSRange(location: end, length: 0)
        }
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.view = view
        view.isEditable = editable
        if context.coordinator.editing { return }
        if view.text != text {
            let cursor = view.selectedRange
            let old = view.text ?? ""
            view.text = text
            view.selectedRange = mapCursor(cursor, from: old, to: text)
            context.coordinator.shown = text
            applyEditorStyle(view.textStorage, note: self.context, around: nil)
        }
    }

    final class Coordinator: NSObject, UITextViewDelegate {
        var parent: NoteEditor
        var editing = false
        var shown = ""
        weak var view: UITextView?
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
                applyEditorStyle(textView.textStorage, note: parent.context, around: nil)
            } else {
                applyEditorStyle(textView.textStorage, note: parent.context, around: textView.selectedRange.location)
            }
            editing = false
        }

        func perform(_ action: EditorBarAction, on textView: UITextView) {
            switch action {
            case .task:
                replaceCurrentLine(in: textView) { LiveNoteEditor.checkbox($0) }
            case .heading:
                replaceCurrentLine(in: textView) { LiveNoteEditor.heading($0) }
            case .list:
                replaceCurrentLine(in: textView) { LiveNoteEditor.list($0) }
            case .indent:
                replaceCurrentLine(in: textView) { LiveNoteEditor.indent($0) }
            case .outdent:
                replaceCurrentLine(in: textView) { LiveNoteEditor.outdent($0) }
            case .undo:
                textView.undoManager?.undo()
            case .find:
                parent.onFind()
                textView.resignFirstResponder()
            case .hideKeyboard:
                textView.resignFirstResponder()
            }
        }

        func replaceCurrentLine(in textView: UITextView, with transform: (String) -> String) {
            let ns = (textView.text ?? "") as NSString
            let range = editorLineRange(ns, around: textView.selectedRange.location)
            let line = ns.substring(with: range)
            let next = transform(line)
            guard next != line else { return }
            guard let start = textView.position(from: textView.beginningOfDocument, offset: range.location),
                  let end = textView.position(from: start, offset: range.length),
                  let textRange = textView.textRange(from: start, to: end) else { return }
            textView.replace(textRange, withText: next)
        }

        @objc func tappedBox(_ gesture: UITapGestureRecognizer) {
            guard let textView = view, gesture.state == .ended else { return }
            let point = gesture.location(in: textView)
            let adjusted = CGPoint(
                x: point.x - textView.textContainerInset.left,
                y: point.y - textView.textContainerInset.top
            )
            let index = textView.layoutManager.characterIndex(
                for: adjusted,
                in: textView.textContainer,
                fractionOfDistanceBetweenInsertionPoints: nil
            )
            let ns = (textView.text ?? "") as NSString
            guard index < ns.length else { return }
            let range = editorLineRange(ns, around: index)
            let line = ns.substring(with: range)
            let local = index - range.location
            guard boxCovers(line, utf16: local) else { return }
            let role = ExternalFormatLineReading().role(ofLine: line, in: parent.context)
            guard case .task = role else { return }
            replaceCurrentLine(in: textView) { LiveNoteEditor.ticking($0) }
        }
    }
}

enum EditorBarAction {
    case task, heading, list, indent, outdent, undo, find, hideKeyboard
}

final class EditorFormatBar: UIView {
    var onAction: ((EditorBarAction) -> Void)?

    override init(frame: CGRect) {
        super.init(frame: frame)
        backgroundColor = EditorChrome.cream
        let hair = UIView()
        hair.backgroundColor = EditorChrome.hairline
        hair.translatesAutoresizingMaskIntoConstraints = false
        addSubview(hair)
        let row = UIStackView()
        row.axis = .horizontal
        row.distribution = .fillEqually
        row.translatesAutoresizingMaskIntoConstraints = false
        addSubview(row)
        NSLayoutConstraint.activate([
            hair.topAnchor.constraint(equalTo: topAnchor),
            hair.leadingAnchor.constraint(equalTo: leadingAnchor),
            hair.trailingAnchor.constraint(equalTo: trailingAnchor),
            hair.heightAnchor.constraint(equalToConstant: 1),
            row.topAnchor.constraint(equalTo: topAnchor, constant: 1),
            row.leadingAnchor.constraint(equalTo: leadingAnchor),
            row.trailingAnchor.constraint(equalTo: trailingAnchor),
            row.bottomAnchor.constraint(equalTo: bottomAnchor),
            heightAnchor.constraint(equalToConstant: 48),
        ])
        let items: [(String, EditorBarAction, String)] = [
            ("checkmark.square", .task, "Task"),
            ("textformat.size", .heading, "Heading"),
            ("list.bullet", .list, "List"),
            ("increase.indent", .indent, "Indent"),
            ("decrease.indent", .outdent, "Outdent"),
            ("arrow.uturn.backward", .undo, "Undo"),
            ("magnifyingglass", .find, "Find"),
            ("keyboard.chevron.compact.down", .hideKeyboard, "Hide keyboard"),
        ]
        for (index, item) in items.enumerated() {
            let button = UIButton(type: .system)
            button.tintColor = EditorChrome.charcoal
            button.setImage(UIImage(systemName: item.0), for: .normal)
            button.accessibilityLabel = item.2
            button.tag = index
            button.addAction(UIAction { [weak self] _ in
                self?.onAction?(items[index].1)
            }, for: .touchUpInside)
            row.addArrangedSubview(button)
        }
    }

    required init?(coder: NSCoder) { return nil }

    override var intrinsicContentSize: CGSize {
        CGSize(width: UIView.noIntrinsicMetric, height: 48)
    }
}

private func boxCovers(_ line: String, utf16 index: Int) -> Bool {
    guard let match = line.range(of: #"\[[ xX]\]"#, options: .regularExpression) else { return false }
    let start = line.utf16.distance(from: line.startIndex, to: match.lowerBound)
    let end = line.utf16.distance(from: line.startIndex, to: match.upperBound)
    return index >= start && index < end
}

#elseif os(macOS)
import AppKit

enum EditorChrome {
    static let cream = NSColor(srgbRed: 242 / 255, green: 238 / 255, blue: 230 / 255, alpha: 1)
    static let faint = NSColor(srgbRed: 154 / 255, green: 148 / 255, blue: 136 / 255, alpha: 1)

    static func bodyFont() -> NSFont {
        NSFont(name: "Georgia", size: 17) ?? NSFont.preferredFont(forTextStyle: .body)
    }

    static func headingFont(_ level: Int) -> NSFont {
        let size: CGFloat = level <= 1 ? 28 : (level == 2 ? 22 : 18)
        return NSFont(name: "Georgia", size: size) ?? NSFont.preferredFont(forTextStyle: .title2)
    }
}

struct NoteEditor: NSViewRepresentable {
    @Binding var text: String
    var editable = true
    var context: ExternalNoteContext = .project
    var onFind: () -> Void = {}
    var onEdit: (String, String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeNSView(context: Context) -> NSScrollView {
        let scroll = NSScrollView()
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        let view = NSTextView()
        view.isRichText = true
        view.isEditable = editable
        view.isSelectable = true
        view.font = EditorChrome.bodyFont()
        view.textColor = EditorChrome.cream
        view.backgroundColor = .clear
        view.insertionPointColor = EditorChrome.cream
        view.isAutomaticQuoteSubstitutionEnabled = false
        view.isAutomaticDashSubstitutionEnabled = false
        view.isAutomaticTextReplacementEnabled = false
        view.isAutomaticSpellingCorrectionEnabled = false
        view.delegate = context.coordinator
        view.string = text
        view.isVerticallyResizable = true
        view.isHorizontallyResizable = false
        view.autoresizingMask = [.width]
        view.textContainer?.widthTracksTextView = true
        view.textContainer?.containerSize = NSSize(width: 0, height: CGFloat.greatestFiniteMagnitude)
        view.textContainer?.lineFragmentPadding = 0
        scroll.documentView = view
        let click = NSClickGestureRecognizer(target: context.coordinator, action: #selector(Coordinator.clickedBox(_:)))
        view.addGestureRecognizer(click)
        context.coordinator.view = view
        context.coordinator.shown = text
        if let storage = view.textStorage {
            applyEditorStyle(storage, note: self.context, around: nil)
        }
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
        context.coordinator.view = view
        view.isEditable = editable
        if context.coordinator.editing { return }
        if view.string != text {
            let cursor = view.selectedRange()
            let old = view.string
            view.string = text
            view.setSelectedRange(mapCursor(cursor, from: old, to: text))
            context.coordinator.shown = text
            if let storage = view.textStorage {
                applyEditorStyle(storage, note: self.context, around: nil)
            }
        }
    }

    final class Coordinator: NSObject, NSTextViewDelegate {
        var parent: NoteEditor
        var editing = false
        var shown = ""
        weak var view: NSTextView?
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
                if let storage = view.textStorage {
                    applyEditorStyle(storage, note: parent.context, around: nil)
                }
            } else if let storage = view.textStorage {
                applyEditorStyle(storage, note: parent.context, around: view.selectedRange().location)
            }
            editing = false
        }

        @objc func clickedBox(_ gesture: NSClickGestureRecognizer) {
            guard let view, gesture.state == .ended else { return }
            let point = gesture.location(in: view)
            guard let layout = view.layoutManager, let container = view.textContainer else { return }
            let index = layout.characterIndex(for: point, in: container, fractionOfDistanceBetweenInsertionPoints: nil)
            let ns = view.string as NSString
            guard index < ns.length else { return }
            let range = editorLineRange(ns, around: index)
            let line = ns.substring(with: range)
            guard boxCovers(line, utf16: index - range.location) else { return }
            let role = ExternalFormatLineReading().role(ofLine: line, in: parent.context)
            guard case .task = role else { return }
            let next = LiveNoteEditor.ticking(line)
            guard next != line else { return }
            if view.shouldChangeText(in: range, replacementString: next) {
                view.textStorage?.replaceCharacters(in: range, with: next)
                view.didChangeText()
            }
        }
    }
}

private func boxCovers(_ line: String, utf16 index: Int) -> Bool {
    guard let match = line.range(of: #"\[[ xX]\]"#, options: .regularExpression) else { return false }
    let start = line.utf16.distance(from: line.startIndex, to: match.lowerBound)
    let end = line.utf16.distance(from: line.startIndex, to: match.upperBound)
    return index >= start && index < end
}
#endif

func editorLineRange(_ text: NSString, around location: Int) -> NSRange {
    let length = text.length
    if length == 0 { return NSRange(location: 0, length: 0) }
    let clamped = min(max(0, location), length)
    let before = NSRange(location: 0, length: clamped)
    let previous = text.rangeOfCharacter(from: .newlines, options: [.backwards], range: before)
    let lineStart = previous.location == NSNotFound ? 0 : previous.location + previous.length
    let rest = NSRange(location: lineStart, length: length - lineStart)
    let next = text.rangeOfCharacter(from: .newlines, options: [], range: rest)
    let lineEnd = next.location == NSNotFound ? length : next.location
    return NSRange(location: lineStart, length: max(0, lineEnd - lineStart))
}

func applyEditorStyle(_ storage: NSTextStorage, note context: ExternalNoteContext, around: Int?) {
    let ns = storage.string as NSString
    let ranges: [NSRange]
    if let around {
        ranges = [editorLineRange(ns, around: around)]
    } else {
        var found: [NSRange] = []
        var cursor = 0
        if ns.length == 0 {
            found = [NSRange(location: 0, length: 0)]
        }
        while cursor <= ns.length {
            let range = editorLineRange(ns, around: cursor)
            found.append(range)
            let next = range.location + range.length
            if next >= ns.length { break }
            cursor = next + 1
            if cursor == range.location { break }
        }
        ranges = found
    }
    let reading = ExternalFormatLineReading()
    storage.beginEditing()
    for range in ranges where range.location + range.length <= storage.length {
        let line = range.length == 0 ? "" : ns.substring(with: range)
        let role = reading.role(ofLine: line, in: context)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 4
        var font = EditorChrome.bodyFont()
        switch role {
        case .heading(let level):
            font = EditorChrome.headingFont(level)
        case .list, .task:
            paragraph.headIndent = 22
            paragraph.firstLineHeadIndent = 0
        default:
            break
        }
        if range.length > 0 {
            storage.setAttributes([
                .font: font,
                .foregroundColor: EditorChrome.cream,
                .paragraphStyle: paragraph,
            ], range: range)
        }
        if case .heading = role, line.hasPrefix("#") {
            var marks = 0
            for character in line {
                if character == "#" { marks += 1 } else { break }
            }
            if marks > 0, marks <= range.length {
                storage.addAttribute(
                    .foregroundColor,
                    value: EditorChrome.faint,
                    range: NSRange(location: range.location, length: marks)
                )
            }
        }
    }
    storage.endEditing()
}

func mapCursor(_ range: NSRange, from old: String, to new: String) -> NSRange {
    let oldUnits = Array(old.utf16)
    let newUnits = Array(new.utf16)
    let changes = TextDiff.hunks(from: oldUnits, to: newUnits)
    let start = TextDiff.mapIndex(range.location, through: changes, oldCount: oldUnits.count)
    let end = TextDiff.mapIndex(range.location + range.length, through: changes, oldCount: oldUnits.count)
    let location = min(max(0, start), newUnits.count)
    let limit = min(max(location, end), newUnits.count)
    return NSRange(location: location, length: limit - location)
}
