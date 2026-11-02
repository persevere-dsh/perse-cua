import CoreGraphics
import Foundation
import Testing
@testable import CuaNative

@Test func cursorAnimationResumesWhenCompletionPrecedesInstallation() async throws {
    let completion = CursorAnimationCompletion()
    completion.finish(nil)
    completion.finish(CancellationError())
    try await withCheckedThrowingContinuation { completion.install($0) }
}

@Test func cursorAnimationPreservesCancellationBeforeInstallation() async {
    let completion = CursorAnimationCompletion()
    completion.finish(CancellationError())
    completion.finish(nil)
    do {
        try await withCheckedThrowingContinuation { completion.install($0) }
        Issue.record("Cancelled animation resumed successfully")
    } catch {
        #expect(error is CancellationError)
    }
}

@Test func cursorAnimationResumesOnlyOnceAfterInstallation() async throws {
    let completion = CursorAnimationCompletion()
    try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        completion.finish(nil)
        completion.finish(CancellationError())
        completion.finish(nil)
    }
}

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

@Test func newerCursorVisibilityInvalidatesDelayedFadeAndHide() {
    let visibility = CursorVisibility()
    let first = visibility.advance()
    #expect(visibility.isCurrent(first))
    let second = visibility.advance()
    #expect(!visibility.isCurrent(first))
    #expect(visibility.isCurrent(second))
    visibility.advance()
    #expect(!visibility.isCurrent(second))
}

@Test @MainActor func onlyTheCurrentPointerFailureCanHideItsCursor() {
    let requests = CursorRequestOwnership()
    var visible = true
    let hide = { visible = false }
    var interruptions = 0
    let interrupt = { interruptions += 1 }
    let first = requests.begin(method: "click", interrupt: interrupt)
    #expect(interruptions == 1)
    #expect(visible)
    let read = requests.begin(method: "screenshot", interrupt: interrupt)
    requests.fail(read, hide: hide)
    #expect(visible)
    let second = requests.begin(method: "drag", interrupt: interrupt)
    #expect(interruptions == 2)
    visible = true
    requests.fail(first, hide: hide)
    #expect(visible)
    requests.fail(second, hide: hide)
    #expect(!visible)
    visible = true
    requests.close(hide)
    #expect(!visible)
    visible = true
    requests.fail(second, hide: hide)
    #expect(visible)
}

@Test @MainActor func schedulerSerializesPointerOperations() async throws {
    let scheduler = RequestScheduler(), cancellation = CancellationLatch()
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var positions: [Int] = []
    let first = Task {
        try await scheduler.perform(cancellation: cancellation) {
            signalStarted.yield()
            for await _ in release { break }
            positions.append(1)
            return .null
        }
    }
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    let second = Task {
        try await scheduler.perform(cancellation: cancellation) {
            positions.append(2)
            return .null
        }
    }
    await Task.yield()
    #expect(positions.isEmpty)
    signalRelease.yield()
    _ = try await first.value
    _ = try await second.value
    #expect(positions == [1, 2])
    signalStarted.finish(); signalRelease.finish()
}

@Test func cursorTrajectoryMatchesCuaSteadyReference() {
    // Cua 85e2b13, fixtures/golden.json: signature_arc/steady/default/0.
    let plan = planCursorMotion(from: CGPoint(x: 100, y: 100), angle: 0,
        to: CGPoint(x: 600, y: 420), targetSize: CGSize(width: 80, height: 40))
    let references: [(Double, CGFloat, CGFloat)] = [
        (0.206478321, 218.923671451, 135.200798158),
        (0.412956642, 455.879091382, 269.325042449),
        (0.578139298, 581.670907706, 394.900806997),
    ]
    for (time, x, y) in references {
        let actual = plan.sample(at: time).point
        #expect(abs(actual.x - x) < 0.1)
        #expect(abs(actual.y - y) < 0.1)
    }
    #expect(abs(plan.sample(at: 0.412956642).angle - (3.744855837 - .pi / 4)) < 0.01)
    #expect(plan.sample(at: plan.arrivalT).point == CGPoint(x: 600, y: 420))
    #expect(plan.samples.last?.point == CGPoint(x: 600, y: 420))
    #expect(plan.samples.last?.angle == 0)
}

