// Records one Google Chrome window to a .mov until SIGINT, whatever covers it on screen.
// The window must match rec.py's selected title and complete recording frame.
// Build: swiftc -O winrec.swift -o winrec   Usage: winrec <out.mov> <title> <x> <y> <width> <height>
import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation

let app = NSApplication.shared
app.setActivationPolicy(.prohibited)
setvbuf(stdout, nil, _IONBF, 0)  // rec.py waits for the "recording" line
let geometry = CommandLine.arguments.dropFirst(3).compactMap(Double.init)
guard CommandLine.arguments.count == 7, !CommandLine.arguments[2].isEmpty,
  geometry.count == 4, geometry[2] > 0, geometry[3] > 0 else {
  print("usage: winrec <out.mov> <title> <x> <y> <width> <height>")
  exit(2)
}
let out = URL(fileURLWithPath: CommandLine.arguments[1])
let title = CommandLine.arguments[2]
let frame = CGRect(x: geometry[0], y: geometry[1], width: geometry[2], height: geometry[3])

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
    let matches = content.windows.filter {
      $0.owningApplication?.applicationName == "Google Chrome" && $0.title == title
        && $0.frame == frame
    }
    guard matches.count == 1 else {
      print("expected exactly one Chrome recording window titled \(title), found \(matches.count)")
      exit(2)
    }
    let w = matches[0]
    print("window \(w.windowID) \(w.frame) \(w.title ?? "")")
    let config = SCStreamConfiguration()
    config.width = Int(frame.width * 2); config.height = Int(frame.height * 2)
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
interrupt.setEventHandler {
  Task {
    guard let stream else { print("fail recording has not started"); exit(1) }
    do { try await stream.stopCapture() }
    catch { print("fail stopping recording: \(error)"); exit(1) }
  }
}
interrupt.resume()
app.run()
