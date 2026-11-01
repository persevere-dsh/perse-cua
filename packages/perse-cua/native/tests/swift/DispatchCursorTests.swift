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
    let first = requests.begin(method: "click", hide: hide)
    #expect(!visible)
    visible = true
    let read = requests.begin(method: "screenshot", hide: hide)
    requests.fail(read, hide: hide)
    #expect(visible)
    let second = requests.begin(method: "drag", hide: hide)
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

@Test @MainActor func pointerOperationsKeepTheSchedulerUntilTheirDisplayCompletes() async throws {
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

@Test @MainActor func cancelledCursorFadeCannotHideANewerCursor() async {
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var hidden = false
    let task = scheduleCursorFade(delay: {
        signalStarted.yield()
        for await _ in release { return }
    }, onReady: { hidden = true })
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    task.cancel()
    signalRelease.yield()
    signalRelease.finish()
    await task.value
    signalStarted.finish()
    #expect(!hidden)
}

@Test @MainActor func cursorFadeWaitsUntilTheDelayCompletes() async {
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var fadeCount = 0
    let task = scheduleCursorFade(delay: {
        signalStarted.yield()
        for await _ in release { return }
    }, onReady: { fadeCount += 1 })
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    #expect(fadeCount == 0)
    signalRelease.yield()
    signalRelease.finish()
    await task.value
    signalStarted.finish()
    #expect(fadeCount == 1)
}

@Test @MainActor func newCursorCannotBeFadedByAnOlderInProgressFade() async {
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    let visibility = CursorVisibility(), revision = visibility.advance()
    var opacity = 1.0
    var writes = 0
    let task = Task { @MainActor in
        await animateCursorFade(steps: 2, pause: {
            signalStarted.yield()
            for await _ in release { return }
        }, isCurrent: { visibility.isCurrent(revision) }, setAlpha: { opacity = $0; writes += 1 })
    }
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    signalRelease.yield()
    _ = await iterator.next()
    #expect(opacity == 0.5)
    visibility.advance()
    opacity = 1
    signalRelease.yield()
    await task.value
    signalStarted.finish(); signalRelease.finish()
    #expect(opacity == 1)
    #expect(writes == 1)
}

@Test @MainActor func cancelledInProgressFadeCannotChangeOpacityAgain() async {
    let (started, signalStarted) = AsyncStream<Void>.makeStream()
    let (release, signalRelease) = AsyncStream<Void>.makeStream()
    var opacity = 1.0
    let task = Task { @MainActor in
        await animateCursorFade(steps: 2, pause: {
            signalStarted.yield()
            for await _ in release { return }
        }, isCurrent: { true }, setAlpha: { opacity = $0 })
    }
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    signalRelease.yield()
    _ = await iterator.next()
    #expect(opacity == 0.5)
    task.cancel()
    opacity = 1
    signalRelease.yield()
    await task.value
    signalStarted.finish(); signalRelease.finish()
    #expect(opacity == 1)
}
