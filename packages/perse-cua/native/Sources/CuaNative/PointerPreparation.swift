import Foundation

/// Wait for the visual plan, then revalidate before any pointer event is sent.
func preparePointer(
    route: WindowRoute, point: WindowPoint,
    plan: @Sendable (WindowRoute, WindowPoint) async throws -> Void,
    validate: @Sendable (WindowRoute) throws -> Void
) async throws {
    try await plan(route, point)
    try validate(route)
}

struct AXClickVisualTarget {
    let route: WindowRoute
    let point: WindowPoint
}

/// Plan visual feedback, dispatch one AX action, then mark the latest usable position.
func performAXClick(
    isolation: isolated (any Actor)? = #isolation,
    resolve: () -> AXClickVisualTarget?,
    plan: (WindowRoute, WindowPoint) async throws -> Void,
    checkCancellation: () throws -> Void,
    perform: () throws -> Void,
    mark: (WindowRoute, CGPoint) -> Void
) async throws {
    var target = resolve()
    if let initial = target {
        do { try await plan(initial.route, initial.point) }
        catch { try checkCancellation() }
        try checkCancellation()
        target = resolve()
    }
    try checkCancellation()
    try perform()
    if let target {
        mark(target.route, CGPoint(x: target.route.bounds.x + target.point.x,
                                   y: target.route.bounds.y + target.point.y))
    }
}
