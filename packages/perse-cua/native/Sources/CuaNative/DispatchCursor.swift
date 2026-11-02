import AppKit
import CoreGraphics

/// Keep request failure cleanup attached to the pointer operation that owns it.
@MainActor final class CursorRequestOwnership {
    private var revision: UInt64 = 0

    func begin(method: String, interrupt: () -> Void) -> UInt64? {
        guard ["click", "hover", "scroll", "drag"].contains(method) else { return nil }
        revision &+= 1
        interrupt()
        return revision
    }

    func fail(_ owner: UInt64?, hide: () -> Void) {
        guard let owner, owner == revision else { return }
        hide()
    }

    func close(_ hide: () -> Void) {
        revision &+= 1
        hide()
    }
}

/// Displays a plan and the last pointer position dispatched by one connection.
@MainActor final class DispatchCursor {
    private var panel: NSPanel?
    private var closed = false
    private let visibility = CursorVisibility()
    private var feedbackTask: Task<Void, Never>?
    private var routeTask: Task<Void, Never>?
    private var monitoredRoute: WindowRoute?
    private let routeRevision = CursorVisibility()
    private var movementTask: Task<Void, Never>?
    private let movement = CursorVisibility()
    private var arrivalCompletion: CursorAnimationCompletion?
    private var movementTarget: (route: WindowRoute, point: CGPoint)?
    private var unavailableReported = false
    private var displayedPoint: CGPoint?
    private var displayedAngle = 0.0
    private(set) var colorHex = CursorTheme.colorHex
    var onPlan: ((WindowRoute, CursorTrajectory) -> Void)?
    var onClick: ((WindowRoute, CGPoint, Double) -> Void)?
    var onPosition: ((WindowRoute, CGPoint, Double) -> Void)?
    var onInvalid: ((WindowRoute) -> Void)?

    func setSessionName(_ name: String?) {
        let palette = [CursorTheme.colorHex, "#A78BFA", "#F472B6", "#F59E73", "#8BCF9B", "#D1B35E", "#7FA9EE", "#BD9ADB"]
        if let name, !name.isEmpty {
            var hash: UInt32 = 2166136261
            for byte in name.utf8 { hash = (hash ^ UInt32(byte)) &* 16777619 }
            colorHex = palette[Int(hash % UInt32(palette.count))]
        } else { colorHex = CursorTheme.colorHex }
        if let view = panel?.contentView as? DispatchCursorView {
            view.color = cursorColor(colorHex)
            view.needsDisplay = true
        }
    }

