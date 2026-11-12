import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A small WebSocket client. It speaks the automerge-repo sync protocol to the relay.
final class RelayLink {
    private let queue = DispatchQueue(label: "aidanos.relay")
    private let readQueue = DispatchQueue(label: "aidanos.relay.read")
    private let lock = NSLock()
    #if DEBUG
    private var socket: Int32 = -1
    #endif
    private var secureTransport: RelayTLS?
    private var running = false
    private var serverId = ""
    private var peerId = ""
    private var storageId = ""
    private weak var host: SyncHost?
    private var ready: (() -> Void)?
    private var failed: ((Error) -> Void)?

    func connect(url: String, token: String, approvedRelayURL: String?, pairing: RelayPairing?, peerId: String, storageId: String, host: SyncHost) throws {
        _ = signal(SIGPIPE, SIG_IGN)
        let parsed = try RelayAddress.approved(url, paired: approvedRelayURL)
        self.peerId = peerId
        self.storageId = storageId
        self.host = host
        guard !token.contains("\r"), !token.contains("\n") else { throw AidanError.authRejected }
        do {
            if parsed.secure {
                let transport = RelayTLS()
                guard let pairing else { throw AidanError.protocol("Scan the approved Mac pairing QR before connecting.") }
                try transport.connect(address: parsed, pairing: pairing, token: token)
                secureTransport = transport
            } else {
                #if DEBUG
                let fd = try connectTCP(host: parsed.host, port: parsed.port)
                socket = fd
                try upgrade(fd: fd, address: parsed, token: token)
                #else
                throw AidanError.protocol("Release builds require paired WSS.")
                #endif
            }
        } catch {
            close()
            throw error
        }
        running = true
        let joined = DispatchSemaphore(value: 0)
        var joinError: Error?
        ready = { joined.signal() }
        failed = { error in
            joinError = error
            joined.signal()
        }
        readQueue.async { [weak self] in
            self?.readLoop()
        }
        try send(encodeJoin(senderId: peerId, storageId: storageId))
        SyncLog.write("sync out join")
        let wait = joined.wait(timeout: .now() + 15)
        if wait == .timedOut {
            close()
            throw AidanError.protocol("The relay did not answer.")
        }
        if let joinError {
            close()
            throw joinError
        }
    }

    func close() {
        lock.lock()
        running = false
        #if DEBUG
        let fd = socket
        socket = -1
        #endif
        let transport = secureTransport
        secureTransport = nil
        lock.unlock()
        transport?.close()
        #if DEBUG
        if fd >= 0 { _ = shutdown(fd, Int32(SHUT_RDWR)); _ = closeFd(fd) }
        #endif
    }

    func kick(_ docId: String) {
        queue.async { [weak self] in
            self?.pump(docId)
        }
    }

    private func pump(_ docId: String) {
        guard let host, let server = currentServer() else { return }
        var sent = 0
        while sent < 16 {
            guard let outgoing = host.takeOutgoing(docId: docId) else { break }
            let frame = encodeSync(type: outgoing.type, sender: peerId, target: server, docId: docId, data: outgoing.bytes)
            if frame.count > host.maxSyncBytes {
                host.noteTooLarge(docId: docId)
                break
            }
            do {
                try send(frame)
            } catch {
                return
            }
            SyncLog.write("sync out \(outgoing.type) doc=\(docId) heads=\(outgoing.heads)")
            host.noteSent(docId: docId)
            sent += 1
        }
        if sent == 16 {
            SyncLog.write("sync cap 16 doc=\(docId)")
        }
        if sent == 0 {
            host.settled(docId: docId)
        }
    }

    private func pumpAll() {
        guard let host else { return }
        for docId in host.documentIds() {
            pump(docId)
        }
    }

    private func currentServer() -> String? {
        lock.lock()
        let value = serverId
        lock.unlock()
        return value.isEmpty ? nil : value
    }

