import Foundation
import Dispatch
import Darwin
import Testing
@testable import CuaNative

@Test func sharedLifetimeRetainsAcceptedClientsUntilEveryAdmissionCloses() throws {
    let lifetime = SharedHelperLifetime(startupTimeout: 1)
    var descriptors: [Int32] = [0, 0]
    #expect(socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0)
    let channel = SharedSocket(descriptor: descriptors[0])
    defer { channel.shutdown(); Darwin.close(descriptors[1]) }
    let ids = (0..<100).map { _ in UUID() }
    for id in ids { #expect(lifetime.add(id, channel: channel, cancellation: CancellationLatch())) }
    #expect(lifetime.exitStatusIfEmpty() == nil)
    DispatchQueue.concurrentPerform(iterations: ids.count - 1) { index in
        lifetime.configure(ids[index], grace: 2)
        lifetime.remove(ids[index])
    }
    #expect(!lifetime.isStopping)
    #expect(lifetime.exitStatusIfEmpty() == nil)
    lifetime.configure(ids.last!, grace: 3)
    #expect(lifetime.shutdownGrace == 3)
    lifetime.remove(ids.last!)
    #expect(lifetime.exitStatusIfEmpty() == 0)
    #expect(lifetime.isStopping)
    #expect(!lifetime.add(UUID(), channel: channel, cancellation: CancellationLatch()))
}
