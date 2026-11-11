import SwiftUI
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
import CoreImage.CIFilterBuiltins
#elseif os(iOS)
import AVFoundation
import VisionKit
import Vision
#endif

@main
struct AidanOSApp: App {
    var body: some Scene {
        WindowGroup {
            TodayScreen()
        }
    }
}

struct TodayScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = TodayModel()
    @State private var importingPairing = false
    @State private var scanningPairing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(model.status)
                .font(.caption)
            TextField("Relay address", text: $model.address)
                .textFieldStyle(.roundedBorder)
            SecureField("Token", text: $model.token)
                .textFieldStyle(.roundedBorder)
            #if DEBUG
            Button("Pair exact debug ws address (disposable only)") { model.pairExactRelay() }
            #endif
            #if os(macOS)
            Button("Open relay public pairing JSON") { importingPairing = true }
            if let image = pairingQR(model.pairingQRString) {
                Image(nsImage: image).interpolation(.none).resizable().frame(width: 220, height: 220)
                Text("Scan this QR from the approved Mac. It contains no token or private key.").font(.caption)
            }
            #else
            Button("Pair / re-pair from Mac QR") {
                AVCaptureDevice.requestAccess(for: .video) { permitted in
                    DispatchQueue.main.async {
                        if permitted { scanningPairing = true }
                        else { model.status = "Camera permission is required to scan the approved Mac QR." }
                    }
                }
            }
            #endif
            Button("Connect") { model.connect() }
            if let conflict = model.conflict {
                Text(conflict.reason)
                    .font(.caption)
                HStack {
                    Button("Keep mine") { model.choose(.keepMine) }
                    Button("Take theirs") { model.choose(.takeTheirs) }
                    Button("Edit") { model.beginConflictEdit() }
                }
                if model.draftingConflict {
                    Button("Save edit") { model.saveConflictEdit() }
                }
            }
            NoteEditor(text: $model.text, editable: model.conflict == nil || model.draftingConflict) { base, edited in
                model.userEdited(base: base, edited: edited)
            }
        }
        .padding()
        #if os(macOS)
        .fileImporter(isPresented: $importingPairing, allowedContentTypes: [.json]) { result in
            do {
                let url = try result.get()
                let access = url.startAccessingSecurityScopedResource()
                defer { if access { url.stopAccessingSecurityScopedResource() } }
                model.importPairingQR(try String(contentsOf: url, encoding: .utf8))
            } catch { model.status = "Public pairing file could not be read." }
        }
        #else
        .sheet(isPresented: $scanningPairing) {
            if DataScannerViewController.isSupported && DataScannerViewController.isAvailable {
                RelayQRScanner { raw in model.importPairingQR(raw); scanningPairing = false }
            } else { Text("QR camera unavailable. Pair on a supported real iPhone; do not weaken trust checks.") }
        }
        #endif
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { model.considerDay() }
        }
    }
}

#if os(macOS)
private func pairingQR(_ text: String) -> NSImage? {
    guard !text.isEmpty else { return nil }
    let filter = CIFilter.qrCodeGenerator()
    filter.message = Data(text.utf8)
    filter.correctionLevel = "M"
    guard let output = filter.outputImage,
          let image = CIContext().createCGImage(output, from: output.extent) else { return nil }
    return NSImage(cgImage: image, size: NSSize(width: output.extent.width, height: output.extent.height))
}
#elseif os(iOS)
private struct RelayQRScanner: UIViewControllerRepresentable {
    let onScan: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(onScan: onScan) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])],
            qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false,
            isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        do { try controller.startScanning() } catch { /* unavailable remains fail-closed */ }
        return controller
    }
    func updateUIViewController(_ controller: DataScannerViewController, context: Context) {}
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let onScan: (String) -> Void
        init(onScan: @escaping (String) -> Void) { self.onScan = onScan }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems {
                if case .barcode(let barcode) = item, let raw = barcode.payloadStringValue {
                    dataScanner.stopScanning(); onScan(raw); return
                }
            }
        }
    }
}
#endif
