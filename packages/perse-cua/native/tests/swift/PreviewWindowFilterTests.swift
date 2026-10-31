import Testing
@testable import CuaNative

@Test func previewSharingFilterDoesNotClassifyOrdinarySmallWindowsBySize() {
    let close = WindowBounds(x: 108, y: 816, width: 16, height: 16)
    let small = WindowBounds(x: 106, y: 814, width: 66, height: 20)
    #expect(AXAccess.sharingControlOverCloseButton(small, close: close))
    #expect(!AXAccess.sharingControlSignature(role: "AXWindow", subrole: "AXStandardWindow", childCount: 1, childRole: "AXButton", childTitle: "WindowSharingSessionButton"))
    #expect(!AXAccess.sharingControlSignature(role: "AXWindow", subrole: "AXDialog", childCount: 1, childRole: "AXButton", childTitle: "Confirm"))
    #expect(AXAccess.sharingControlSignature(role: "AXWindow", subrole: "AXDialog", childCount: 1, childRole: "AXButton", childTitle: "WindowSharingSessionButton"))
    #expect(!AXAccess.sharingControlOverCloseButton(small, close: WindowBounds(x: 300, y: 400, width: 16, height: 16)))
}