@Test func cursorTrajectoryIsDeterministicAndRespectsReducedMotionAndTargetSize() {
    let from = CGPoint(x: 10, y: 10), to = CGPoint(x: 900, y: 300)
    let first = planCursorMotion(from: from, angle: 0.4, to: to)
    let again = planCursorMotion(from: from, angle: 0.4, to: to)
    #expect(first.samples.map(\.point) == again.samples.map(\.point))
    #expect(first.samples.map(\.angle) == again.samples.map(\.angle))
    #expect(first.samples[0].angle == 0.4)
    let large = planCursorMotion(from: from, angle: 0, to: to, targetSize: CGSize(width: 200, height: 200))
    #expect(large.arrivalT < first.arrivalT)
    let reduced = planCursorMotion(from: from, angle: 0, to: to, reducedMotion: true)
    #expect(abs(reduced.arrivalT - 0.12) < 1e-9)
    #expect(reduced.samples.allSatisfy { $0.angle == 0 })
    #expect(reduced.sample(at: 0.06).point == CGPoint(x: 455, y: 155))
}

@Test @MainActor func cursorSessionColorsAreStable() {
    let cursor = DispatchCursor()
    #expect(cursor.colorHex == CursorTheme.colorHex)
    cursor.setSessionName("named session")
    let color = cursor.colorHex
    cursor.setSessionName("named session")
    #expect(cursor.colorHex == color)
    cursor.setSessionName(nil)
    #expect(cursor.colorHex == CursorTheme.colorHex)
}

@Test @MainActor func cursorMonitorHidesWhenRouteBecomesInvalid() async {
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 1, y: 2, width: 30, height: 40))
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var invalid: WindowRoute?
    let task = scheduleCursorRouteMonitor(route: route, pause: {}, validate: { _ in
        signalStarted.yield()
        for await _ in release { return false }
        return false
    }, onInvalid: { invalid = $0 })
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    #expect(invalid == nil)
    signalRelease.yield()
    await task.value
    #expect(invalid == route)
    signalStarted.finish(); signalRelease.finish()
}

@Test @MainActor func cancelledCursorMonitorCannotHideANewerRoute() async {
    let route = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
        windowID: 7, bounds: WindowBounds(x: 1, y: 2, width: 30, height: 40))
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var invalidated = false
    let task = scheduleCursorRouteMonitor(route: route, pause: {}, validate: { _ in
        signalStarted.yield()
        for await _ in release { return false }
        return false
    }, onInvalid: { _ in invalidated = true })
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    task.cancel()
    signalRelease.yield()
    await task.value
    #expect(!invalidated)
    signalStarted.finish(); signalRelease.finish()
}

@Test func cursorShortAndLongMovesHaveCurvedIntermediatePositionsAndExactArrival() {
    for distance: CGFloat in [40, 4000] {
        let target = CGPoint(x: distance, y: 0)
        let plan = planCursorMotion(from: .zero, angle: 0, to: target)
        let middle = plan.sample(at: plan.arrivalT / 2)
        #expect(middle.point.x > 0 && middle.point.x < distance)
        #expect(middle.point.y < 0)
        #expect(abs(middle.angle) > 0.01)
        let arrivalIndex = plan.samples.firstIndex(where: { $0.t == plan.arrivalT })
        #expect(arrivalIndex != nil)
        if let arrivalIndex {
            #expect(plan.samples[arrivalIndex].point == target)
            #expect(plan.samples[..<arrivalIndex].allSatisfy { $0.point != target })
        }
        #expect(plan.arrivalT >= 0.4 && plan.arrivalT <= 1.1)
    }
    let short = planCursorMotion(from: .zero, angle: 0, to: CGPoint(x: 40, y: 0))
    let long = planCursorMotion(from: .zero, angle: 0, to: CGPoint(x: 4000, y: 0))
    #expect(short.arrivalT < long.arrivalT)
}

@Test func cursorReplansAReverseMoveFromTheDisplayedPositionAndAngle() {
    let forward = planCursorMotion(from: .zero, angle: 0, to: CGPoint(x: 600, y: 0))
    let interrupted = forward.sample(at: forward.arrivalT * 0.45)
    #expect(interrupted.point.x > 0 && interrupted.point.x < 600)
    #expect(interrupted.point.y < 0)
    #expect(abs(interrupted.angle) > 0.01)
    let destination = CGPoint(x: -200, y: 0)
    let reverse = planCursorMotion(from: interrupted.point, angle: interrupted.angle, to: destination)
    #expect(reverse.samples.first?.point == interrupted.point)
    #expect(reverse.samples.first?.angle == interrupted.angle)
    let middle = reverse.sample(at: reverse.arrivalT / 2)
    #expect(middle.point.x < interrupted.point.x && middle.point.x > destination.x)
    #expect(middle.point.y < interrupted.point.y)
    #expect(abs(middle.angle - interrupted.angle) > 0.05)
    let arrivalIndex = reverse.samples.firstIndex(where: { $0.t == reverse.arrivalT })
    #expect(arrivalIndex != nil)
    if let arrivalIndex {
        #expect(reverse.samples[arrivalIndex].point == destination)
        #expect(reverse.samples[..<arrivalIndex].allSatisfy { $0.point != destination })
    }
}
