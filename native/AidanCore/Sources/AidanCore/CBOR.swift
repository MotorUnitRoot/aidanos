import Foundation

enum CBORNesting {
    static let limit = 32
}

enum CBOR: Equatable {
    case unsigned(UInt64)
    case negative(Int64)
    case bytes(Data)
    case text(String)
    case array([CBOR])
    case map([String: CBOR])
    case bool(Bool)
    case null

    func encode() -> Data {
        var data = Data()
        encode(into: &data)
        return data
    }

    static func decode(_ data: Data) throws -> CBOR {
        var cursor = 0
        let value = try readValue(data, &cursor)
        if cursor != data.count {
            throw AidanError.protocol("The relay sent extra bytes.")
        }
        return value
    }

    var textValue: String? {
        if case .text(let value) = self { return value }
        return nil
    }

    var bytesValue: Data? {
        if case .bytes(let value) = self { return value }
        return nil
    }

    subscript(key: String) -> CBOR? {
        if case .map(let map) = self { return map[key] }
        return nil
    }

    private func encode(into data: inout Data) {
        switch self {
        case .unsigned(let value):
            writeUnsigned(major: 0, value: value, into: &data)
        case .negative(let value):
            let magnitude = value < 0 ? UInt64(bitPattern: Int64(-1) - value) : 0
            writeUnsigned(major: 1, value: magnitude, into: &data)
        case .bytes(let value):
            writeUnsigned(major: 2, value: UInt64(value.count), into: &data)
            data.append(value)
        case .text(let value):
            let utf = Data(value.utf8)
            writeUnsigned(major: 3, value: UInt64(utf.count), into: &data)
            data.append(utf)
        case .array(let values):
            writeUnsigned(major: 4, value: UInt64(values.count), into: &data)
            for value in values { value.encode(into: &data) }
        case .map(let pairs):
            writeUnsigned(major: 5, value: UInt64(pairs.count), into: &data)
            for (key, value) in pairs {
                CBOR.text(key).encode(into: &data)
                value.encode(into: &data)
            }
        case .bool(let value):
            data.append(value ? 0xF5 : 0xF4)
        case .null:
            data.append(0xF6)
        }
    }
}

private func writeUnsigned(major: UInt8, value: UInt64, into data: inout Data) {
    let head = major << 5
    if value < 24 {
        data.append(head | UInt8(value))
    } else if value <= UInt64(UInt8.max) {
        data.append(head | 24)
        data.append(UInt8(value))
    } else if value <= UInt64(UInt16.max) {
        data.append(head | 25)
        data.append(UInt8((value >> 8) & 0xFF))
        data.append(UInt8(value & 0xFF))
    } else if value <= UInt64(UInt32.max) {
        data.append(head | 26)
        for shift in stride(from: 24, through: 0, by: -8) {
            data.append(UInt8((value >> shift) & 0xFF))
        }
    } else {
        data.append(head | 27)
        for shift in stride(from: 56, through: 0, by: -8) {
            data.append(UInt8((value >> shift) & 0xFF))
        }
    }
}

private func readValue(_ data: Data, _ cursor: inout Int, depth: Int = 0) throws -> CBOR {
    if depth >= CBORNesting.limit {
        throw AidanError.protocol("The relay sent a message nested too deep.")
    }
    let (major, info) = try readHead(data, &cursor)
    switch major {
    case 0:
        return .unsigned(try readLength(info, data, &cursor))
    case 1:
        let magnitude = try readLength(info, data, &cursor)
        return .negative(-1 - Int64(bitPattern: magnitude))
    case 2:
        return .bytes(try readBytes(info, data, &cursor))
    case 3:
        let bytes = try readBytes(info, data, &cursor)
        guard let text = String(data: bytes, encoding: .utf8) else {
            throw AidanError.protocol("The relay sent text that is not UTF-8.")
        }
        return .text(text)
    case 4:
        if info == 31 {
            var values: [CBOR] = []
            while try peek(data, cursor) != 0xFF {
                values.append(try readValue(data, &cursor, depth: depth + 1))
            }
            cursor += 1
            return .array(values)
        }
        let count = try readLength(info, data, &cursor)
        guard count <= 100_000 else { throw AidanError.protocol("The relay sent a huge list.") }
        var values: [CBOR] = []
        values.reserveCapacity(Int(count))
        for _ in 0..<count { values.append(try readValue(data, &cursor, depth: depth + 1)) }
        return .array(values)
    case 5:
        var pairs: [String: CBOR] = [:]
        if info == 31 {
            while try peek(data, cursor) != 0xFF {
                let key = try readValue(data, &cursor, depth: depth + 1)
                let value = try readValue(data, &cursor, depth: depth + 1)
                if let text = key.textValue { pairs[text] = value }
            }
            cursor += 1
            return .map(pairs)
        }
        let count = try readLength(info, data, &cursor)
        guard count <= 100_000 else { throw AidanError.protocol("The relay sent a huge map.") }
        for _ in 0..<count {
            let key = try readValue(data, &cursor, depth: depth + 1)
            let value = try readValue(data, &cursor, depth: depth + 1)
            if let text = key.textValue { pairs[text] = value }
        }
        return .map(pairs)
    case 6:
        _ = try readLength(info, data, &cursor)
        return try readValue(data, &cursor, depth: depth + 1)
    case 7:
        switch info {
        case 20: return .bool(false)
        case 21: return .bool(true)
        case 22, 23: return .null
        default:
            throw AidanError.protocol("The relay sent a number shape this app does not use.")
        }
    default:
        throw AidanError.protocol("The relay sent a message this app cannot read.")
    }
}

private func readHead(_ data: Data, _ cursor: inout Int) throws -> (UInt8, UInt8) {
    guard cursor < data.count else { throw AidanError.protocol("The relay message ended early.") }
    let byte = data[cursor]
    cursor += 1
    return (byte >> 5, byte & 0x1F)
}

private func readLength(_ info: UInt8, _ data: Data, _ cursor: inout Int) throws -> UInt64 {
    if info < 24 { return UInt64(info) }
    let width: Int
    switch info {
    case 24: width = 1
    case 25: width = 2
    case 26: width = 4
    case 27: width = 8
    default: throw AidanError.protocol("The relay message used an unsupported length.")
    }
    guard cursor + width <= data.count else { throw AidanError.protocol("The relay message ended early.") }
    var value: UInt64 = 0
    for _ in 0..<width {
        value = (value << 8) | UInt64(data[cursor])
        cursor += 1
    }
    return value
}

private func readBytes(_ info: UInt8, _ data: Data, _ cursor: inout Int) throws -> Data {
    if info == 31 {
        var out = Data()
        while try peek(data, cursor) != 0xFF {
            let chunk = try readValue(data, &cursor, depth: depth + 1)
            guard let bytes = chunk.bytesValue else {
                throw AidanError.protocol("The relay sent a broken byte string.")
            }
            out.append(bytes)
        }
        cursor += 1
        return out
    }
    let count = try readLength(info, data, &cursor)
    guard count <= 8_000_000 else { throw AidanError.protocol("The relay sent a huge note update.") }
    guard cursor + Int(count) <= data.count else { throw AidanError.protocol("The relay message ended early.") }
    let slice = data.subdata(in: cursor..<(cursor + Int(count)))
    cursor += Int(count)
    return slice
}

private func peek(_ data: Data, _ cursor: Int) throws -> UInt8 {
    guard cursor < data.count else { throw AidanError.protocol("The relay message ended early.") }
    return data[cursor]
}
