import Foundation
#if canImport(Security)
import Security
#endif

// Apple-only TLS WebSocket adapter. The system validates the certificate chain
// and hostname; no trust override, redirect, or plaintext fallback is allowed.
#if canImport(Darwin)
private final class RelayTLSDelegate: NSObject, URLSessionTaskDelegate {
    private let pairing: RelayPairing
    init(pairing: RelayPairing) { self.pairing = pairing }

    private func verify(_ challenge: URLAuthenticationChallenge,
                        completion: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        guard challenge.protectionSpace.authenticationMethod == NSURLAuthenticationMethodServerTrust,
              let trust = challenge.protectionSpace.serverTrust,
              let approved = try? pairing.validatedAddress(),
              SecTrustSetPolicies(trust, SecPolicyCreateSSL(true, approved.host as CFString)) == errSecSuccess,
              SecTrustEvaluateWithError(trust, nil),
              let certificate = SecTrustGetCertificateAtIndex(trust, 0),
              let fingerprint = try? RelaySPKI.fingerprint(certificateDER: SecCertificateCopyData(certificate) as Data),
              fingerprint == pairing.spki else {
            completion(.cancelAuthenticationChallenge, nil); return
        }
        // System chain/hostname AND the physically paired SPKI are mandatory.
        // No custom anchors/test CA, trust-on-first-connect, or CA-only fallback.
        completion(.useCredential, URLCredential(trust: trust))
    }
    func urlSession(_ session: URLSession, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        verify(challenge, completion: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, didReceive challenge: URLAuthenticationChallenge,
                    completionHandler: @escaping (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) {
        verify(challenge, completion: completionHandler)
    }
    func urlSession(_ session: URLSession, task: URLSessionTask,
                    willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest,
                    completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

final class RelayTLS {
    private var delegate: RelayTLSDelegate?
    private var session: URLSession?
    private var task: URLSessionWebSocketTask?

    func connect(address: RelayAddress, pairing: RelayPairing, token: String) throws {
        _ = try pairing.destination(address.canonicalURL, resolvedIPv4: RelayPairing.resolveIPv4(address.host))
        // Connect to the stored literal IP, never re-resolve the checked name.
        // The delegate validates the certificate against the approved DNS name.
        guard address.secure, let url = URL(string: "wss://\(pairing.ipv4):\(address.port)/") else {
            throw AidanError.protocol("A verified wss:// Tailscale endpoint is required.")
        }
        var request = URLRequest(url: url)
        request.setValue("\(address.host):\(address.port)", forHTTPHeaderField: "Host")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let config = URLSessionConfiguration.ephemeral
        config.connectionProxyDictionary = [:]
        config.urlCache = nil
        config.tlsMinimumSupportedProtocolVersion = .TLSv12
        config.httpCookieStorage = nil
        config.urlCredentialStorage = nil
        let delegate = RelayTLSDelegate(pairing: pairing)
        self.delegate = delegate
        let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
        let task = session.webSocketTask(with: request)
        task.maximumMessageSize = 32 * 1024 * 1024
        self.session = session
        self.task = task
        task.resume()
    }

    func send(_ data: Data) throws {
        guard let task else { throw AidanError.io("The secure relay is not connected.") }
        let done = DispatchSemaphore(value: 0)
        var failure: Error?
        task.send(.data(data)) { error in failure = error; done.signal() }
        if done.wait(timeout: .now() + 15) == .timedOut {
            close()
            throw AidanError.io("The secure relay did not answer.")
        }
        if let failure { throw failure }
    }

    func receive() throws -> Data {
        guard let task else { throw AidanError.io("The secure relay is not connected.") }
        let done = DispatchSemaphore(value: 0)
        var answer: Result<URLSessionWebSocketTask.Message, Error>?
        task.receive { result in answer = result; done.signal() }
        // Cancellation in close() completes a pending receive. Idle connections
        // need no artificial deadline; URLSession handles WebSocket ping/pong.
        done.wait()
        guard let answer else { throw AidanError.io("The secure relay closed.") }
        switch try answer.get() {
        case .data(let data): return data
        case .string: throw AidanError.protocol("The relay sent a nonbinary sync frame.")
        @unknown default: throw AidanError.protocol("The relay sent an unknown frame.")
        }
    }

    func close() {
        task?.cancel(with: .goingAway, reason: nil)
        session?.invalidateAndCancel()
    }
}
#else
// Linux has no TLS backend in this cut. It must fail closed, never send a wss
// credential through the raw TCP fallback. Apple builds exercise the real path.
final class RelayTLS {
    func connect(address: RelayAddress, pairing: RelayPairing, token: String) throws {
        throw AidanError.protocol("Secure relay transport requires the Apple client in this cut.")
    }
    func send(_ data: Data) throws { throw AidanError.io("Secure relay unavailable.") }
    func receive() throws -> Data { throw AidanError.io("Secure relay unavailable.") }
    func close() {}
}
#endif
