/**
 * RFC 2606 `.invalid` names must not resolve. Some resolvers (corporate
 * filters, CI sinkholes, sandboxes) map them anyway; a DNS-failure test
 * then asserts the wrong error class. #3459
 */
export async function dnsFixtureSkipReason(host: string): Promise<string | null> {
  try {
    const dns = await import("node:dns/promises");
    const result = await dns.lookup(host);
    return `${host} unexpectedly resolved to ${result.address} (sinkhole or intercepting resolver)`;
  } catch {
    // Lookup failed — NXDOMAIN or a transport error. Either way the
    // name did not resolve, so the DNS-failure fixture is usable.
    return null;
  }
}
