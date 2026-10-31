import AppKit
import Foundation
import CoreGraphics

class TrackingPad: NSView {
    var changed: (() -> Void)?
    var entries = 0
    var exits = 0
    override var isFlipped: Bool { true }
    override func isAccessibilityElement() -> Bool { true }
    override func accessibilityRole() -> NSAccessibility.Role? { .group }
    override func accessibilityLabel() -> String? { "Tracking only" }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas { removeTrackingArea(area) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.activeAlways, .mouseEnteredAndExited, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { entries += 1; changed?() }
    override func mouseExited(with event: NSEvent) { exits += 1; changed?() }
    override func draw(_ dirtyRect: NSRect) {
        NSColor.systemBlue.withAlphaComponent(0.2).setFill()
        bounds.fill()
    }
}

final class AlternatePad: TrackingPad {
    var shown = false
    var reveals = 0
    var restores = 0
    lazy var child: NSButton = {
        let button = NSButton(title: "Alternate child", target: self, action: #selector(useChild))
        button.frame = NSRect(x: 20, y: 20, width: 160, height: 30)
        button.isHidden = true
        addSubview(button)
        return button
    }()
    var clicks = 0
    override func accessibilityLabel() -> String? { "Alternate hover" }
    override func accessibilityPerformShowAlternateUI() -> Bool {
        shown = true; reveals += 1; child.isHidden = false; changed?(); return true
    }
    override func accessibilityPerformShowDefaultUI() -> Bool {
        shown = false; restores += 1; child.isHidden = true; changed?(); return true
    }
    @objc func useChild() { clicks += 1; changed?() }
}

final class Fixture: NSObject, NSApplicationDelegate {
    let statePath: String
    var window: NSWindow!
    let alternate = AlternatePad(frame: NSRect(x: 30, y: 150, width: 220, height: 90))
    let tracking = TrackingPad(frame: NSRect(x: 30, y: 30, width: 220, height: 90))
    var timer: Timer?
    var initialCursor = NSEvent.mouseLocation
    var initialFront = NSWorkspace.shared.frontmostApplication?.processIdentifier
    var cursorChanged = false
    var frontChanged = false
    init(path: String) { statePath = path }
    func applicationDidFinishLaunching(_ notification: Notification) {
        guard NSEvent.mouseLocation == initialCursor,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == initialFront else {
            fputs("Desktop changed during fixture launch\n", stderr)
            exit(1)
        }
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 320, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Perse isolated hover fixture"
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
        alternate.changed = { [weak self] in self?.persist() }
        tracking.changed = { [weak self] in self?.persist() }
        window.contentView?.addSubview(alternate)
        window.contentView?.addSubview(tracking)
        _ = alternate.child
        guard let initialFront, initialFront != getpid() else {
            fputs("Fixture requires an existing foreground application\n", stderr)
            exit(1)
        }
        window.level = .normal
        window.orderBack(nil)
        guard NSWorkspace.shared.frontmostApplication?.processIdentifier == initialFront,
              NSEvent.mouseLocation == initialCursor,
              let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else {
            window.orderOut(nil)
            fputs("Cannot verify that the fixture remained in the background\n", stderr)
            exit(1)
        }
        let entries = windows.compactMap { item -> WindowOrderEntry? in
            guard let id = item[kCGWindowNumber as String] as? Int,
                  let pid = item[kCGWindowOwnerPID as String] as? Int,
                  let layer = item[kCGWindowLayer as String] as? Int else { return nil }
            return WindowOrderEntry(id: id, pid: pid, layer: layer)
        }
        guard entries.count == windows.count,
              fixtureIsBehindOtherNormalWindows(entries, fixtureID: window.windowNumber, fixturePID: Int(getpid())) else {
            window.orderOut(nil)
            fputs("Cannot verify fixture window is behind other applications\n", stderr)
            exit(1)
        }
        persist()
        timer = Timer.scheduledTimer(withTimeInterval: 0.02, repeats: true) { [weak self] _ in
            guard let self else { return }
            let changedCursor = NSEvent.mouseLocation != self.initialCursor
            let changedFront = NSWorkspace.shared.frontmostApplication?.processIdentifier != self.initialFront
            if (changedCursor && !self.cursorChanged) || (changedFront && !self.frontChanged) {
                self.cursorChanged = self.cursorChanged || changedCursor
                self.frontChanged = self.frontChanged || changedFront
                self.persist()
            }
        }
    }
    func persist() {
        let state: [String: Any] = ["alternateShown": alternate.shown, "reveals": alternate.reveals,
            "restores": alternate.restores, "clicks": alternate.clicks, "trackingEntries": tracking.entries,
            "trackingExits": tracking.exits, "cursorChanged": cursorChanged, "frontChanged": frontChanged]
        guard let data = try? JSONSerialization.data(withJSONObject: state) else { return }
        try? data.write(to: URL(fileURLWithPath: statePath), options: .atomic)
    }
}

@main enum FixtureMain {
    @MainActor static func main() {
        guard CommandLine.arguments.count == 2 else { fatalError("Expected state path") }
        let app = NSApplication.shared
        let fixture = Fixture(path: CommandLine.arguments[1])
        app.delegate = fixture
        guard app.setActivationPolicy(.regular),
              NSEvent.mouseLocation == fixture.initialCursor,
              NSWorkspace.shared.frontmostApplication?.processIdentifier == fixture.initialFront else {
            fputs("Cannot establish a nonactivating regular fixture application\n", stderr)
            exit(1)
        }
        app.run()
    }
}
