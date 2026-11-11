import Foundation
import Crypto
@testable import AidanCore
import XCTest
#if canImport(Security)
import Security
#endif

// Public DER fixtures from an offline local CA. NO private key is committed.
// Only this test target contains the test CA, never the production library/app.
final class RelayTLSTests: XCTestCase {
    private let leaf = Data(base64Encoded: "MIIB2DCCAX6gAwIBAgIUSUZz0/ZL3GWqAN1tflM/z4NneNkwCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwaQWlkYW5PUyBEaXNwb3NhYmxlIFRlc3QgQ0EwHhcNMjYxMTExMDYyNjAzWhcNMjYxMTEyMDYyNjAzWjAfMR0wGwYDVQQDDBRyZWxheS5maXh0dXJlLnRzLm5ldDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABAzHts7JMyzKGylgOZ8HWRidm0jThnnwGFAA+zPwkSuQ/zj6kLuxnrlGy0wk83oUWgJdxsQT2PLRQTRTT/NtMA+jgZEwgY4wHwYDVR0RBBgwFoIUcmVsYXkuZml4dHVyZS50cy5uZXQwCQYDVR0TBAIwADALBgNVHQ8EBAMCB4AwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFH4eiPyimuAq7LGzM8t5NbC74MnZMB8GA1UdIwQYMBaAFKnsmQopt4V5khTLdT/HeZSvx6F3MAoGCCqGSM49BAMCA0gAMEUCICnrZAKXThizArrLKZMcC0tI0VoNQBgf4lvlxEaXhdHyAiEA8vWhsaL+gHbiKYb5bDgZIZFkUV02DO5x1esnKACsQbM=")!
    private let root = Data(base64Encoded: "MIIBnjCCAUWgAwIBAgIUalhvk3WD2nlNygh1jppxBxxoUmAwCgYIKoZIzj0EAwIwJTEjMCEGA1UEAwwaQWlkYW5PUyBEaXNwb3NhYmxlIFRlc3QgQ0EwHhcNMjYxMTExMDYyNjAzWhcNMjYxMTEyMDYyNjAzWjAlMSMwIQYDVQQDDBpBaWRhbk9TIERpc3Bvc2FibGUgVGVzdCBDQTBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABIgJppwGKLdWnRIwPYvQzqjSrBRKuCsMdoi7INn7uvdhsvdKn6HPQvCq2QW6bEreTZ9r5ZsNyK+oPCSkkdb1d0CjUzBRMB0GA1UdDgQWBBSp7JkKKbeFeZIUy3U/x3mUr8ehdzAfBgNVHSMEGDAWgBSp7JkKKbeFeZIUy3U/x3mUr8ehdzAPBgNVHRMBAf8EBTADAQH/MAoGCCqGSM49BAMCA0cAMEQCIG+qzKCJJkPL/1uRwKHj5liJEGi6LXwpUH/uKve0ebOVAiBOLmOqxWjCwAbk8+3vdYHTwVh9GQJEBX208vWE3wq7vw==")!
    private let pin = "sha256/h+1ZkAnEbTiY8bX5sXBVjNXPAjFfWaeBElHybDxbvIs="
    func testRealCertificateSPKIUsesDERSubjectPublicKeyInfo() throws {
        XCTAssertEqual(try RelaySPKI.fingerprint(certificateDER: leaf), pin)
        XCTAssertThrowsError(try RelaySPKI.fingerprint(certificateDER: Data(leaf.prefix(15))))
    }
    #if canImport(Security)
    func testProductionSystemTrustRejectsOurLocalTestCA() throws {
        let certificate = try XCTUnwrap(SecCertificateCreateWithData(nil, leaf as CFData))
        let authority = try XCTUnwrap(SecCertificateCreateWithData(nil, root as CFData))
        var trust: SecTrust?
        XCTAssertEqual(SecTrustCreateWithCertificates([certificate, authority] as CFArray,
            SecPolicyCreateSSL(true, "relay.fixture.ts.net" as CFString), &trust), errSecSuccess)
        let evaluated = try XCTUnwrap(trust)
        // Freeze only this static certificate fixture's validation date.
        SecTrustSetVerifyDate(evaluated, Date(timeIntervalSince1970: 1794378363) as CFDate)
        XCTAssertFalse(SecTrustEvaluateWithError(evaluated, nil))
        // Explicit fixture anchoring is present ONLY in this test target.
        XCTAssertEqual(SecTrustSetAnchorCertificates(evaluated, [authority] as CFArray), errSecSuccess)
        XCTAssertEqual(SecTrustSetAnchorCertificatesOnly(evaluated, true), errSecSuccess)
        XCTAssertTrue(SecTrustEvaluateWithError(evaluated, nil))
        XCTAssertEqual(SecTrustSetPolicies(evaluated, SecPolicyCreateSSL(true, "wrong.fixture.ts.net" as CFString)), errSecSuccess)
        XCTAssertFalse(SecTrustEvaluateWithError(evaluated, nil))
    }
    #endif
}
