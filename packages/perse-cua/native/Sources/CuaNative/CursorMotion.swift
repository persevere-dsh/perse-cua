import CoreGraphics
import Foundation

// Adapted from Cua's cua-cursor-motion (MIT), commit 85e2b1318bd77ccf3cfa88ccdf875a4bb7eaed19.
struct CursorMotionSample: Sendable {
    let t: Double
    let point: CGPoint
    let angle: Double
}

struct CursorTrajectory: Sendable {
    let samples: [CursorMotionSample]
    let arrivalT: Double
    var duration: Double { samples.last?.t ?? 0 }

    func sample(at time: Double) -> CursorMotionSample {
        guard let first = samples.first, let last = samples.last else {
            return CursorMotionSample(t: 0, point: .zero, angle: 0)
        }
        if time <= first.t { return first }
        if time >= last.t { return last }
        var lo = 0, hi = samples.count - 1
        while hi - lo > 1 {
            let mid = (lo + hi) / 2
            if samples[mid].t <= time { lo = mid } else { hi = mid }
        }
        let a = samples[lo], b = samples[hi], f = (time - a.t) / (b.t - a.t)
        return CursorMotionSample(t: time, point: CGPoint(x: a.point.x + (b.point.x - a.point.x) * f,
            y: a.point.y + (b.point.y - a.point.y) * f), angle: a.angle + wrapCursorAngle(b.angle - a.angle) * f)
    }
}

private func wrapCursorAngle(_ a: Double) -> Double {
    var value = a.truncatingRemainder(dividingBy: 2 * .pi)
    if value > .pi { value -= 2 * .pi }
    if value < -.pi { value += 2 * .pi }
    return value
}

/// Plans SignatureArc with Steady timing in screen coordinates and seconds.
func planCursorMotion(from: CGPoint, angle: Double, to: CGPoint, targetSize: CGSize = CGSize(width: 24, height: 24), reducedMotion: Bool = false) -> CursorTrajectory {
    let dx = to.x - from.x, dy = to.y - from.y, distance = hypot(dx, dy)
    let width = max(4, min(targetSize.width, targetSize.height))
    let duration = reducedMotion ? 0.12 : max(0.6, min(1000, max(300, 150 + 120 * log2(distance / width + 1))) * 1.1 / 1000)
    let side: CGFloat = dx >= 0 ? -1 : 1
    let deflection = max(distance, 1) * 0.16 * side
    let px = -dy / max(distance, 1), py = dx / max(distance, 1)
    let c1 = CGPoint(x: from.x + dx * 0.3 + px * deflection * 0.7125, y: from.y + dy * 0.3 + py * deflection * 0.7125)
    let c2 = CGPoint(x: to.x - dx * 0.3 + px * deflection * 0.7875, y: to.y - dy * 0.3 + py * deflection * 0.7875)
    func cubic(_ u: Double) -> CGPoint {
        let v = 1 - u
        return CGPoint(x: v*v*v*from.x + 3*v*v*u*c1.x + 3*v*u*u*c2.x + u*u*u*to.x,
                       y: v*v*v*from.y + 3*v*v*u*c1.y + 3*v*u*u*c2.y + u*u*u*to.y)
    }
    var lengths = [Double](repeating: 0, count: 257)
    var previous = from
    for i in 1...256 {
        let p = cubic(Double(i) / 256)
        lengths[i] = lengths[i-1] + hypot(p.x - previous.x, p.y - previous.y)
        previous = p
    }
    let length = lengths[256]
    func point(_ fraction: Double) -> CGPoint {
        if reducedMotion { return CGPoint(x: from.x + dx * fraction, y: from.y + dy * fraction) }
        if fraction > 1 {
            let p = cubic(0.999), l = max(1e-9, hypot(to.x-p.x, to.y-p.y))
            return CGPoint(x: to.x + (to.x-p.x)/l * (fraction-1)*length, y: to.y + (to.y-p.y)/l * (fraction-1)*length)
        }
        let target = max(0, fraction) * length
        var lo = 0, hi = 256
        while hi - lo > 1 { let mid = (lo+hi)/2; if lengths[mid] < target { lo = mid } else { hi = mid } }
        let f = (target-lengths[lo]) / max(1e-9, lengths[hi]-lengths[lo])
        return cubic((Double(lo)+f)/256)
    }
    let count = max(2, Int(ceil(duration * 120)))
    var positions: [CGPoint] = []
    let over = min(0.018, 8 / max(distance, 1))
    let a = 8.2, b = 1.8, peak = pow(a/10, a) * pow(b/10, b)
    var arrivalIndex: Int?
    for i in 0...count {
        let t = Double(i) / Double(count)
        let fraction = reducedMotion ? t : 0.5 - 0.5 * cos(.pi*t) + over * pow(t,a) * pow(1-t,b) / peak
        if arrivalIndex == nil && fraction >= 1 { arrivalIndex = i }
        positions.append(i == 0 ? from : i == count || arrivalIndex == i ? to : point(fraction))
    }
    var result: [CursorMotionSample] = [], rotation = angle
    for i in 0...count {
        let p0 = positions[max(0, i-2)], p1 = positions[min(count, i+2)]
        let dt = max(0.001, Double(min(count, i+2)-max(0, i-2))*duration/Double(count))
        let vx = (p1.x-p0.x)/dt, vy = (p1.y-p0.y)/dt
        let weight = reducedMotion ? 0 : min(1, max(0, (hypot(vx,vy)-40)/260))
        let want = wrapCursorAngle(atan2(vy,vx) + 0.75 * .pi) * weight
        if i > 0 { rotation += wrapCursorAngle(want-rotation) * (1-exp(-duration/Double(count)*22)) }
        result.append(CursorMotionSample(t: Double(i)*duration/Double(count), point: positions[i], angle: rotation))
    }
    var t = duration
    for _ in 0..<36 where abs(rotation) >= 0.002 {
        t += 1/120
        rotation *= exp(-22/120)
        result.append(CursorMotionSample(t: t, point: to, angle: rotation))
    }
    if let last = result.last { result[result.count-1] = CursorMotionSample(t: last.t, point: to, angle: 0) }
    let arrival = result[arrivalIndex ?? count].t
    return CursorTrajectory(samples: result, arrivalT: arrival)
}
