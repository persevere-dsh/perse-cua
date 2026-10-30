import Foundation
import Testing
@testable import CuaNative

private final class PreparationTrace: @unchecked Sendable {
    private let lock = NSLock()
    private var events: [String] = []
    func append(_ event: String) { lock.withLock { events.append(event) } }
    func read() -> [String] { lock.withLock { events } }
}

private let preparationRoute = WindowRoute(owner: ProcessIdentity(pid: 42, startedSeconds: 1, startedMicroseconds: 0),
    windowID: 7, bounds: WindowBounds(x: 100, y: 50, width: 200, height: 200))
private let preparationPoint = WindowPoint(x: 10, y: 10)

@Test func preparationRevalidatesBeforeDispatchEvenWhenVisualsAreUnavailable() async throws {
    let trace = PreparationTrace()
    try await preparePointer(route: preparationRoute, point: preparationPoint, plan: { _, _ in
        trace.append("no-visual")
    }, validate: { _ in trace.append("validate") })
    trace.append("dispatch")
    #expect(trace.read() == ["no-visual", "validate", "dispatch"])
}

@Test(arguments: ["WINDOW_CHANGED", "APP_ACCESS_REVOKED"])
func preparationStopsBeforeDispatchWhenTheTargetOrPermissionChanges(code: String) async {
    let trace = PreparationTrace()
    do {
        try await preparePointer(route: preparationRoute, point: preparationPoint, plan: { _, _ in
            trace.append("planned")
        }, validate: { _ in
            trace.append("validate")
            throw NativeFailure(code: code, message: "changed")
        })
        trace.append("dispatch")
        Issue.record("Changed target or revoked access must stop dispatch")
    } catch {
        #expect((error as? NativeFailure)?.code == code)
    }
    #expect(trace.read() == ["planned", "validate"])
}

@Test func cancellationDuringPlanningDoesNotDispatch() async throws {
    let trace = PreparationTrace()
    let (started, notifyStarted) = AsyncStream<Void>.makeStream()
    let (release, notifyRelease) = AsyncStream<Void>.makeStream()
    let operation = Task {
        try await preparePointer(route: preparationRoute, point: preparationPoint, plan: { _, _ in
            notifyStarted.yield()
            for await _ in release { try Task.checkCancellation(); return }
            try Task.checkCancellation()
        }, validate: { _ in trace.append("validate") })
        trace.append("dispatch")
    }
    var iterator = started.makeAsyncIterator()
    _ = await iterator.next()
    operation.cancel()
    notifyRelease.yield()
    notifyRelease.finish()
    do { try await operation.value; Issue.record("Cancelled plan must not dispatch") } catch {}
    notifyStarted.finish()
    #expect(trace.read().isEmpty)
}

@Test func cancelledAnimationIgnoresLateCompletion() async {
    let completion = CursorAnimationCompletion()
    completion.finish(CancellationError())
    do {
        try await withCheckedThrowingContinuation { continuation in completion.install(continuation) }
        Issue.record("Cancelled animation must not report completion")
    } catch { #expect(error is CancellationError) }
    completion.finish(nil)
}

@Test func completedAnimationResumesItsWaiter() async throws {
    let completion = CursorAnimationCompletion()
    try await withCheckedThrowingContinuation { continuation in
        completion.install(continuation)
        completion.finish(nil)
        completion.finish(CancellationError())
    }
}
