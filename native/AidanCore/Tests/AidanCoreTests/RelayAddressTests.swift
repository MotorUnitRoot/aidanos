import Foundation
@testable import AidanCore
import XCTest

// Not executed on the Linux box: run this target on Mac and iOS before use.
final class RelayAddressTests: XCTestCase {
    func testDirectTailscaleIPv4AndBoundaries() throws {
        for host in ["100.64.0.0", "100.100.1.20", "100.127.255.255"] {
            #if DEBUG
            let address = try RelayAddress("ws://\(host):3750", allowTestLoopback: false)
            XCTAssertEqual(address.host, host)
            XCTAssertEqual(address.port, 3750)
            XCTAssertFalse(address.secure)
            #else
            XCTAssertThrowsError(try RelayAddress("ws://\(host):3750", allowTestLoopback: false))
            #endif
        }
        for host in ["100.63.255.255", "100.128.0.0", "10.1.2.3", "192.168.1.20", "203.0.113.8"] {
            XCTAssertThrowsError(try RelayAddress("ws://\(host):3750", allowTestLoopback: false))
        }
        XCTAssertFalse(RelayAddress.isTailscaleIPv4("100.064.0.1"))
        XCTAssertFalse(RelayAddress.isTailscaleIPv4("100.64.0.256"))
    }

    func testMagicDNSRequiresVerifiedWSS() throws {
        let address = try RelayAddress("wss://relay.tail.ts.net", allowTestLoopback: false)
        XCTAssertTrue(address.secure)
        XCTAssertEqual(address.port, 443)
        XCTAssertEqual(address.canonicalURL, "wss://relay.tail.ts.net:443/")
        XCTAssertThrowsError(try RelayAddress("ws://relay.tail.ts.net:3750", allowTestLoopback: false))
        for host in ["ts.net", "evilts.net", "relay.ts.net.evil.example", "evil.example", "-bad.ts.net"] {
            XCTAssertThrowsError(try RelayAddress("wss://\(host)", allowTestLoopback: false))
        }
    }

    func testSchemesAndCredentialBearingURLPartsAreRefused() {
        for raw in ["http://100.100.1.20", "https://relay.tail.ts.net", "ftp://100.100.1.20",
                    "ws://user:password@100.100.1.20:3750", "ws://100.100.1.20:3750?token=fixture",
                    "ws://100.100.1.20:3750#fragment", "ws://100.100.1.20:3750/unapproved-path"] {
            XCTAssertThrowsError(try RelayAddress(raw, allowTestLoopback: false))
        }
    }

    func testLoopbackNeedsExplicitTestException() throws {
        XCTAssertThrowsError(try RelayAddress("ws://127.0.0.1:3750", allowTestLoopback: false))
        #if DEBUG
        XCTAssertEqual(try RelayAddress("ws://127.0.0.1:3750", allowTestLoopback: true).host, "127.0.0.1")
        #else
        XCTAssertThrowsError(try RelayAddress("ws://127.0.0.1:3750", allowTestLoopback: true))
        #endif
        for raw in ["ws://localhost:3750", "ws://[::1]:3750", "ws://[fd7a:115c:a1e0::1]:3750"] {
            XCTAssertThrowsError(try RelayAddress(raw, allowTestLoopback: false))
        }
    }

    func testExactPairedAddressRequiredBeforeCredentialUse() throws {
        let paired = "wss://relay.tail.ts.net:443/"
        XCTAssertEqual(try RelayAddress.approved(paired, paired: paired).canonicalURL, paired)
        for candidate in ["wss://other.tail.ts.net:443/", "wss://relay.tail.ts.net:444/", "wss://100.100.1.20:443/", "wss://relay.tail.ts.net"] {
            XCTAssertThrowsError(try RelayAddress.approved(candidate, paired: paired))
        }
        XCTAssertThrowsError(try RelayAddress.approved(paired, paired: nil))
        XCTAssertThrowsError(try RelayAddress.approved(paired, paired: ""))
    }

    func testPairingBindsNameIPAddressAndSPKI() throws {
        let pin = "sha256/" + Data(repeating: 7, count: 32).base64EncodedString()
        let bytes = try JSONSerialization.data(withJSONObject: ["version": 1, "address": "wss://relay.tail.ts.net:3750/", "ipv4": "100.100.1.20", "spki": pin])
        let pairing = try RelayPairing(qrData: bytes)
        XCTAssertNoThrow(try pairing.destination(pairing.address, resolvedIPv4: ["100.100.1.20"]))
        for answers in [[], ["100.100.1.21"], ["203.0.113.7"], ["100.100.1.20", "203.0.113.7"]] {
            XCTAssertThrowsError(try pairing.destination(pairing.address, resolvedIPv4: answers))
        }
        XCTAssertThrowsError(try pairing.destination("wss://other.tail.ts.net:3750/", resolvedIPv4: ["100.100.1.20"]))
        XCTAssertThrowsError(try RelayPairing(qrData: Data("{\"version\":1,\"address\":\"wss://relay.tail.ts.net:3750/\",\"ipv4\":\"100.100.1.20\",\"spki\":\"bad\"}".utf8)))
    }

    func testValidPortsAndSecureDefault() throws {
        for port in [0, 65536] {
            XCTAssertThrowsError(try RelayAddress("ws://100.100.1.20:\(port)", allowTestLoopback: false))
        }
        XCTAssertEqual(try RelayAddress("wss://100.100.1.20", allowTestLoopback: false).port, 443)
        #if DEBUG
        XCTAssertEqual(try RelayAddress("ws://100.100.1.20:65535", allowTestLoopback: false).port, 65535)
        #else
        XCTAssertThrowsError(try RelayAddress("ws://100.100.1.20:65535", allowTestLoopback: false))
        #endif
    }
}
