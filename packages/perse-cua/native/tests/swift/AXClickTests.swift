import Foundation
import Testing
@testable import CuaNative

private func target(_ x: Double) -> AXClickVisualTarget {
    AXClickVisualTarget(route: WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: x, y: 50, width: 200, height: 200)), point: WindowPoint(x: 10, y: 20), elementBounds: WindowBounds(x: x + 5, y: 60, width: 10, height: 20))
}

@Test @MainActor func axClickWaitsForArrivalAndRechecksBeforeDispatch() async throws {
    var events: [String] = []
    try await performAXClick(resolve: { events.append("resolve"); return target(100) },
        plan: { _, _, size in
            #expect(size == CGSize(width: 10, height: 20))
            events.append("arrival")
        }, checkCancellation: {}, sameTarget: { true },
        perform: { events.append("action") }, mark: { _, point in events.append("mark:\(point.x)") })
    #expect(events == ["resolve", "arrival", "resolve", "action", "mark:110.0"])
}

@Test @MainActor func axClickRejectsMovedOrMissingTargetBeforeDispatch() async throws {
    for missing in [false, true] {
        var reads = 0
        var events: [String] = []
        do {
            try await performAXClick(resolve: {
                reads += 1
                if reads == 2 && missing { throw NativeFailure(code: "CURSOR_UNAVAILABLE", message: "no geometry") }
                return target(reads == 1 ? 100 : 150)
            }, plan: { _, _, _ in events.append("arrival") }, checkCancellation: {}, sameTarget: { true },
                perform: { events.append("action") }, mark: { _, _ in events.append("mark") })
            Issue.record("Changed target must not dispatch")
        } catch {
            #expect((error as? NativeFailure)?.code == (missing ? "CURSOR_UNAVAILABLE" : "WINDOW_CHANGED"))
        }
        #expect(events == ["arrival"])
    }
}

@Test @MainActor func axClickStopsOnVisualFailureOrCancellation() async throws {
    for cancelled in [false, true] {
        var events: [String] = []
        do {
            try await performAXClick(resolve: { target(100) }, plan: { _, _, _ in
                if cancelled { throw CancellationError() }
                throw NativeFailure(code: "CURSOR_UNAVAILABLE", message: "visual unavailable")
            }, checkCancellation: {}, sameTarget: { true }, perform: { events.append("action") }, mark: { _, _ in events.append("mark") })
            Issue.record("Failed movement must not dispatch")
        } catch {
            if cancelled { #expect(error is CancellationError) }
            else { #expect((error as? NativeFailure)?.code == "CURSOR_UNAVAILABLE") }
        }
        #expect(events.isEmpty)
    }
}

@Test @MainActor func axClickFailureDoesNotShowAClickMarker() async throws {
    var marked = false
    do {
        try await performAXClick(resolve: { target(100) }, plan: { _, _, _ in }, checkCancellation: {}, sameTarget: { true },
            perform: { throw NativeFailure(code: "NATIVE_ERROR", message: "AX failure") },
            mark: { _, _ in marked = true })
        Issue.record("AX failure must be returned")
    } catch { #expect((error as? NativeFailure)?.code == "NATIVE_ERROR") }
    #expect(!marked)
}

@Test @MainActor func axClickRejectsReplacedTargetAtTheSamePosition() async throws {
    var events: [String] = []
    var same = true
    do {
        try await performAXClick(resolve: { target(100) },
            plan: { _, _, _ in same = false }, checkCancellation: {}, sameTarget: { same },
            perform: { events.append("action") }, mark: { _, _ in events.append("mark") })
        Issue.record("Replaced target must not dispatch")
    } catch { #expect((error as? NativeFailure)?.code == "STALE_SNAPSHOT") }
    #expect(events.isEmpty)
}
