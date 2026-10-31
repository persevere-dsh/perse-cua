// Alternate accessibility UI can remain revealed without moving the system pointer.
import ApplicationServices

struct AXHoverAccess<Node> {
    let equal: (Node, Node) -> Bool
    let actions: (Node) throws -> [String]
    let role: (Node) throws -> String?
    let parent: (Node) throws -> Node?
    let enabled: (Node) throws -> Bool?
    let perform: (Node, String) throws -> Void
}

/// Tracks the alternate UI owned by one connection and restores it when leaving.
final class AXHoverState<Node> {
    private var revealed: (element: Node, windowID: UInt32)?

    func move(to target: Node?, windowID: UInt32, access: AXHoverAccess<Node>) throws -> Bool {
        var current = target
        var visited: [Node] = []
        var alternate: Node?
        while let node = current {
            guard !visited.contains(where: { access.equal($0, node) }) else {
                throw NativeFailure(code: "NATIVE_ERROR", message: "Accessibility hover ancestry contains a cycle; read fresh state")
            }
            visited.append(node)
            if let revealed, revealed.windowID == windowID, access.equal(revealed.element, node) { return true }
            let actions = try access.actions(node)
            if alternate == nil, actions.contains("AXShowAlternateUI"), actions.contains("AXShowDefaultUI"),
               try access.enabled(node) != false { alternate = node }
            let role = try access.role(node)
            if role == "AXWindow" || role == "AXSheet" || role == "AXApplication" { break }
            current = try access.parent(node)
        }
        if let revealed {
            try access.perform(revealed.element, "AXShowDefaultUI")
            self.revealed = nil
        }
        if let alternate {
            try access.perform(alternate, "AXShowAlternateUI")
            revealed = (alternate, windowID)
            return true
        }
        return false
    }
}

final class AXHover {
    private let state = AXHoverState<AXUIElement>()

    /// Entering revealed descendants preserves their parent UI; leaving restores it once.
    func move(to target: AXUIElement?, in route: WindowRoute, access: AXAccess) throws -> Bool {
        try state.move(to: target, windowID: route.windowID, access: AXHoverAccess(
            equal: { CFEqual($0, $1) }, actions: { try access.actions($0) },
            role: { try access.string($0, "AXRole") }, parent: { try access.element($0, "AXParent") },
            enabled: { try access.boolean($0, "AXEnabled") }, perform: { try access.perform($0, $1) }
        ))
    }
}