    func plan(_ route: WindowRoute, point: WindowPoint, targetSize: CGSize = CGSize(width: 24, height: 24)) async throws {
        let destination = CGPoint(x: route.bounds.x + point.x, y: route.bounds.y + point.y)
        guard let window = window(for: destination), frame(for: destination) != nil else {
            throw NativeFailure(code: "CURSOR_UNAVAILABLE", message: "Native cursor window is unavailable")
        }
        feedbackTask?.cancel()
        cancelMovement()
        visibility.advance()
        let start = displayedPoint ?? CGPoint(x: destination.x - 36, y: destination.y + 24)
        let size = targetSize.width.isFinite && targetSize.height.isFinite && targetSize.width > 0 && targetSize.height > 0
            ? targetSize : CGSize(width: 24, height: 24)
        let trajectory = planCursorMotion(from: start, angle: displayedAngle, to: destination, targetSize: size,
            reducedMotion: NSWorkspace.shared.accessibilityDisplayShouldReduceMotion)
        monitor(route)
        movementTarget = (route, destination)
        let revision = movement.advance()
        let startTime = ProcessInfo.processInfo.systemUptime
        window.alphaValue = 1
        setPlanned(true, on: window)
        apply(trajectory.samples[0], to: window)
        window.orderFrontRegardless()
        onPlan?(route, trajectory)
        let completion = CursorAnimationCompletion()
        arrivalCompletion = completion
        movementTask = Task { @MainActor [weak self, weak window] in
            var arrived = false
            while !Task.isCancelled {
                guard let self, let window, self.movement.isCurrent(revision), window.isVisible else {
                    completion.finish(NativeFailure(code: "CURSOR_UNAVAILABLE", message: "Cursor movement was interrupted before arrival"))
                    return
                }
                let elapsed = ProcessInfo.processInfo.systemUptime - startTime
                let frameTime = !arrived && elapsed >= trajectory.arrivalT ? trajectory.arrivalT : elapsed
                guard self.apply(trajectory.sample(at: frameTime), to: window) else {
                    completion.finish(NativeFailure(code: "CURSOR_UNAVAILABLE", message: "Cursor geometry is unavailable"))
                    return
                }
                if !arrived && elapsed >= trajectory.arrivalT { arrived = true; completion.finish(nil) }
                if elapsed >= trajectory.duration {
                    self.movementTask = nil
                    self.movementTarget = nil
                    return
                }
                do { try await Task.sleep(for: .milliseconds(8)) } catch { completion.finish(error); return }
            }
        }
        let timeout = Task { @MainActor in
            do { try await Task.sleep(for: .seconds(trajectory.arrivalT + 0.25)); try Task.checkCancellation() } catch { return }
            completion.finish(NativeFailure(code: "CURSOR_UNAVAILABLE", message: "Cursor movement timed out before arrival"))
        }
        do {
            try await withTaskCancellationHandler {
                try await withCheckedThrowingContinuation { completion.install($0) }
                try Task.checkCancellation()
            } onCancel: {
                completion.finish(CancellationError())
            }
            timeout.cancel()
            guard movement.isCurrent(revision), window.isVisible else {
                throw NativeFailure(code: "CURSOR_UNAVAILABLE", message: "Cursor movement was interrupted before arrival")
            }
            arrivalCompletion = nil
        } catch {
            timeout.cancel()
            if movement.isCurrent(revision) { cancelMovement() }
            throw error
        }
    }

    func show(_ route: WindowRoute, point: CGPoint, clicked: Bool = false) {
        guard let window = window(for: point), frame(for: point) != nil else { return }
        let followsPlan = movementTarget.map {
            $0.route.owner == route.owner && $0.route.windowID == route.windowID &&
            $0.route.bounds == route.bounds && $0.point == point
        } ?? false
        if !followsPlan { cancelMovement() }
        monitor(route)
        feedbackTask?.cancel()
        let shownRevision = visibility.advance()
        setPlanned(false, on: window)
        window.alphaValue = 1
        if !followsPlan { apply(CursorMotionSample(t: 0, point: point, angle: 0), to: window) }
        window.orderFrontRegardless()
        if clicked {
            onClick?(route, point, displayedAngle)
            showClickFeedback(on: window, revision: shownRevision)
        } else {
            onPosition?(route, point, displayedAngle)
        }

    }

    @discardableResult private func apply(_ sample: CursorMotionSample, to window: NSPanel) -> Bool {
        guard let rect = frame(for: sample.point) else { cancelMovement(); return false }
        displayedPoint = sample.point
        displayedAngle = sample.angle
        (window.contentView as? DispatchCursorView)?.angle = sample.angle
        window.setFrame(rect, display: true)
        return true
    }

    func invalidateRouteMonitor() {
        routeTask?.cancel()
        routeTask = nil
        monitoredRoute = nil
        routeRevision.advance()
    }

    func hide() {
        invalidateRouteMonitor()
        feedbackTask?.cancel()
        feedbackTask = nil
        cancelMovement()
        visibility.advance()
        panel?.orderOut(nil)
    }

    func close() {
        closed = true
        hide()
        panel?.close()
        panel = nil
        displayedPoint = nil
        displayedAngle = 0
    }

    func cancelMovement() {
        arrivalCompletion?.finish(CancellationError())
        arrivalCompletion = nil
        movementTask?.cancel()
        movementTask = nil
        movement.advance()
        movementTarget = nil
    }

