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
        _ = try AXWorker.hoverResult(handled: false)
        Issue.record("Missing alternate UI must fail")
    } catch let failure as NativeFailure {
        #expect(failure.code == "UNSUPPORTED")
        #expect(failure.message.contains("后台悬停"))
    }
    #expect(try AXWorker.hoverResult(handled: true) == .object([
        "dispatched": .bool(true), "verified": .bool(false),
        "hoverRoute": .string("accessibility"), "systemPointerMoved": .bool(false),
    ]))
}
