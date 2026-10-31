import Foundation
import Testing
@testable import CuaNative

private func target(_ x: Double) -> AXClickVisualTarget {
    AXClickVisualTarget(route: WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: x, y: 50, width: 200, height: 200)), point: WindowPoint(x: 10, y: 20))
}

@Test @MainActor func axClickMarksTheFreshLocationAfterPlanningAndAction() async throws {
    var current = target(100.0)
    var events: [String] = []
    try await performAXClick(resolve: { events.append("resolve"); return current },
        plan: { _, _ in events.append("plan"); current = target(150) },
        checkCancellation: {}, perform: { events.append("action") },
        mark: { _, point in events.append("mark:\(point.x)") })
    #expect(events == ["resolve", "plan", "resolve", "action", "mark:160.0"])
}

@Test @MainActor func axClickWorksWithoutGeometryOrWhenGeometryDisappears() async throws {
    for initialAvailable in [false, true] {
        var reads = 0
        var events: [String] = []
        try await performAXClick(resolve: {
            reads += 1
            return initialAvailable && reads == 1 ? target(100) : nil
        }, plan: { _, _ in events.append("plan") }, checkCancellation: {},
           perform: { events.append("action") }, mark: { _, _ in events.append("mark") })
        #expect(events == (initialAvailable ? ["plan", "action"] : ["action"]))
    }
}

@Test @MainActor func axClickContinuesAfterVisualFailureButNotAfterCancellation() async throws {
    var events: [String] = []
    try await performAXClick(resolve: { target(100) },
        plan: { _, _ in throw NativeFailure(code: "NATIVE_ERROR", message: "visual unavailable") },
        checkCancellation: {}, perform: { events.append("action") }, mark: { _, _ in events.append("mark") })
    #expect(events == ["action", "mark"])
    events.removeAll()
    do {
        try await performAXClick(resolve: { target(100) }, plan: { _, _ in throw CancellationError() },
            checkCancellation: { throw CancellationError() }, perform: { events.append("action") },
            mark: { _, _ in events.append("mark") })
        Issue.record("Cancelled AX click must not dispatch")
    } catch { #expect(error is CancellationError) }
    #expect(events.isEmpty)
}

@Test @MainActor func axClickFailureDoesNotShowAClickMarker() async throws {
    var marked = false
    do {
        try await performAXClick(resolve: { target(100) }, plan: { _, _ in }, checkCancellation: {},
            perform: { throw NativeFailure(code: "NATIVE_ERROR", message: "AX failure") },
            mark: { _, _ in marked = true })
        Issue.record("AX failure must be returned")
    } catch { #expect((error as? NativeFailure)?.code == "NATIVE_ERROR") }
    #expect(!marked)
}

@Test @MainActor func axClickMarksPreActionPositionWithoutReadingAfterDispatch() async throws {
    for disappears in [false, true] {
        var current: AXClickVisualTarget? = target(100)
        var events: [String] = []
        try await performAXClick(resolve: { events.append("resolve"); return current },
            plan: { _, _ in }, checkCancellation: {},
            perform: { events.append("action"); current = disappears ? nil : target(200) },
            mark: { _, point in events.append("mark:\(point.x)") })
        #expect(events == ["resolve", "resolve", "action", "mark:110.0"])
    }
}
