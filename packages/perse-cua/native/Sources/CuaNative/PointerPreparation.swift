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