    private func readLoop() {
        while true {
            lock.lock()
            #if DEBUG
            let alive = running && (socket >= 0 || secureTransport != nil)
            #else
            let alive = running && secureTransport != nil
            #endif
            lock.unlock()
            if !alive { return }
            do {
                let frame: Data
                if let transport = secureTransport {
                    frame = try transport.receive()
                    guard frame.count <= (host?.maxSyncBytes ?? 32 * 1024 * 1024) else {
                        throw AidanError.payloadTooLarge
                    }
                } else {
                    #if DEBUG
                    guard let rawFrame = try readFrame() else { continue }
                    frame = rawFrame
                    #else
                    throw AidanError.protocol("Secure relay transport unavailable.")
                    #endif
                }
                let failure = ErrorBox()
                let done = DispatchSemaphore(value: 0)
                queue.async { [weak self] in
                    do {
                        try self?.handle(frame)
                    } catch {
                        failure.error = error
                    }
                    done.signal()
                }
                done.wait()
                if let error = failure.error { throw error }
            } catch {
                lock.lock()
                let alive = running
                let notify = failed
                failed = nil
                ready = nil
                lock.unlock()
                if alive {
                    if let notify {
                        notify(error)
                    } else {
                        host?.linkFailed(error)
                    }
                }
                return
            }
        }
    }

    private func handle(_ frame: Data) throws {
        let message = try CBOR.decode(frame)
        guard let type = message["type"]?.textValue else { return }
        switch type {
        case "peer":
            serverId = message["senderId"]?.textValue ?? ""
            SyncLog.write("sync in peer")
            let callback = ready
            ready = nil
            failed = nil
            callback?()
            pumpAll()
        case "sync", "request":
            guard let docId = message["documentId"]?.textValue, let bytes = message["data"]?.bytesValue else { return }
            try host?.applyIncoming(docId: docId, bytes: bytes)
            let heads = host?.syncHeads(docId: docId) ?? ""
            SyncLog.write("sync in \(type) doc=\(docId) heads=\(heads)")
            pump(docId)
        case "doc-unavailable":
            if let docId = message["documentId"]?.textValue {
                SyncLog.write("sync in doc-unavailable doc=\(docId)")
                host?.markUnavailable(docId: docId)
                pump(docId)
            }
        case "error":
            let text = message["message"]?.textValue ?? "The relay reported an error."
            throw AidanError.protocol(text)
        default:
            break
        }
    }

    private func send(_ data: Data) throws {
        if let transport = secureTransport { try transport.send(data); return }
        #if DEBUG
        try sendFrame(opcode: 0x2, payload: data)
        #else
        throw AidanError.protocol("Secure relay transport unavailable.")
        #endif
    }

    #if DEBUG
    /// Clients mask every frame, including the pong that answers the relay's ping.
    private func sendFrame(opcode: UInt8, payload: Data) throws {
        var header = Data()
        header.append(0x80 | opcode)
        let length = payload.count
        if length < 126 {
            header.append(UInt8(length) | 0x80)
        } else if length <= Int(UInt16.max) {
            header.append(126 | 0x80)
            header.append(UInt8((length >> 8) & 0xFF))
            header.append(UInt8(length & 0xFF))
        } else {
            header.append(127 | 0x80)
            var big = UInt64(length)
            var bytes: [UInt8] = []
            for _ in 0..<8 {
                bytes.insert(UInt8(big & 0xFF), at: 0)
                big >>= 8
            }
            header.append(contentsOf: bytes)
        }
        var mask = [UInt8](repeating: 0, count: 4)
        for index in 0..<4 { mask[index] = UInt8.random(in: 0...255) }
        header.append(contentsOf: mask)
        var body = Data(payload)
        for index in body.indices {
            body[index] ^= mask[index % 4]
        }
        header.append(body)
        try writeAll(header)
    }

