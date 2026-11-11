@testable import AidanCore
import XCTest

// Not executed on the Linux box: run this target on Mac and iOS before use.
final class RelayAddressTests: XCTestCase {
    func testDirectTailscaleIPv4AndBoundaries() throws {
        for host in ["100.64.0.0", "100.100.1.20", "100.127.255.255"] {
            let address = try RelayAddress("ws://\(host):3750", allowTestLoopback: false)
            XCTAssertEqual(address.host, host)
            XCTAssertEqual(address.port, 3750)
            XCTAssertFalse(address.secure)
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
        XCTAssertEqual(try RelayAddress("ws://127.0.0.1:3750", allowTestLoopback: true).host, "127.0.0.1")
        for raw in ["ws://localhost:3750", "ws://[::1]:3750", "ws://[fd7a:115c:a1e0::1]:3750"] {
            XCTAssertThrowsError(try RelayAddress(raw, allowTestLoopback: false))
        }
    }

    func testValidPortsAndSecureDefault() throws {
        for port in [0, 65536] {
            XCTAssertThrowsError(try RelayAddress("ws://100.100.1.20:\(port)", allowTestLoopback: false))
        }
        XCTAssertEqual(try RelayAddress("wss://100.100.1.20", allowTestLoopback: false).port, 443)
        XCTAssertEqual(try RelayAddress("ws://100.100.1.20:65535", allowTestLoopback: false).port, 65535)
    }
}
