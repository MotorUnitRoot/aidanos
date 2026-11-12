import Crypto
import Foundation

/// Fingerprints that every device can compute. The same path always names the same note history.
public enum DocumentIds {
    public static let indexId: String = id(forLabel: Data("aidanos.index.v1".utf8))

    public static func noteId(_ path: String) -> String {
        var bytes = Data("aidanos.note.v1".utf8)
        bytes.append(0)
        bytes.append(contentsOf: path.utf8)
        return id(forLabel: bytes)
    }

    /// Identity used only for the blank opening of a document, so two devices write the same first change.
    static func rootActor(documentId: String) -> Data {
        var bytes = Data("aidanos.root.v1".utf8)
        bytes.append(0)
        bytes.append(contentsOf: documentId.utf8)
        return Data(SHA256.hash(data: bytes).prefix(16))
    }

    private static func id(forLabel data: Data) -> String {
        let digest = Data(SHA256.hash(data: data).prefix(16))
        return base58Check(digest)
    }
}

func base58Check(_ payload: Data) -> String {
    let checksum = Data(SHA256.hash(data: Data(SHA256.hash(data: payload))).prefix(4))
    return base58Encode(payload + checksum)
}

func base58Encode(_ data: Data) -> String {
    let alphabet = Array("123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz")
    var zeros = 0
    for byte in data {
        if byte == 0 { zeros += 1 } else { break }
    }
    var value = Array(data)
    var digits: [Int] = []
    while !value.isEmpty {
        var remainder = 0
        var next: [UInt8] = []
        next.reserveCapacity(value.count)
        for byte in value {
            let acc = remainder * 256 + Int(byte)
            let div = acc / 58
            remainder = acc % 58
            if !next.isEmpty || div != 0 {
                next.append(UInt8(div))
            }
        }
        digits.append(remainder)
        value = next
    }
    var out = String(repeating: "1", count: zeros)
    for digit in digits.reversed() {
        out.append(alphabet[digit])
    }
    return out
}
