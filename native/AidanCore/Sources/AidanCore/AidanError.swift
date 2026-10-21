import Foundation

public enum AidanError: Error, Equatable, CustomStringConvertible {
    case badPath(String)
    case authRejected
    case `protocol`(String)
    case io(String)

    public var description: String {
        switch self {
        case .badPath(let path):
            return "That note path is not inside the vault: \(path)"
        case .authRejected:
            return "The relay refused the token."
        case .protocol(let message):
            return message
        case .io(let message):
            return message
        }
    }
}

public struct NoteConflict: Equatable, Sendable {
    public let path: String
    public let mine: String
    public let theirs: String
    public let reason: String
}

public enum ConflictChoice: Sendable {
    case keepMine
    case takeTheirs
    case edit(String)
}
