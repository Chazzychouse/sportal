import { assert, describe, it } from "@effect/vitest"
import { lanAddresses } from "./LanAddresses.ts"

describe("lanAddresses", () => {
  it("lists external IPv4 addresses, home ranges first, then any other such as a VPN", () => {
    assert.deepStrictEqual(
      lanAddresses({
        lo: [v4("127.0.0.1", true), v6("::1", true)],
        tailscale0: [v4("100.64.0.9")],
        eth0: [v4("10.0.0.7")],
        wlo1: [v4("192.168.0.54"), v6("fe80::1")]
      }),
      ["192.168.0.54", "10.0.0.7", "100.64.0.9"]
    )
  })

  it("leaves out container and VM bridges", () => {
    assert.deepStrictEqual(
      lanAddresses({
        docker0: [v4("172.17.0.1")],
        "br-3f2a": [v4("172.18.0.1")],
        virbr0: [v4("192.168.122.1")],
        veth12: [v4("169.254.1.1")],
        enp3s0: [v4("172.20.1.5")]
      }),
      ["172.20.1.5"]
    )
  })

  it("is empty with no network", () => {
    assert.deepStrictEqual(lanAddresses({ lo: [v4("127.0.0.1", true)], down: undefined }), [])
  })
})

function v4(address: string, internal = false) {
  return { address, family: "IPv4", internal }
}

function v6(address: string, internal = false) {
  return { address, family: "IPv6", internal }
}
