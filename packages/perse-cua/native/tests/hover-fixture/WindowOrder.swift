import Foundation
import CoreGraphics

struct WindowOrderEntry {
    let id: Int
    let pid: Int
    let layer: Int
}

/// WindowServer lists on-screen windows from front to back.
func fixtureIsBehindOtherNormalWindows(_ entries: [WindowOrderEntry], fixtureID: Int, fixturePID: Int) -> Bool {
    guard let fixtureIndex = entries.firstIndex(where: { $0.id == fixtureID && $0.pid == fixturePID && $0.layer == 0 }) else { return false }
    return !entries.dropFirst(fixtureIndex + 1).contains { $0.layer == 0 && $0.pid != fixturePID }
}

enum FixtureReadiness: Equatable { case waiting, ready, timedOut }

/// Require a continuously unchanged WindowServer frame within a bounded startup period.
struct FixtureWindowStability {
    let started: TimeInterval
    let timeout: TimeInterval
    let stableDuration: TimeInterval
    private var frame: CGRect?
    private var stableSince: TimeInterval?

    init(started: TimeInterval, timeout: TimeInterval = 3, stableDuration: TimeInterval = 0.3) {
        self.started = started
        self.timeout = timeout
        self.stableDuration = stableDuration
    }

    mutating func observe(_ next: CGRect?, now: TimeInterval) -> FixtureReadiness {
        guard now - started < timeout else { return .timedOut }
        guard let next, next.origin.x.isFinite, next.origin.y.isFinite,
              next.width.isFinite, next.height.isFinite, next.width > 0, next.height > 0 else {
            frame = nil; stableSince = nil
            return .waiting
        }
        if next != frame { frame = next; stableSince = now }
        guard let stableSince, now - stableSince >= stableDuration else { return .waiting }
        return .ready
    }
}
