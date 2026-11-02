import Foundation

/// Validate both before movement and after arrival, before any pointer event.
func preparePointer(
    route: WindowRoute, point: WindowPoint, targetSize: CGSize? = nil,
    plan: @Sendable (WindowRoute, WindowPoint, CGSize?) async throws -> Void,
    validate: @Sendable (WindowRoute) throws -> Void
) async throws {
    try validate(route)
    try await plan(route, point, targetSize)
    try Task.checkCancellation()
    try validate(route)
}

struct AXClickVisualTarget: Equatable {
    let route: WindowRoute
    let point: WindowPoint
    let elementBounds: WindowBounds
}

/// Dispatch only if the planned AX target remains at the position reached by the cursor.
func performAXClick(
    isolation: isolated (any Actor)? = #isolation,
    resolve: () throws -> AXClickVisualTarget,
    plan: (WindowRoute, WindowPoint, CGSize?) async throws -> Void,
    checkCancellation: () throws -> Void,
    sameTarget: () throws -> Bool,
    perform: () throws -> Void,
    mark: (WindowRoute, CGPoint) -> Void
) async throws {
    try checkCancellation()
    let target = try resolve()
    try await plan(target.route, target.point, CGSize(width: target.elementBounds.width, height: target.elementBounds.height))
    try checkCancellation()
    guard try resolve() == target else {
        throw NativeFailure(code: "WINDOW_CHANGED", message: "Accessibility target moved before input; read fresh state")
    }
    guard try sameTarget() else {
        throw NativeFailure(code: "STALE_SNAPSHOT", message: "Accessibility target changed before input; read fresh state")
    }
    try checkCancellation()
    try perform()
    mark(target.route, CGPoint(x: target.route.bounds.x + target.point.x,
                               y: target.route.bounds.y + target.point.y))
}
