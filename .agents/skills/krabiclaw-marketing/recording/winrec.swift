// Records one Google Chrome window to a .mov until SIGINT, whatever covers it on screen.
// The window is the recording window rec.py opens: x = 0, width 1728 points.
// Build: swiftc -O winrec.swift -o winrec   Usage: winrec <out.mov>
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
setvbuf(stdout, nil, _IONBF, 0)  // rec.py waits for the "recording" line
let out = URL(fileURLWithPath: CommandLine.arguments[1])

final class Delegate: NSObject, SCStreamDelegate, SCRecordingOutputDelegate {
  func recordingOutputDidFinishRecording(_ r: SCRecordingOutput) { print("finished"); exit(0) }
  func recordingOutput(_ r: SCRecordingOutput, didFailWithError e: Error) { print("fail \(e)"); exit(1) }
  func stream(_ s: SCStream, didStopWithError e: Error) { print("stop \(e)"); exit(1) }
}
let delegate = Delegate()
var stream: SCStream?

Task { @MainActor in
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
    guard let w = content.windows.first(where: { $0.owningApplication?.applicationName == "Google Chrome" && Int($0.frame.origin.x) == 0 && Int($0.frame.width) == 1728 && $0.frame.height > 900 }) else { print("no window"); exit(2) }
    print("window \(w.windowID) \(w.frame) \(w.title ?? "")")
    let config = SCStreamConfiguration()
    config.width = 3456; config.height = 1944
    config.minimumFrameInterval = CMTime(value: 1, timescale: 30)
    config.showsCursor = true
    config.scalesToFit = true
    let s = SCStream(filter: SCContentFilter(desktopIndependentWindow: w), configuration: config, delegate: delegate)
    let recording = SCRecordingOutputConfiguration()
    recording.outputURL = out; recording.outputFileType = .mov; recording.videoCodecType = .h264
    try s.addRecordingOutput(SCRecordingOutput(configuration: recording, delegate: delegate))
    try await s.startCapture()
    stream = s
    print("recording")
  } catch {
    print("fail \(error)"); exit(1)
  }
}

signal(SIGINT, SIG_IGN)
let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
interrupt.setEventHandler { Task { try? await stream?.stopCapture(); try? await Task.sleep(nanoseconds: 3_000_000_000); exit(0) } }
interrupt.resume()
app.run()
