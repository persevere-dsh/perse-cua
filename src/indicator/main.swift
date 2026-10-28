// perse-cua-indicator: menu-bar session indicator for background agent driving.
//
// Mirrors the Codex computer-use experience: while an agent drives apps through
// cua-driver in the background, a status item shows that an assistive session is
// live. Must be launched via `open` (LaunchServices-registered apps are the only
// ones whose NSStatusItem renders). State arrives through a JSON state file the
// plugin writes; unparseable files are ignored, a missing file makes the
// indicator exit (self-cleanup), and a stale "active" flag decays to idle.
//
// State file JSON: {"session":"<label>","active":true|false,"ts":<epoch seconds>}

import AppKit

let statePath = CommandLine.arguments.count > 1
    ? CommandLine.arguments[1]
    : (NSHomeDirectory() as NSString).appendingPathComponent("Library/Application Support/perse-cua/indicator.json")

let ACTIVE_TTL: TimeInterval = 8         // active decays to idle if ts is older than this
let IDLE_TO_QUIT: TimeInterval = 60      // exit if the file stops updating entirely

final class Indicator: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem?
    private var sessionLabel = "perse-cua"
    private var active = false
    private let launchTime = Date()
    private var timer: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        item.button?.toolTip = "perse-cua: background agent session"
        statusItem = item
        render()
        timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in self?.poll() }
        RunLoop.main.add(timer!, forMode: .common)
    }

    private func poll() {
        guard let data = FileManager.default.contents(atPath: statePath) else {
            // Self-cleanup once the plugin is gone, with a grace period for the
            // gap between `open` launching us and the plugin writing the file.
            if Date().timeIntervalSince(launchTime) > 10 { NSApp.terminate(nil) }
            return
        }
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        if let label = obj["session"] as? String { sessionLabel = label }
        let claimed = (obj["active"] as? Bool) ?? false
        let ts = (obj["ts"] as? Double) ?? 0
        let fresh = Date().timeIntervalSince1970 - ts < ACTIVE_TTL
        let next = claimed && fresh
        if next != active {
            active = next
            render()
        }
        if Date().timeIntervalSince1970 - ts > IDLE_TO_QUIT { NSApp.terminate(nil) }
    }

    private func render() {
        guard let button = statusItem?.button else { return }
        buildMenu(button)
        button.image = nil
        button.title = ""
        let symbol = active ? "person.fill.viewfinder" : "person.crop.rectangle"
        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: active ? "Agent driving apps" : "Agent session idle") {
            if active {
                // contentTintColor silently hides status items on macOS 26;
                // a palette-tinted non-template image colors it safely.
                let config = NSImage.SymbolConfiguration(paletteColors: [.controlAccentColor, .white])
                if let tinted = image.withSymbolConfiguration(config), tinted.size.width > 0 {
                    tinted.isTemplate = false
                    button.image = tinted
                    return
                }
            }
            image.isTemplate = true
            button.image = image
        } else {
            button.title = active ? "● agent" : "○ agent"
        }
    }

    private func buildMenu(_ button: NSStatusBarButton) {

        let menu = NSMenu()
        let header = NSMenuItem(title: "session: \(sessionLabel)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(NSMenuItem(title: active ? "driving now" : "idle", action: nil, keyEquivalent: ""))
        menu.addItem(.separator())
        menu.addItem(NSMenuItem(title: "Hide indicator", action: #selector(NSApp.terminate(_:)), keyEquivalent: ""))
        button.menu = menu
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let delegate = Indicator()
app.delegate = delegate
app.run()
