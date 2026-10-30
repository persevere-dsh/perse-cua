import AppKit
final class Fixture: NSObject, NSApplicationDelegate {
    var window: NSWindow!
    @objc func resize() {
        window.setFrame(NSRect(x: window.frame.origin.x, y: window.frame.origin.y, width: 500, height: window.frame.height), display: true)
    }
    func applicationDidFinishLaunching(_ notification: Notification) {
        window = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 400, height: 300), styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.title = "Perse resize fixture"
        window.collectionBehavior = [.canJoinAllApplications, .stationary]
        let button = NSButton(title: "Resize fixture", target: self, action: #selector(resize))
        button.frame = NSRect(x: 30, y: 150, width: 200, height: 32)
        window.contentView!.addSubview(button)
        window.makeKeyAndOrderFront(nil)
        print("READY"); fflush(stdout)
    }
}
let app = NSApplication.shared
let delegate = Fixture()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
