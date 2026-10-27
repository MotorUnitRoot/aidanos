import Foundation

/// What the editor needs from a line, and nothing else.
/// Brought-forward lists are not decided here.
public enum EditorLineRole: Equatable, Sendable {
    case empty
    case plain
    case heading(level: Int)
    case list
    case task(ticked: Bool)
}

public struct EditorLineShape: Equatable, Sendable {
    public var role: EditorLineRole
    public var source: String
    public var indentTabs: Int

    public init(role: EditorLineRole, source: String, indentTabs: Int) {
        self.role = role
        self.source = source
        self.indentTabs = indentTabs
    }
}

/// The editor asks this for line shapes. The shipped reader is the one already
/// on this branch. Callers do not add line rules of their own.
public protocol NoteLineReading: Sendable {
    func shapes(in text: String, context: ExternalNoteContext) -> [EditorLineShape]
    func role(ofLine line: String, in context: ExternalNoteContext) -> EditorLineRole
}

public struct ExternalFormatLineReading: NoteLineReading, Sendable {
    public init() {}

    public func shapes(in text: String, context: ExternalNoteContext) -> [EditorLineShape] {
        let reading = ExternalFormatReader.read(text, in: context)
        let pieces = NoteLineBreaks.pieces(text)
        let count = min(reading.lines.count, pieces.count)
        var shapes: [EditorLineShape] = []
        shapes.reserveCapacity(count)
        for index in 0..<count {
            let line = reading.lines[index]
            shapes.append(EditorLineShape(
                role: Self.role(for: line.kind),
                source: pieces[index].line,
                indentTabs: line.indentTabs
            ))
        }
        return shapes
    }

    public func role(ofLine line: String, in context: ExternalNoteContext) -> EditorLineRole {
        let reading = ExternalFormatReader.read(line, in: context)
        guard let first = reading.lines.first else { return line.isEmpty ? .empty : .plain }
        return Self.role(for: first.kind)
    }

    public static func role(for kind: ExternalLineKind) -> EditorLineRole {
        switch kind {
        case .empty:
            return .empty
        case .plain, .unsettled:
            return .plain
        case .heading(let level):
            return .heading(level: level)
        case .bullet, .openChecklist:
            return .list
        case .openTask:
            return .task(ticked: false)
        case .doneTask, .cancelledTask, .scheduledTask:
            return .task(ticked: true)
        }
    }
}

enum NoteLineBreaks {
    struct Piece: Equatable {
        var line: String
        var breakAfter: String
    }

    /// The same breaks the line reader uses, with the original separators kept
    /// so a note can be put back together without a new trailing line.
    static func pieces(_ text: String) -> [Piece] {
        if text.isEmpty { return [] }
        let breaks = text.utf8.contains { $0 == 10 || $0 == 13 }
        if !breaks { return [Piece(line: text, breakAfter: "")] }
        let scalars = Array(text.unicodeScalars)
        var pieces: [Piece] = []
        var current: [Unicode.Scalar] = []
        var index = 0
        while index < scalars.count {
            let scalar = scalars[index]
            if scalar == "\n" || scalar == "\r" {
                let line = String(String.UnicodeScalarView(current))
                current.removeAll(keepingCapacity: true)
                let separator: String
                if scalar == "\r", index + 1 < scalars.count, scalars[index + 1] == "\n" {
                    separator = "\r\n"
                    index += 2
                } else if scalar == "\r" {
                    separator = "\r"
                    index += 1
                } else {
                    separator = "\n"
                    index += 1
                }
                pieces.append(Piece(line: line, breakAfter: separator))
                continue
            }
            current.append(scalar)
            index += 1
        }
        if !current.isEmpty {
            pieces.append(Piece(line: String(String.UnicodeScalarView(current)), breakAfter: ""))
        }
        return pieces
    }

    static func joined(_ pieces: [Piece]) -> String {
        var text = ""
        for piece in pieces {
            text += piece.line
            text += piece.breakAfter
        }
        return text
    }
}

public enum EditorNoteContext {
    public static func forPath(_ path: String) -> ExternalNoteContext {
        let parts = path.split(separator: "/").map(String.init)
        guard parts.count == 2, parts[0] == "log" else { return .project }
        let name = parts[1]
        guard name.hasSuffix(".md") else { return .project }
        let day = String(name.dropLast(3))
        guard let date = ExternalDate.parse(day) else { return .project }
        return .day(date)
    }
}
