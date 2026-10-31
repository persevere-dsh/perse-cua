// Window coordinate conversion uses the primary display origin.
import Testing
import CoreGraphics
@testable import CuaNative

@Test func hoverHitTestingUsesThePrimaryDisplayOriginForEveryDisplay() {
    #expect(WindowGeometry.appKitPoint(CGPoint(x: 120, y: 230), mainDisplayHeight: 900) == CGPoint(x: 120, y: 670))
    #expect(WindowGeometry.appKitPoint(CGPoint(x: -800, y: -200), mainDisplayHeight: 900) == CGPoint(x: -800, y: 1100))
    #expect(WindowGeometry.appKitPoint(CGPoint(x: 2100, y: 1200), mainDisplayHeight: 900) == CGPoint(x: 2100, y: -300))
}

@Test func unavailableAccessibilityHoverFailsWithoutPointerFallback() throws {
    do {
        _ = try AXWorker.hoverResult(outcome: .unsupported)
        Issue.record("Missing alternate UI must fail")
    } catch let failure as NativeFailure {
        #expect(failure.code == "UNSUPPORTED")
        #expect(failure.message.contains("后台悬停"))
    }
    #expect(try AXWorker.hoverResult(outcome: .revealed) == .object([
        "dispatched": .bool(true), "verified": .bool(false),
        "hoverRoute": .string("accessibility"), "systemPointerMoved": .bool(false),
    ]))
}

@Test func retainedAlternateHoverDoesNotClaimAnotherDispatch() throws {
    #expect(try AXWorker.hoverResult(outcome: .retained) == .object([
        "dispatched": .bool(false), "verified": .bool(false),
        "hoverRoute": .string("accessibility"), "systemPointerMoved": .bool(false),
    ]))
}

@Test func successfulAccessibilityHoverCarriesTheRequestedGlobalPosition() throws {
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: -400, y: 250, width: 200, height: 100))
    for outcome in [AXHoverOutcome.revealed, .retained] {
        let element = WindowBounds(x: -380, y: 280, width: 20, height: 20)
        let points = [WindowPoint(x: 30, y: 40), WindowPointerInput.elementPoint(element, in: route)]
        for point in points {
            guard case .hover(let result, let markedRoute, let globalPoint) = try AXWorker.hoverOutcome(route: route, point: point, move: { outcome }) else {
                Issue.record("Successful hover omitted cursor feedback"); return
            }
            #expect(markedRoute.windowID == 7)
            #expect(globalPoint == CGPoint(x: -370, y: 290))
            #expect(result == (try AXWorker.hoverResult(outcome: outcome)))
        }
    }
}

@Test func failedAccessibilityHoverProducesNoCursorFeedback() throws {
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 100, y: 50, width: 200, height: 100))
    #expect(throws: NativeFailure.self) { try AXWorker.hoverOutcome(route: route, point: WindowPoint(x: 30, y: 40), move: { .unsupported }) }
    #expect(throws: NativeFailure.self) { try AXWorker.hoverOutcome(route: route, point: WindowPoint(x: 30, y: 40), move: { throw NativeFailure(code: "NATIVE_ERROR", message: "fixture") }) }
}
