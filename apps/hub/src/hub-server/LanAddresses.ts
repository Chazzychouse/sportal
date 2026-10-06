/**
 * The addresses a phone on the home network can reach this machine at: its external IPv4 addresses, home
 * ranges (192.168, 10, 172.16–31) first, then any other, such as a VPN's. Container and VM bridges are left
 * out, since nothing outside the machine can reach them. Takes the shape of `os.networkInterfaces()`.
 */
export function lanAddresses(
  interfaces: Record<
    string,
    ReadonlyArray<{ address: string; family: string; internal: boolean }> | undefined
  >
): ReadonlyArray<string> {
  return Object.entries(interfaces)
    .filter(([name]) => !bridges.test(name))
    .flatMap(([, addresses]) => addresses ?? [])
    .filter((address) => address.family === "IPv4" && !address.internal)
    .map(({ address }) => address)
    .filter((address) => !address.startsWith("169.254."))
    .sort((a, b) => rank(a) - rank(b))
}

const bridges = /^(docker|br-|veth|virbr|vmnet|vboxnet|cni|flannel|podman)/

function rank(address: string) {
  if (address.startsWith("192.168.")) return 0
  if (address.startsWith("10.")) return 1
  return /^172\.(1[6-9]|2\d|3[01])\./.test(address) ? 2 : 3
}
