import Foundation
import CoreGraphics

@main enum WindowOrderTests {
    static func main() {
        let front = WindowOrderEntry(id: 1, pid: 10, layer: 0)
        let fixture = WindowOrderEntry(id: 2, pid: 20, layer: 0)
        let floating = WindowOrderEntry(id: 3, pid: 30, layer: 3)
        precondition(fixtureIsBehindOtherNormalWindows([floating, front, fixture], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([fixture, front], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([front], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([front, fixture], fixtureID: 2, fixturePID: 99))
        let first = CGRect(x: 1, y: 2, width: 300, height: 200)
        let moved = CGRect(x: 2, y: 2, width: 300, height: 200)
        var stability = FixtureWindowStability(started: 0, timeout: 3, stableDuration: 0.3)
        precondition(stability.observe(first, now: 0) == .waiting)
        precondition(stability.observe(first, now: 0.2) == .waiting)
        precondition(stability.observe(moved, now: 0.25) == .waiting)
        precondition(stability.observe(moved, now: 0.54) == .waiting)
        precondition(stability.observe(moved, now: 0.56) == .ready)
        var missing = FixtureWindowStability(started: 0, timeout: 1, stableDuration: 0.3)
        precondition(missing.observe(first, now: 0) == .waiting)
        precondition(missing.observe(nil, now: 0.2) == .waiting)
        precondition(missing.observe(first, now: 0.4) == .waiting)
        precondition(missing.observe(nil, now: 1) == .timedOut)
        print("PASS: fixture window ordering and frame readiness are checked conservatively")
    }
}
