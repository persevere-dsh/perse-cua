import Foundation

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