    private func monitor(_ route: WindowRoute) {
        if monitoredRoute == route { return }
        routeTask?.cancel()
        monitoredRoute = route
        let revision = routeRevision.advance()
        routeTask = scheduleCursorRouteMonitor(route: route,
            pause: { try await Task.sleep(for: .milliseconds(250)) },
            validate: { route in
                await Task.detached(priority: .utility) {
                    do {
                        try NativePlatform.verify(route.owner)
                        return try NativePlatform.ownedWindow(route.owner.pid, route.windowID).bounds == route.bounds
                    } catch { return false }
                }.value
            }, onInvalid: { [weak self] route in
                guard let self, self.routeRevision.isCurrent(revision) else { return }
                self.hide()
                self.onInvalid?(route)
            })
    }

    private func showClickFeedback(on window: NSPanel, revision: UInt64) {
        guard let view = window.contentView as? DispatchCursorView else { return }
        let reduced = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        view.clickProgress = reduced ? 0.35 : 0
        view.needsDisplay = true
        feedbackTask?.cancel()
        feedbackTask = Task { @MainActor [weak self, weak window] in
            let start = ProcessInfo.processInfo.systemUptime
            repeat {
                do { try await Task.sleep(for: .milliseconds(16)); try Task.checkCancellation() } catch { return }
                guard let self, let view = window?.contentView as? DispatchCursorView,
                      self.visibility.isCurrent(revision) else { return }
                view.clickProgress = reduced ? CursorTheme.clickReducedFrame / CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0 : min(1, (ProcessInfo.processInfo.systemUptime - start) / (CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0 / CursorTheme.clickFPS))
                view.needsDisplay = true
            } while ProcessInfo.processInfo.systemUptime - start < (reduced ? CursorTheme.clickReducedDurationMs / 1000 : CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0 / CursorTheme.clickFPS)
            (window?.contentView as? DispatchCursorView)?.clickProgress = nil
            window?.contentView?.needsDisplay = true
        }
    }

    private func frame(for point: CGPoint) -> NSRect? {
        guard point.x.isFinite, point.y.isFinite, let primary = NSScreen.screens.first else { return nil }
        let hotspot = CGPoint(x: 11 + CursorTheme.size * CursorTheme.hotspot.x / CursorTheme.viewBox,
                              y: 11 + CursorTheme.size * CursorTheme.hotspot.y / CursorTheme.viewBox)
        return NSRect(x: point.x - hotspot.x, y: primary.frame.maxY - point.y - (64 - hotspot.y), width: 64, height: 64)
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
        let view = DispatchCursorView(frame: NSRect(x: 0, y: 0, width: 64, height: 64))
        view.color = cursorColor(colorHex)
        window.contentView = view
        panel = window
        return window
    }

    private func setPlanned(_ planned: Bool, on window: NSPanel) {
        guard let view = window.contentView as? DispatchCursorView else { return }
        view.planned = planned
        view.clickProgress = nil
        view.needsDisplay = true
    }
}

/// Monitor one route without running WindowServer queries on the main actor.
@MainActor func scheduleCursorRouteMonitor(
    route: WindowRoute, pause: @escaping @Sendable () async throws -> Void,
    validate: @escaping @Sendable (WindowRoute) async -> Bool,
    onInvalid: @escaping @MainActor (WindowRoute) -> Void
) -> Task<Void, Never> {
    Task { @MainActor in
        while !Task.isCancelled {
            let valid = await validate(route)
            guard !Task.isCancelled else { return }
            if !valid { onInvalid(route); return }
            do { try await pause(); try Task.checkCancellation() } catch { return }
        }
    }
}

/// Invalidates delayed feedback when a newer cursor state replaces it.
final class CursorVisibility {
    private var revision: UInt64 = 0
    var current: UInt64 { revision }

    @discardableResult func advance() -> UInt64 {
        revision &+= 1
        return revision
    }

    func isCurrent(_ token: UInt64) -> Bool { revision == token }
}

private func cursorColor(_ hex: String) -> NSColor {
    let value = UInt32(hex.dropFirst(), radix: 16) ?? 0x5ec0e8
    return NSColor(red: CGFloat((value >> 16) & 255) / 255,
                   green: CGFloat((value >> 8) & 255) / 255,
                   blue: CGFloat(value & 255) / 255, alpha: 1)
}

