import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

private final class DispatchTrace: WindowPointerPosting, @unchecked Sendable {
    private let lock = NSLock()
    private var entries: [String] = []
    func post(_ event: CGEvent, to pid: Int32) { lock.withLock { entries.append("post:\(event.type.rawValue):\(event.location.x)") } }
    func stampWindow(_ event: CGEvent, pid: Int32, windowID: UInt32, point: WindowPoint) throws {}
    func stamp(_ event: CGEvent, field: UInt32, value: Int64) throws {}
    func position(_ point: CGPoint) { lock.withLock { entries.append("cursor:\(point.x)") } }
    func read() -> [String] { lock.withLock { entries } }
}

@Test func cursorFollowsOnlyPostedDragPositions() throws {
    let trace = DispatchTrace()
    let input = WindowPointerInput(poster: trace, didPostPosition: { _, point in trace.position(point) })
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 100, y: 50, width: 200, height: 200))
    try input.drag(in: route, from: WindowPoint(x: 10, y: 10), to: WindowPoint(x: 30, y: 10), durationMs: 1, steps: 2)
    let entries = trace.read()
    #expect(entries == ["post:1:110.0", "cursor:110.0", "post:6:120.0", "cursor:120.0",
                        "post:6:130.0", "cursor:130.0", "post:2:130.0"])
}

private final class CancelAfterFirstStep: @unchecked Sendable {
    private let lock = NSLock()
    private var calls = 0
    func check() throws {
        try lock.withLock {
            calls += 1
            if calls == 4 { throw NativeFailure(code: "NATIVE_CANCELLED", message: "cancelled") }
        }
    }
}

@Test func cancelledDragDisplaysOnlyItsLastSentPosition() throws {
    let trace = DispatchTrace()
    let cancellation = CancelAfterFirstStep()
    let input = WindowPointerInput(poster: trace, checkCancellation: { try cancellation.check() },
                                   didPostPosition: { _, point in trace.position(point) })
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 100, y: 50, width: 200, height: 200))
    #expect(throws: NativeFailure.self) {
        try input.drag(in: route, from: WindowPoint(x: 10, y: 10), to: WindowPoint(x: 30, y: 10), durationMs: 1, steps: 2)
    }
    #expect(trace.read() == ["post:1:110.0", "cursor:110.0", "post:6:120.0", "cursor:120.0", "post:2:120.0"])
}


@Test func clickFeedbackFollowsPostedMouseDown() throws {
    let trace = DispatchTrace()
    let input = WindowPointerInput(poster: trace, didPostPosition: { _, point in trace.position(point) },
        didPostClick: { _, point in trace.position(point) })
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 100, y: 50, width: 200, height: 200))
    try input.click(in: route, at: WindowPoint(x: 10, y: 10), button: "left", count: 1)
    #expect(trace.read() == ["post:5:110.0", "cursor:110.0", "post:1:110.0", "cursor:110.0", "post:2:110.0"])
}
