// swift-tools-version: 5.10
import Foundation
import PackageDescription

// Linux uses the automerge-swift 0.7.2 sources with the Linux refusal removed,
// built by native/scripts/build-linux-ffi.sh. Mac and iOS use the published package.
#if os(Linux)
let automerge: Package.Dependency = .package(path: "../.cache/automerge-swift")
#else
let automerge: Package.Dependency = .package(
    url: "https://github.com/automerge/automerge-swift",
    exact: "0.7.2"
)
#endif

#if os(Linux)
// The Rust engine is a static library. SwiftPM does not pass that archive
// through to the final test binary, so the Linux build names it here.
let engine = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent()
    .deletingLastPathComponent()
    .appendingPathComponent(".cache/automerge-swift/rust/target/release")
    .path
let linuxLink: [LinkerSetting] = [
    .unsafeFlags([
        "-L\(engine)",
        "-Xlinker", "-luniffi_automerge",
        "-Xlinker", "-lpthread",
        "-Xlinker", "-ldl",
        "-Xlinker", "-lm",
    ]),
]
#else
let linuxLink: [LinkerSetting] = []
#endif

let package = Package(
    name: "AidanCore",
    platforms: [
        .macOS(.v14),
        .iOS(.v17),
    ],
    products: [
        .library(name: "AidanCore", targets: ["AidanCore"]),
    ],
    dependencies: [
        automerge,
        .package(url: "https://github.com/apple/swift-crypto.git", from: "3.10.0"),
    ],
    targets: [
        .target(
            name: "AidanCore",
            dependencies: [
                .product(name: "Automerge", package: "automerge-swift"),
                .product(name: "Crypto", package: "swift-crypto"),
            ],
            linkerSettings: linuxLink
        ),
        .testTarget(
            name: "AidanCoreTests",
            dependencies: ["AidanCore"],
            linkerSettings: linuxLink
        ),
    ]
)
