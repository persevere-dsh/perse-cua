import Testing
@testable import CuaNative

private final class HoverFixture {
    var parents: [Int: Int] = [2: 1, 1: 0, 3: 0]
    var alternatives: Set<Int> = [1]
    var disabled: Set<Int> = []
    var actions: [String] = []
    var fail: String?
    var access: AXHoverAccess<Int> {
        AXHoverAccess(equal: ==, actions: { self.alternatives.contains($0) ? ["AXShowAlternateUI", "AXShowDefaultUI"] : [] },
            role: { $0 == 0 ? "AXWindow" : "AXGroup" }, parent: { self.parents[$0] },
            enabled: { !self.disabled.contains($0) }, perform: { node, action in
                self.actions.append("\(node):\(action)")
                if self.fail == action { throw NativeFailure(code: "NATIVE_ERROR", message: "fixture failure") }
            })
    }
}

@Test func alternateHoverPreservesDescendantsAndRestoresOnceOnExit() throws {
    let fixture = HoverFixture(), hover = AXHoverState<Int>()
    #expect(try hover.move(to: 1, windowID: 7, access: fixture.access))
    #expect(try hover.move(to: 2, windowID: 7, access: fixture.access))
    #expect(try !hover.move(to: 3, windowID: 7, access: fixture.access))
    #expect(try !hover.move(to: 3, windowID: 7, access: fixture.access))
    #expect(fixture.actions == ["1:AXShowAlternateUI", "1:AXShowDefaultUI"])
}

@Test func alternateHoverDoesNotUseDisabledActionsAndHandlesWindowChanges() throws {
    let fixture = HoverFixture(), hover = AXHoverState<Int>()
    fixture.disabled.insert(1)
    #expect(try !hover.move(to: 1, windowID: 7, access: fixture.access))
    #expect(fixture.actions.isEmpty)
    fixture.disabled.remove(1)
    #expect(try hover.move(to: 1, windowID: 7, access: fixture.access))
    #expect(try hover.move(to: 1, windowID: 8, access: fixture.access))
    #expect(fixture.actions == ["1:AXShowAlternateUI", "1:AXShowDefaultUI", "1:AXShowAlternateUI"])
}

@Test func alternateHoverReportsCyclesAndNeverFallsBackAfterActionFailure() throws {
    let fixture = HoverFixture(), hover = AXHoverState<Int>()
    fixture.parents[3] = 3
    #expect(throws: NativeFailure.self) { try hover.move(to: 3, windowID: 7, access: fixture.access) }
    #expect(fixture.actions.isEmpty)
    fixture.fail = "AXShowAlternateUI"
    #expect(throws: NativeFailure.self) { try hover.move(to: 1, windowID: 7, access: fixture.access) }
    #expect(fixture.actions == ["1:AXShowAlternateUI"])
    fixture.fail = nil
    #expect(try !hover.move(to: 0, windowID: 7, access: fixture.access))
    #expect(fixture.actions == ["1:AXShowAlternateUI"])
}

@Test func failedRestoreRetainsOwnershipForAConfirmedRetry() throws {
    let fixture = HoverFixture(), hover = AXHoverState<Int>()
    #expect(try hover.move(to: 1, windowID: 7, access: fixture.access))
    fixture.fail = "AXShowDefaultUI"
    #expect(throws: NativeFailure.self) { try hover.move(to: 3, windowID: 7, access: fixture.access) }
    fixture.fail = nil
    #expect(try !hover.move(to: 3, windowID: 7, access: fixture.access))
    #expect(fixture.actions == ["1:AXShowAlternateUI", "1:AXShowDefaultUI", "1:AXShowDefaultUI"])
}
