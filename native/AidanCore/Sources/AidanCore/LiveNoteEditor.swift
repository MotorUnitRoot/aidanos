import Foundation

/// The note as he typed it. A tick is the only edit that changes a line for him.
public struct LiveNoteEditor: Sendable {
    public private(set) var text: String
    public var context: ExternalNoteContext
    private var undoStack: [String]
    private var redoStack: [String]
    private let reading: ExternalFormatLineReading
    private let undoCap = 200

    public init(text: String = "", context: ExternalNoteContext = .project) {
        self.text = text
        self.context = context
        self.undoStack = []
        self.redoStack = []
        self.reading = ExternalFormatLineReading()
    }

    public mutating func reset(_ text: String) {
        self.text = text
        undoStack.removeAll()
        redoStack.removeAll()
    }

    public func shapes() -> [EditorLineShape] {
        reading.shapes(in: text, context: context)
    }

    public func role(ofLine line: String) -> EditorLineRole {
        reading.role(ofLine: line, in: context)
    }

    /// Keeps `next` exactly. The caller built it from keystrokes.
    @discardableResult
    public mutating func type(_ next: String) -> String {
        guard next != text else { return text }
        pushUndo()
        text = next
        return text
    }

    /// One keystroke, measured apart from reading the whole note.
    @discardableResult
    public mutating func replace(start: Int, end: Int, with insert: String) -> String {
        let source = text
        let from = max(0, min(source.count, start))
        let to = max(from, min(source.count, end))
        let startIndex = source.index(source.startIndex, offsetBy: from)
        let endIndex = source.index(source.startIndex, offsetBy: to)
        var next = String(source[..<startIndex])
        next += insert
        next += source[endIndex...]
        return type(next)
    }

    @discardableResult
    public mutating func tick(line index: Int) -> String {
        var pieces = NoteLineBreaks.pieces(text)
        guard pieces.indices.contains(index) else { return text }
        let nextLine = Self.ticking(pieces[index].line)
        guard nextLine != pieces[index].line else { return text }
        pieces[index].line = nextLine
        return type(NoteLineBreaks.joined(pieces))
    }

    public mutating func undo() -> String? {
        guard let previous = undoStack.popLast() else { return nil }
        redoStack.append(text)
        text = previous
        return text
    }

    public mutating func redo() -> String? {
        guard let next = redoStack.popLast() else { return nil }
        undoStack.append(text)
        text = next
        return text
    }

    /// The task button. A line that already has a box flips. Any other line
    /// gains an open box, and the words after the mark stay as he typed them.
    public static func checkbox(_ line: String) -> String {
        if line.range(of: #"^\s*#{1,6}\s"#, options: .regularExpression) != nil { return line }
        if line.range(of: #"^\s*[-*+]\s+\["#, options: .regularExpression) != nil {
            return ticking(line)
        }
        let pattern = #"^(\s*)([-*+]|\d+[.)])\s+(.*)$"#
        if let regex = try? NSRegularExpression(pattern: pattern),
           let match = regex.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
           match.numberOfRanges == 4,
           let indent = Range(match.range(at: 1), in: line),
           let body = Range(match.range(at: 3), in: line) {
            return String(line[indent]) + "- [ ] " + String(line[body])
        }
        if let range = line.range(of: #"^\s*"#, options: .regularExpression) {
            return String(line[range]) + "- [ ] " + String(line[range.upperBound...])
        }
        return "- [ ] " + line
    }

    public static func heading(_ line: String) -> String {
        if line.range(of: #"^\s*#{1,6}\s"#, options: .regularExpression) != nil { return line }
        guard let range = line.range(of: #"^\s*"#, options: .regularExpression) else { return "# " + line }
        return line.replacingCharacters(in: range, with: String(line[range]) + "# ")
    }

    public static func list(_ line: String) -> String {
        if line.range(of: #"^\s*[-*+]\s+\["#, options: .regularExpression) != nil { return line }
        if line.range(of: #"^\s*([-*+]|\d+[.)])\s"#, options: .regularExpression) != nil { return line }
        guard let range = line.range(of: #"^\s*"#, options: .regularExpression) else { return "- " + line }
        return line.replacingCharacters(in: range, with: String(line[range]) + "- ")
    }

    public static func indent(_ line: String) -> String {
        "  " + line
    }

    public static func outdent(_ line: String) -> String {
        if line.hasPrefix("\t") { return String(line.dropFirst()) }
        if line.hasPrefix("  ") { return String(line.dropFirst(2)) }
        return line
    }

    /// Flips the box the line reader already understands. The words after it stay.
    public static func ticking(_ line: String) -> String {
        let scalars = Array(line.unicodeScalars)
        var index = 0
        while index < scalars.count, scalars[index] == "\t" { index += 1 }
        guard index < scalars.count else { return line }
        let marker = scalars[index]
        guard marker == "*" || marker == "-" || marker == "+" else { return line }
        index += 1
        guard index < scalars.count, scalars[index] == " " else { return line }
        index += 1
        let prefix = String(String.UnicodeScalarView(scalars[..<index]))
        let rest = String(String.UnicodeScalarView(scalars[index...]))
        if rest.hasPrefix("[ ]") {
            return prefix + "[x]" + rest.dropFirst(3)
        }
        if rest.hasPrefix("[x]") || rest.hasPrefix("[X]") {
            return prefix + "[ ]" + rest.dropFirst(3)
        }
        if rest.hasPrefix("[]") {
            return prefix + "[x]" + rest.dropFirst(2)
        }
        return line
    }

    private mutating func pushUndo() {
        undoStack.append(text)
        if undoStack.count > undoCap { undoStack.removeFirst() }
        redoStack.removeAll()
    }
}