// Theme geometry is generated from cursor-theme.json; Cua default theme is MIT licensed.
private final class DispatchCursorView: NSView {
    var planned = false
    var angle = 0.0 { didSet { needsDisplay = true } }
    var clickProgress: Double?
    var color = CursorTheme.color
    override var isFlipped: Bool { true }
    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        context.saveGState()
        context.translateBy(x: 11, y: 11)
        context.scaleBy(x: CursorTheme.size / CursorTheme.viewBox, y: CursorTheme.size / CursorTheme.viewBox)
        context.translateBy(x: CursorTheme.hotspot.x, y: CursorTheme.hotspot.y)
        context.rotate(by: angle)
        let progress = clickProgress
        let scale: Double
        if let progress {
            let frame = progress * CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0
            let frames = CursorTheme.clickFrames
            let index = min(frames.count - 2, max(0, frames.firstIndex(where: { $0.0 > frame }).map { $0 - 1 } ?? frames.count - 2))
            let a = frames[index], b = frames[index + 1]
            scale = (a.1 + (b.1 - a.1) * max(0, min(1, (frame - a.0) / (b.0 - a.0)))) / 100
        } else { scale = 1 }
        context.scaleBy(x: scale, y: scale)
        context.translateBy(x: -CursorTheme.hotspot.x, y: -CursorTheme.hotspot.y)
        let path = NSBezierPath()
        path.move(to: CursorTheme.vertices[0].0)
        for i in 0..<CursorTheme.vertices.count {
            let current = CursorTheme.vertices[i], next = CursorTheme.vertices[(i + 1) % CursorTheme.vertices.count]
            path.curve(to: next.0, controlPoint1: CGPoint(x: current.0.x + current.2.x, y: current.0.y + current.2.y),
                       controlPoint2: CGPoint(x: next.0.x + next.1.x, y: next.0.y + next.1.y))
        }
        path.close()
        path.lineJoinStyle = .round
        path.lineCapStyle = .round
        for (width, opacity) in CursorTheme.glow {
            path.lineWidth = width
            color.withAlphaComponent(opacity).setStroke()
            path.stroke()
        }
        color.withAlphaComponent(planned ? 0.88 : 1).setFill()
        path.fill()
        NSColor.white.setStroke()
        path.lineWidth = CursorTheme.strokeWidth
        path.stroke()
        if let progress {
            let frame = progress * CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0
            let opacity = min(1, frame / CursorTheme.cueFadeInFrames, max(0, (CursorTheme.clickFrames[CursorTheme.clickFrames.count - 1].0 - frame) / CursorTheme.cueFadeOutFrames))
            context.saveGState()
            context.translateBy(x: CursorTheme.hotspot.x, y: CursorTheme.hotspot.y)
            let cueScale = CursorTheme.cueStartScale + (CursorTheme.cueEndScale - CursorTheme.cueStartScale) * progress
            context.scaleBy(x: cueScale, y: cueScale)
            context.translateBy(x: -CursorTheme.hotspot.x, y: -CursorTheme.hotspot.y)
            let cue = NSBezierPath()
            for (a, b) in CursorTheme.clickCue {
                cue.move(to: a); cue.line(to: b)
            }
            cue.lineCapStyle = .round
            cue.lineWidth = CursorTheme.cueOuterWidth
            NSColor.white.withAlphaComponent(opacity).setStroke(); cue.stroke()
            cue.lineWidth = CursorTheme.cueInnerWidth
            color.withAlphaComponent(opacity).setStroke(); cue.stroke()
            context.restoreGState()
        }
        context.restoreGState()
    }
}

/// Resolves animation completion or cancellation once, including cancellation before installation.
final class CursorAnimationCompletion: @unchecked Sendable {
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, any Error>?
    private var result: Result<Void, any Error>?

    func install(_ continuation: CheckedContinuation<Void, any Error>) {
        let result: Result<Void, any Error>? = lock.withLock {
            if let result = self.result { return result }
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
