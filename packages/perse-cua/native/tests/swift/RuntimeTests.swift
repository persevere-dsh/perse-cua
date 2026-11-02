import Darwin
import Foundation
import Testing
@testable import CuaNative

@Test(.timeLimit(.minutes(1))) func partialVisualWriteClosesTheStreamBeforeTheReply() async throws {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw SharedSocket.failure("Creating fixture sockets") }
    let channel = SharedSocket(descriptor: descriptors[0])
    let peer = SharedSocket(descriptor: descriptors[1])
    defer { channel.shutdown(); peer.shutdown() }
    var capacity: Int32 = 4096
    #expect(setsockopt(channel.descriptor, SOL_SOCKET, SO_SNDBUF, &capacity, socklen_t(MemoryLayout<Int32>.size)) == 0)
    let writer = JSONLWriter(limit: 8 * 1024 * 1024, channel: channel, writeTimeout: 0.2)
    writer.visual(.object(["type": .string("visual"), "payload": .string(String(repeating: "x", count: 4 * 1024 * 1024))]),
                  started: ProcessInfo.processInfo.systemUptime)
    var readable = pollfd(fd: peer.descriptor, events: Int16(POLLIN), revents: 0)
    #expect(poll(&readable, 1, 2000) == 1)
    let reply = Task.detached { () -> Bool in
        do {
            try await writer.write(.object(["id": .string("reply-after-partial-frame"), "result": .bool(true)]))
            return false
        } catch { return true }
    }
    #expect(await reply.value)
    var received = Data()
    var chunk = [UInt8](repeating: 0, count: 8192)
    while true {
        let count = try chunk.withUnsafeMutableBytes { try peer.read(into: $0) }
        if count == 0 { break }
        received.append(contentsOf: chunk.prefix(count))
    }
    #expect(!received.isEmpty)
    #expect(!received.contains(10))
    #expect(!received.contains(Data("reply-after-partial-frame".utf8)))
}

@Test func oversizedVisualIsDroppedBeforeWritingAndDoesNotCloseTheStream() async throws {
    var descriptors: [Int32] = [0, 0]
    guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else { throw SharedSocket.failure("Creating fixture sockets") }
    let channel = SharedSocket(descriptor: descriptors[0])
    let peer = SharedSocket(descriptor: descriptors[1])
    defer { channel.shutdown(); peer.shutdown() }
    let writer = JSONLWriter(limit: 1024, channel: channel, writeTimeout: 1)
    writer.visual(.object(["type": .string("visual"), "payload": .string(String(repeating: "x", count: 2048))]),
                  started: ProcessInfo.processInfo.systemUptime)
    try await writer.write(.object(["id": .string("reply"), "result": .bool(true)]))
    var bytes = [UInt8](repeating: 0, count: 1024)
    let count = try bytes.withUnsafeMutableBytes { try peer.read(into: $0) }
    let response = try JSONDecoder().decode(JSONValue.self, from: Data(bytes.prefix(count)))
    #expect(response["id"] == .string("reply"))
}
