// Uses the ScreenCaptureKit app-to-window workaround and Vision OCR from
// macos-wechat-export (MIT), 88ca1bef06279f3bc9fa27a379b417f71b6e88a5. See LICENSE.
import Cocoa
import CoreImage
import CoreMedia
import ScreenCaptureKit
import Vision

enum ResultCode: String, Error {
    case passed, permission_required, login_required, gui_not_verified
}

final class LatestFrame: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private let context = CIContext()
    private var frame: (Int, CGImage)?
    private var accepting = false
    func beginAcceptingFrames() {
        lock.lock()
        accepting = true
        lock.unlock()
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid, let pixel = sample.imageBuffer,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[SCStreamFrameInfo: Any]],
              attachments.first?[.status] as? Int == SCFrameStatus.complete.rawValue else { return }
        let input = CIImage(cvPixelBuffer: pixel)
        guard let image = context.createCGImage(input, from: input.extent) else { return }
        lock.lock()
        if accepting { frame = ((frame?.0 ?? 0) + 1, image) }
        lock.unlock()
    }
    func latest() -> (Int, CGImage)? {
        lock.lock()
        defer { lock.unlock() }
        return frame
    }
}

func unlocked() -> Bool {
    guard let session = CGSessionCopyCurrentDictionary() as? [String: Any],
          session[kCGSessionOnConsoleKey as String] as? Bool == true,
          session[kCGSessionLoginDoneKey as String] as? Bool == true else { return false }
    return (session["CGSSessionScreenIsLocked"] as? Bool) != true
}

func target() async throws -> (SCWindow, SCDisplay) {
    guard unlocked() else { throw ResultCode.login_required }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    let windows = content.windows.filter {
        $0.owningApplication?.bundleIdentifier == "com.tencent.xinWeChat" &&
        ["Weixin", "WeChat", "微信"].contains($0.title ?? "") &&
        $0.frame.width > 600 && $0.frame.height > 450
    }
    guard windows.count == 1, let window = windows.first,
          let display = content.displays.first(where: { $0.frame.contains(window.frame) }) else {
        throw ResultCode.login_required
    }
    return (window, display)
}

struct TextLine {
    let text: String
    let bounds: CGRect
    let confidence: Float
}

func recognize(_ image: CGImage) throws -> [TextLine] {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(cgImage: image).perform([request])
    return (request.results ?? []).compactMap {
        guard let candidate = $0.topCandidates(1).first else { return nil }
        return TextLine(text: candidate.string, bounds: $0.boundingBox, confidence: candidate.confidence)
    }
}

func normalizedTitle(_ title: String) -> String {
    title.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping
}

func matchesVisibleMessage(_ image: CGImage, title: String, marker: String) throws -> Bool {
    let width = CGFloat(image.width), height = CGFloat(image.height)
    guard let header = image.cropping(to: CGRect(x: 0, y: 0, width: width, height: min(80, height * 0.10)).integral)
    else { return false }
    let matches = try recognize(header).filter {
        normalizedTitle($0.text) == normalizedTitle(title) && $0.confidence >= 0.5 && $0.bounds.minX > 0.15
    }
    guard matches.count == 1 else { return false }
    let panelLeft = max(0, matches[0].bounds.minX * width - 16)
    // The receiving editor must remain empty throughout the test. Also keep the
    // usual input region, title and chat list outside the recognition area.
    let body = CGRect(x: panelLeft, y: height * 0.12, width: width - panelLeft, height: height * 0.61)
    guard let region = image.cropping(to: body.integral) else { return false }
    return try recognize(region).contains {
        $0.confidence >= 0.5 && $0.text.trimmingCharacters(in: .whitespacesAndNewlines) == marker
    }
}

func captureProbe(title: String, marker: String) async throws {
    guard CGPreflightScreenCaptureAccess() else { throw ResultCode.permission_required }
    let (window, display) = try await target()
    guard let app = window.owningApplication else { throw ResultCode.login_required }
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width)
    config.height = Int(window.frame.height)
    config.showsCursor = false
    config.minimumFrameInterval = CMTime(seconds: 0.5, preferredTimescale: 600)
    config.sourceRect = CGRect(x: window.frame.minX - display.frame.minX, y: window.frame.minY - display.frame.minY,
                               width: window.frame.width, height: window.frame.height)
    let initial = SCContentFilter(display: display, including: [app], exceptingWindows: [])
    let stream = SCStream(filter: initial, configuration: config, delegate: nil)
    let output = LatestFrame()
    try stream.addStreamOutput(output, type: .screen, sampleHandlerQueue: DispatchQueue(label: "groupdesk.gui.probe"))
    try await stream.startCapture()
    do {
        // Preserve the legacy workaround but accept frames for OCR only after
        // narrowing the filter to the selected WeChat window.
        try await Task.sleep(for: .milliseconds(250))
        try await stream.updateContentFilter(SCContentFilter(display: display, including: [window]))
        try await Task.sleep(for: .milliseconds(550))
        output.beginAcceptingFrames()
        let clock = ContinuousClock()
        let deadline = clock.now + .seconds(90)
        var sequence = 0
        while clock.now < deadline {
            guard unlocked() else { throw ResultCode.login_required }
            if let (number, image) = output.latest(), number != sequence {
                sequence = number
                let (current, currentDisplay) = try await target()
                guard current.windowID == window.windowID, current.frame == window.frame,
                      currentDisplay.displayID == display.displayID else { throw ResultCode.gui_not_verified }
                if try matchesVisibleMessage(image, title: title, marker: marker) {
                    guard unlocked() else { throw ResultCode.login_required }
                    try await stream.stopCapture()
                    return
                }
            }
            try await Task.sleep(for: .milliseconds(750))
        }
        throw ResultCode.gui_not_verified
    } catch {
        try? await stream.stopCapture()
        throw error
    }
}

@main struct ReadProbe {
    static func main() async {
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "self-test" {
            print("ready")
            return
        }
        // No command for dumping OCR, saving screenshots, switching chats or sending.
        let input = FileHandle.standardInput.readData(ofLength: 4096)
        guard args.count == 1, let body = try? JSONSerialization.jsonObject(with: input) as? [String: String],
              let title = body["title"], !normalizedTitle(title).isEmpty,
              let marker = body["marker"], marker.range(of: #"^GROUPDESK [23456789]{8}$"#, options: .regularExpression) != nil
        else { print(ResultCode.gui_not_verified.rawValue); exit(2) }
        do {
            try await captureProbe(title: title, marker: marker)
            print(ResultCode.passed.rawValue)
        } catch {
            print(((error as? ResultCode) ?? .gui_not_verified).rawValue)
            exit(2)
        }
    }
}
