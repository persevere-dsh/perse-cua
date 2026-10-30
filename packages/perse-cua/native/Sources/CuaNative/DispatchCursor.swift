import AppKit
import CoreGraphics

/// Displays a plan and the last pointer position dispatched by one connection.
@MainActor final class DispatchCursor {
    private var panel: NSPanel?
    private var closed = false
    private var revision: UInt64 = 0
    private var unavailableReported = false
    private var lastRoute: WindowRoute?
    private var lastPoint: CGPoint?

    func plan(_ route: WindowRoute, point: WindowPoint) async throws {
        let destination = CGPoint(x: route.bounds.x + point.x, y: route.bounds.y + point.y)
        guard let window = window(for: destination) else { return }
        revision &+= 1
        let sameWindow = lastRoute.map { $0.owner == route.owner && $0.windowID == route.windowID && $0.bounds == route.bounds } ?? false
        let origin = sameWindow ? lastPoint : nil
        setPlanned(true, on: window)
        guard let endFrame = frame(for: destination) else { return }
        let startFrame = origin.flatMap { frame(for: $0) }
        window.alphaValue = startFrame == nil ? 0 : 1
        window.setFrame(startFrame ?? endFrame, display: true)
        window.orderFrontRegardless()
        let completion = CursorAnimationCompletion()
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { continuation in
                    completion.install(continuation)
                    NSAnimationContext.runAnimationGroup { context in
                        context.duration = startFrame == nil ? 0.12 : 0.25
                        if startFrame == nil { window.animator().alphaValue = 1 }
                        else { window.animator().setFrame(endFrame, display: true) }
                    } completionHandler: { completion.finish(nil) }
                }
            } onCancel: { completion.finish(CancellationError()) }
            try Task.checkCancellation()
        } catch { hide(); throw error }
    }

    func show(_ route: WindowRoute, point: CGPoint, clicked: Bool = false) {
        guard let window = window(for: point), let frame = frame(for: point) else { return }
        lastRoute = route
        lastPoint = point
        revision &+= 1
        let shownRevision = revision
        setPlanned(false, on: window)
        (window.contentView as? DispatchCursorView)?.clicked = clicked
        window.alphaValue = 1
        window.setFrame(frame, display: true)
        window.orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.8
            window.animator().alphaValue = 0
        } completionHandler: { [weak self, weak window] in
            Task { @MainActor in
                guard let self, self.revision == shownRevision else { return }
                window?.orderOut(nil)
            }
        }
    }

    func hide() {
        revision &+= 1
        panel?.orderOut(nil)
    }

    func close() {
        closed = true
        hide()
        panel?.close()
        panel = nil
        lastRoute = nil
        lastPoint = nil
    }

    private func frame(for point: CGPoint) -> NSRect? {
        guard point.x.isFinite, point.y.isFinite, let primary = NSScreen.screens.first else { return nil }
        return NSRect(x: point.x, y: primary.frame.maxY - point.y - 24, width: 24, height: 24)
    }

    private func window(for point: CGPoint) -> NSPanel? {
        guard !closed else { return nil }
        guard NSApp.activationPolicy() == .accessory, let frame = frame(for: point) else {
            if !unavailableReported {
                unavailableReported = true
                fputs("CURSOR_UNAVAILABLE: Native cursor window is unavailable\n", stderr)
            }
            return nil
        }
        if let panel { return panel }
        let window = NSPanel(contentRect: frame, styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        window.isOpaque = false
        window.backgroundColor = .clear
        window.hasShadow = false
        window.ignoresMouseEvents = true
        window.level = .screenSaver
        window.collectionBehavior = [.canJoinAllSpaces, .stationary, .ignoresCycle]
        window.sharingType = .none
        window.contentView = DispatchCursorView(frame: NSRect(x: 0, y: 0, width: 24, height: 24))
        panel = window
        return window
    }

    private func setPlanned(_ planned: Bool, on window: NSPanel) {
        guard let view = window.contentView as? DispatchCursorView else { return }
        view.planned = planned
        view.clicked = false
        view.needsDisplay = true
    }
}

private final class DispatchCursorView: NSView {
    var planned = false
    var clicked = false
    override func draw(_ dirtyRect: NSRect) {
        if clicked {
            let ring = NSBezierPath(ovalIn: NSRect(x: 1, y: 13, width: 12, height: 10))
            NSColor.black.withAlphaComponent(0.35).setStroke()
            ring.lineWidth = 2.5
            ring.stroke()
            NSColor.white.withAlphaComponent(0.8).setStroke()
            ring.lineWidth = 1.2
            ring.stroke()
        }
        let path = NSBezierPath()
        path.move(to: NSPoint(x: 2, y: 22))
        path.line(to: NSPoint(x: 2, y: 3))
        path.line(to: NSPoint(x: 8, y: 8))
        path.line(to: NSPoint(x: 12, y: 1))
        path.line(to: NSPoint(x: 16, y: 3))
        path.line(to: NSPoint(x: 12, y: 10))
        path.line(to: NSPoint(x: 20, y: 10))
        path.close()
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
        shadow.shadowBlurRadius = 3
        shadow.shadowOffset = NSSize(width: 0, height: -1)
        shadow.set()
        NSColor(white: 0.18, alpha: planned ? 0.8 : 1).setFill()
        path.fill()
        NSGraphicsContext.restoreGraphicsState()
        NSColor.white.setStroke()
        path.lineWidth = 1.5
        path.stroke()
    }
}

/// Resolves animation completion or cancellation once, including cancellation before installation.
final class CursorAnimationCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, any Error>?
    private var result: Result<Void, any Error>?

    func install(_ continuation: CheckedContinuation<Void, any Error>) {
        let result: Result<Void, any Error>? = lock.withLock {
            if let result { return result }
            self.continuation = continuation
            return nil
        }
        if let result { continuation.resume(with: result) }
    }

    func finish(_ error: (any Error)?) {
        let next = lock.withLock {
            guard result == nil else { return nil as CheckedContinuation<Void, any Error>? }
            let result: Result<Void, any Error> = error.map { .failure($0) } ?? .success(())
            self.result = result
            let next = continuation
            continuation = nil
            return next
        }
        if let next {
            if let error { next.resume(throwing: error) } else { next.resume() }
        }
    }
}
