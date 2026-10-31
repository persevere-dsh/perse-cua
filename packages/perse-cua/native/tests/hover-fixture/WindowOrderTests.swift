@main enum WindowOrderTests {
    static func main() {
        let front = WindowOrderEntry(id: 1, pid: 10, layer: 0)
        let fixture = WindowOrderEntry(id: 2, pid: 20, layer: 0)
        let floating = WindowOrderEntry(id: 3, pid: 30, layer: 3)
        precondition(fixtureIsBehindOtherNormalWindows([floating, front, fixture], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([fixture, front], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([front], fixtureID: 2, fixturePID: 20))
        precondition(!fixtureIsBehindOtherNormalWindows([front, fixture], fixtureID: 2, fixturePID: 99))
        print("PASS: fixture window order is checked conservatively")
    }
}