    private func upgrade(fd: Int32, address: RelayAddress, token: String) throws {
        let key = Data((0..<16).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
        let request = [
            "GET \(address.path) HTTP/1.1",
            "Host: \(address.host):\(address.port)",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Key: \(key)",
            "Sec-WebSocket-Version: 13",
            "Authorization: Bearer \(token)",
            "",
            "",
        ].joined(separator: "\r\n")
        try writeAll(Data(request.utf8))
        let header = try readHTTPHeader(fd: fd)
        let status = httpStatus(header)
        if status == 401 { throw AidanError.authRejected }
        if status != 101 {
            throw AidanError.protocol("The relay did not accept the connection (\(status)).")
        }
    }

    private func readHTTPHeader(fd: Int32) throws -> String {
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 1)
        // The socket times out quickly so the sync loop can notice a dead relay.
        // The first answer from a phone, or from the iOS simulator, can take longer
        // than that one wait, so keep reading until the header arrives.
        let deadline = Date().addingTimeInterval(15)
        while data.count < 8192 {
            let count = readFd(fd, &buffer, 1)
            if count == 0 { break }
            if count < 0 {
                if errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT {
                    if Date() >= deadline {
                        throw AidanError.protocol("The relay did not answer.")
                    }
                    continue
                }
                throw AidanError.protocol("The relay closed the connection.")
            }
            data.append(buffer[0])
            if data.count >= 4 {
                let tail = data.suffix(4)
                if tail.elementsEqual(Data([13, 10, 13, 10])) { break }
            }
        }
        return String(data: data, encoding: .utf8) ?? ""
    }

    private func httpStatus(_ header: String) -> Int {
        let line = header.split(separator: "\r\n", maxSplits: 1).first.map(String.init) ?? ""
        let parts = line.split(separator: " ")
        if parts.count >= 2, let status = Int(parts[1]) { return status }
        return 0
    }

