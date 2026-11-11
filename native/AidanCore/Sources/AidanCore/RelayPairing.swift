import Foundation
import Crypto
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// Public metadata from the physically approved Mac QR. Contains no bearer/key.
public struct RelayPairing: Codable, Equatable, Sendable {
    public let version: Int
    public let address: String
    public let ipv4: String
    public let spki: String

    public init(qrData: Data) throws {
        guard qrData.count <= 4096,
              let object = try JSONSerialization.jsonObject(with: qrData) as? [String: Any],
              Set(object.keys) == Set(["version", "address", "ipv4", "spki"]) else {
            throw AidanError.protocol("Pairing QR must contain public endpoint metadata only.")
        }
        self = try JSONDecoder().decode(Self.self, from: qrData)
        _ = try validatedAddress()
    }

    func validatedAddress() throws -> RelayAddress {
        let parsed = try RelayAddress(address, allowTestLoopback: false)
        guard version == 1, parsed.secure, RelayAddress.isMagicDNS(parsed.host),
              address == parsed.canonicalURL, RelayAddress.isTailscaleIPv4(ipv4),
              spki.hasPrefix("sha256/"), let digest = Data(base64Encoded: String(spki.dropFirst(7))),
              digest.count == 32, "sha256/" + digest.base64EncodedString() == spki else {
            throw AidanError.protocol("Invalid relay pairing QR. Re-pair from the approved Mac.")
        }
        return parsed
    }

    func destination(_ raw: String, resolvedIPv4: [String]) throws -> RelayAddress {
        let parsed = try validatedAddress()
        guard raw == address, !resolvedIPv4.isEmpty, Set(resolvedIPv4) == Set([ipv4]) else {
            throw AidanError.protocol("Relay address or DNS changed. Refusing credentials; re-pair on the Mac.")
        }
        return parsed
    }

    static func resolveIPv4(_ name: String) throws -> [String] {
        var hints = addrinfo()
        hints.ai_family = AF_INET // IPv6 is never used, including fallback.
        #if canImport(Darwin)
        hints.ai_socktype = SOCK_STREAM
        #else
        hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
        #endif
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(name, nil, &hints, &result) == 0, let first = result else {
            throw AidanError.protocol("Approved relay DNS is unavailable; credentials were not sent.")
        }
        defer { freeaddrinfo(first) }
        var values: [String] = []
        var current: UnsafeMutablePointer<addrinfo>? = first
        while let node = current {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(node.pointee.ai_addr, node.pointee.ai_addrlen, &buffer,
                              socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 else {
                throw AidanError.protocol("Approved relay DNS could not be verified.")
            }
            values.append(String(cString: buffer))
            current = node.pointee.ai_next
        }
        return values
    }
}

// Extract the exact SPKI TLV from an already system-validated X.509 certificate.
// Hashing SecKeyCopyExternalRepresentation would hash the wrong (raw-key) format.
enum RelaySPKI {
    private struct TLV { let tag: UInt8; let full: Range<Int>; let body: Range<Int> }
    private static func read(_ bytes: [UInt8], at start: Int, limit: Int) throws -> TLV {
        var cursor = start
        guard cursor + 2 <= limit else { throw AidanError.protocol("Invalid certificate DER.") }
        let tag = bytes[cursor]; cursor += 1
        let initial = bytes[cursor]; cursor += 1
        var length = Int(initial)
        if initial & 0x80 != 0 {
            let count = Int(initial & 0x7f)
            guard count > 0, count <= 4, cursor + count <= limit, bytes[cursor] != 0 else {
                throw AidanError.protocol("Invalid certificate DER length.")
            }
            length = 0
            for _ in 0..<count { length = length * 256 + Int(bytes[cursor]); cursor += 1 }
            guard length >= 128 else { throw AidanError.protocol("Noncanonical certificate DER.") }
        }
        guard length <= limit - cursor else { throw AidanError.protocol("Invalid certificate DER bounds.") }
        return TLV(tag: tag, full: start..<(cursor + length), body: cursor..<(cursor + length))
    }
    static func fingerprint(certificateDER: Data) throws -> String {
        let bytes = Array(certificateDER)
        let certificate = try read(bytes, at: 0, limit: bytes.count)
        guard certificate.tag == 0x30, certificate.full.upperBound == bytes.count else { throw AidanError.protocol("Invalid certificate.") }
        let tbs = try read(bytes, at: certificate.body.lowerBound, limit: certificate.body.upperBound)
        guard tbs.tag == 0x30 else { throw AidanError.protocol("Invalid certificate body.") }
        var cursor = tbs.body.lowerBound
        if cursor < tbs.body.upperBound, bytes[cursor] == 0xa0 {
            cursor = try read(bytes, at: cursor, limit: tbs.body.upperBound).full.upperBound
        }
        for _ in 0..<5 { cursor = try read(bytes, at: cursor, limit: tbs.body.upperBound).full.upperBound }
        let key = try read(bytes, at: cursor, limit: tbs.body.upperBound)
        guard key.tag == 0x30 else { throw AidanError.protocol("Invalid certificate SPKI.") }
        return "sha256/" + Data(SHA256.hash(data: Data(bytes[key.full]))).base64EncodedString()
    }
}
