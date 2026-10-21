import Foundation

#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#endif

/// A small WebSocket client. It speaks the automerge-repo sync protocol to the relay.
final class RelayLink {
    private let queue = DispatchQueue(label: "aidanos.relay")
    private let lock = NSLock()
    private var socket: Int32 = -1
    private var running = false
    private var serverId = ""
    private var peerId = ""
    private var storageId = ""
    private weak var host: SyncHost?
    private var ready: (() -> Void)?
    private var failed: ((Error) -> Void)?

    func connect(url: String, token: String, peerId: String, storageId: String, host: SyncHost) throws {
        _ = signal(SIGPIPE, SIG_IGN)
        let parsed = try RelayAddress(url)
        self.peerId = peerId
        self.storageId = storageId
        self.host = host
        let fd = try connectTCP(host: parsed.host, port: parsed.port)
        socket = fd
        try upgrade(fd: fd, address: parsed, token: token)
        running = true
        let joined = DispatchSemaphore(value: 0)
        var joinError: Error?
        ready = { joined.signal() }
        failed = { error in
            joinError = error
            joined.signal()
        }
        queue.async { [weak self] in
            self?.readLoop()
        }
        try send(encodeJoin(senderId: peerId, storageId: storageId))
        let wait = joined.wait(timeout: .now() + 5)
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
        let fd = socket
        socket = -1
        lock.unlock()
        if fd >= 0 { _ = shutdown(fd, Int32(SHUT_RDWR)); _ = closeFd(fd) }
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
            do {
                try send(encodeSync(type: outgoing.type, sender: peerId, target: server, docId: docId, data: outgoing.bytes))
            } catch {
                return
            }
            sent += 1
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
            let alive = running && socket >= 0
            lock.unlock()
            if !alive { return }
            do {
                guard let frame = try readFrame() else { continue }
                try handle(frame)
            } catch {
                lock.lock()
                let alive = running
                lock.unlock()
                if alive {
                    failed?(error)
                    failed = nil
                    ready = nil
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
            let callback = ready
            ready = nil
            failed = nil
            callback?()
            pumpAll()
        case "sync", "request":
            guard let docId = message["documentId"]?.textValue, let bytes = message["data"]?.bytesValue else { return }
            try host?.applyIncoming(docId: docId, bytes: bytes)
            pump(docId)
        case "doc-unavailable":
            if let docId = message["documentId"]?.textValue {
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
        var header = Data()
        header.append(0x82)
        let length = data.count
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
        var payload = Data(data)
        for index in payload.indices {
            payload[index] ^= mask[index % 4]
        }
        header.append(payload)
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
        let deadline = Date().addingTimeInterval(8)
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
        guard let first = try readExact(2) else { return nil }
        let opcode = first[0] & 0x0F
        var length = Int(first[1] & 0x7F)
        let masked = (first[1] & 0x80) != 0
        if length == 126 {
            guard let extra = try readExact(2) else { return nil }
            length = Int(extra[0]) << 8 | Int(extra[1])
        } else if length == 127 {
            guard let extra = try readExact(8) else { return nil }
            length = 0
            for byte in extra { length = (length << 8) | Int(byte) }
        }
        var mask = [UInt8](repeating: 0, count: 4)
        if masked {
            guard let maskBytes = try readExact(4) else { return nil }
            mask = Array(maskBytes)
        }
        guard length >= 0, length <= 8_000_000, var payload = try readExact(length) else { return nil }
        if masked {
            for index in payload.indices { payload[index] ^= mask[index % 4] }
        }
        if opcode == 0x8 { throw AidanError.protocol("The relay closed the connection.") }
        if opcode == 0x9 {
            try sendPong(payload)
            return nil
        }
        if opcode == 0xA { return nil }
        if opcode != 0x2 && opcode != 0x0 { return nil }
        return payload
    }

    private func sendPong(_ payload: Data) throws {
        var frame = Data([0x8A])
        frame.append(UInt8(payload.count))
        frame.append(payload)
        try writeAll(frame)
    }

    private func readExact(_ count: Int) throws -> Data? {
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
            if got == 0 { return nil }
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
}

protocol SyncHost: AnyObject {
    func documentIds() -> [String]
    func takeOutgoing(docId: String) -> (type: String, bytes: Data)?
    func applyIncoming(docId: String, bytes: Data) throws
    func markUnavailable(docId: String)
    func settled(docId: String)
}

private struct RelayAddress {
    var host: String
    var port: UInt16
    var path: String

    init(_ raw: String) throws {
        guard let url = URL(string: raw), let host = url.host, !host.isEmpty else {
            throw AidanError.protocol("The relay address should look like ws://127.0.0.1:3750")
        }
        if url.scheme == "wss" {
            throw AidanError.protocol("This cut uses plain ws:// on your home network.")
        }
        self.host = host
        if let explicit = url.port {
            self.port = UInt16(explicit)
        } else {
            self.port = 80
        }
        self.path = url.path.isEmpty ? "/" : url.path
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