    private func readFrame() throws -> Data? {
        let first = try readExact(2)
        let opcode = first[0] & 0x0F
        var length = Int(first[1] & 0x7F)
        let masked = (first[1] & 0x80) != 0
        if length == 126 {
            let extra = try readExact(2)
            length = Int(extra[0]) << 8 | Int(extra[1])
        } else if length == 127 {
            let extra = try readExact(8)
            length = 0
            for byte in extra { length = (length << 8) | Int(byte) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        if masked {
            mask = Array(try readExact(4))
        }
        guard length >= 0, length <= Self.maxFrame else {
            throw AidanError.payloadTooLarge
        }
        var payload = try readExact(length)
        if masked {
            for index in payload.indices { payload[index] ^= mask[index % 4] }
        }
        if opcode == 0x8 { throw closeError(payload) }
        if opcode == 0x9 {
            try sendPong(payload)
            return nil
        }
        if opcode == 0xA { return nil }
        if opcode != 0x2 && opcode != 0x0 { return nil }
        return payload
    }

    /// A frame bigger than this is refused. The relay's cap is the same 32 MB.
    private static let maxFrame = SyncLimits.maxMessageBytes

    private func closeError(_ payload: Data) -> AidanError {
        var code = 0
        var reason = ""
        if payload.count >= 2 {
            code = (Int(payload[0]) << 8) | Int(payload[1])
            if payload.count > 2 {
                reason = String(data: payload.subdata(in: 2..<payload.count), encoding: .utf8) ?? ""
            }
        }
        let lowered = reason.lowercased()
        if code == 1009 || lowered.contains("payload") || lowered.contains("too large") {
            return .payloadTooLarge
        }
        return .protocol("The relay closed the connection.")
    }

    private func sendPong(_ payload: Data) throws {
        try sendFrame(opcode: 0xA, payload: payload)
    }

    private func readExact(_ count: Int) throws -> Data {
        if count == 0 { return Data() }
        var data = Data()
        data.reserveCapacity(count)
        while data.count < count {
            var buffer = [UInt8](repeating: 0, count: count - data.count)
            let got = buffer.withUnsafeMutableBytes { raw -> Int in
                lock.lock()
                let fd = socket
                lock.unlock()
                if fd < 0 { return 0 }
                return readFd(fd, raw.baseAddress, raw.count)
            }
            if got == 0 { throw AidanError.io("The relay closed the connection.") }
            if got < 0 {
                if errno == EINTR { continue }
                if errno == EAGAIN || errno == EWOULDBLOCK || errno == ETIMEDOUT { continue }
                throw AidanError.io("Lost the relay connection.")
            }
            data.append(buffer, count: got)
        }
        return data
    }

    private func writeAll(_ data: Data) throws {
        lock.lock()
        defer { lock.unlock() }
        var offset = 0
        let bytes = [UInt8](data)
        while offset < bytes.count {
            let fd = socket
            if fd < 0 { throw AidanError.io("Could not talk to the relay.") }
            let wrote = bytes.withUnsafeBytes { raw -> Int in
                writeFd(fd, raw.baseAddress! + offset, bytes.count - offset)
            }
            if wrote < 0 {
                if errno == EINTR { continue }
                throw AidanError.io("Could not talk to the relay.")
            }
            offset += wrote
        }
    }
    #endif
}

private final class ErrorBox: @unchecked Sendable {
    var error: Error?
}

protocol SyncHost: AnyObject {
    var maxSyncBytes: Int { get }
    func documentIds() -> [String]
    func takeOutgoing(docId: String) -> (type: String, bytes: Data, heads: String)?
    func syncHeads(docId: String) -> String
    func applyIncoming(docId: String, bytes: Data) throws
    func markUnavailable(docId: String)
    func settled(docId: String)
    func linkClosed()
    func linkFailed(_ error: Error)
    func noteTooLarge(docId: String)
    func noteSent(docId: String)
}

struct RelayAddress {
    let host: String
    let port: UInt16
    let path: String
    let secure: Bool
    var canonicalURL: String { "\(secure ? "wss" : "ws")://\(host):\(port)\(path)" }

    // Release builds can never enable loopback credentials. Debug test bundles
    // opt in explicitly; ordinary debug apps also refuse loopback by default.
    static var testLoopback: Bool {
        #if DEBUG
        return ProcessInfo.processInfo.environment["AIDANOS_CLIENT_TEST_MODE"] == "1"
        #else
        return false
        #endif
    }

    static func approved(_ raw: String, paired: String?) throws -> RelayAddress {
        let address = try RelayAddress(raw)
        if raw == paired { return address }
        #if DEBUG
        // Existing simulator fixtures only; never compiled into release.
        if paired == nil && testLoopback && address.host == "127.0.0.1" { return address }
        #endif
        throw AidanError.protocol("Pair this exact relay address before connecting; address changes require re-pairing.")
    }

    static func isTailscaleIPv4(_ host: String) -> Bool {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return false }
        let bytes = parts.compactMap { UInt8($0) }
        guard bytes.count == 4, zip(parts, bytes).allSatisfy({ String($0.0) == String($0.1) }) else { return false }
        return bytes[0] == 100 && bytes[1] >= 64 && bytes[1] <= 127
    }

    static func isMagicDNS(_ host: String) -> Bool {
        guard host.hasSuffix(".ts.net"), host.count <= 253 else { return false }
        return host.split(separator: ".", omittingEmptySubsequences: false).allSatisfy { label in
            guard !label.isEmpty, label.count <= 63, label.first != "-", label.last != "-" else { return false }
            return label.utf8.allSatisfy { ($0 >= 97 && $0 <= 122) || ($0 >= 48 && $0 <= 57) || $0 == 45 }
        }
    }

    init(_ raw: String, allowTestLoopback: Bool = RelayAddress.testLoopback) throws {
        #if DEBUG
        let schemes = ["ws", "wss"]
        #else
        let schemes = ["wss"]
        #endif
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              schemes.contains(scheme), let host = url.host?.lowercased(), !host.isEmpty,
              url.user == nil, url.password == nil, url.query == nil, url.fragment == nil,
              url.path.isEmpty || url.path == "/" else {
            throw AidanError.protocol("Use the exact paired relay address.")
        }
        let secure = scheme == "wss"
        #if DEBUG
        let testLocal = allowTestLoopback && host == "127.0.0.1"
        #else
        let testLocal = false
        #endif
        // This is syntax validation only, never proof of peer identity/encryption.
        // Credential use also requires exact pairing; release requires pinned TLS.
        guard Self.isTailscaleIPv4(host) || (secure && Self.isMagicDNS(host)) || testLocal else {
            throw AidanError.protocol("Credentials are sent only to Tailscale IPv4 or verified wss:// .ts.net endpoints.")
        }
        self.host = host
        self.secure = secure
        if let explicit = url.port {
            guard let port = UInt16(exactly: explicit), port > 0 else {
                throw AidanError.protocol("The relay port must be between 1 and 65535.")
            }
            self.port = port
        } else {
            self.port = secure ? 443 : 80
        }
        self.path = "/"
    }
}

private func encodeJoin(senderId: String, storageId: String) -> Data {
    CBOR.map([
        "type": .text("join"),
        "senderId": .text(senderId),
        "supportedProtocolVersions": .array([.text("1")]),
        "peerMetadata": CBOR.map([
            "storageId": .text(storageId),
            "isEphemeral": .bool(false),
        ]),
    ]).encode()
}

private func encodeSync(type: String, sender: String, target: String, docId: String, data: Data) -> Data {
    CBOR.map([
        "type": .text(type),
        "senderId": .text(sender),
        "targetId": .text(target),
        "documentId": .text(docId),
        "data": .bytes(data),
    ]).encode()
}

#if DEBUG
private func connectTCP(host: String, port: UInt16) throws -> Int32 {
    var hints = addrinfo()
    hints.ai_family = AF_INET
    #if canImport(Darwin)
    hints.ai_socktype = SOCK_STREAM
    hints.ai_protocol = IPPROTO_TCP
    #else
    hints.ai_socktype = Int32(SOCK_STREAM.rawValue)
    hints.ai_protocol = Int32(IPPROTO_TCP)
    #endif
    var info: UnsafeMutablePointer<addrinfo>?
    let result = host.withCString { hostPointer in
        String(port).withCString { portPointer in
            getaddrinfo(hostPointer, portPointer, &hints, &info)
        }
    }
    if result != 0 || info == nil {
        throw AidanError.io("Could not find \(host).")
    }
    defer { freeaddrinfo(info) }
    let fd = socket(info!.pointee.ai_family, info!.pointee.ai_socktype, info!.pointee.ai_protocol)
    if fd < 0 { throw AidanError.io("Could not open a connection.") }
    if connect(fd, info!.pointee.ai_addr, info!.pointee.ai_addrlen) != 0 {
        _ = closeFd(fd)
        throw AidanError.io("Could not reach the relay at \(host):\(port).")
    }
    var timeout = timeval(tv_sec: 0, tv_usec: 200_000)
    _ = setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &timeout, socklen_t(MemoryLayout<timeval>.size))
    var nodelay: Int32 = 1
    _ = setsockopt(fd, Int32(IPPROTO_TCP), TCP_NODELAY, &nodelay, socklen_t(MemoryLayout<Int32>.size))
    return fd
}

private func readFd(_ fd: Int32, _ buffer: UnsafeMutableRawPointer?, _ count: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.read(fd, buffer, count)
    #else
    return Glibc.read(fd, buffer, count)
    #endif
}

private func writeFd(_ fd: Int32, _ buffer: UnsafeRawPointer, _ count: Int) -> Int {
    #if canImport(Darwin)
    return Darwin.write(fd, buffer, count)
    #else
    return Glibc.write(fd, buffer, count)
    #endif
}

private func closeFd(_ fd: Int32) -> Int32 {
    #if canImport(Darwin)
    return Darwin.close(fd)
    #else
    return Glibc.close(fd)
    #endif
}

#endif
