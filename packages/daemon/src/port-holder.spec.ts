import { describe, expect, it } from "bun:test";
import { getPortHolder } from "./port-holder";

describe("getPortHolder", () => {
  it("returns null for a port with no listener", async () => {
    // Use a port unlikely to have a listener
    const result = await getPortHolder(19);
    expect(result).toBeNull();
  });

  it("returns process info for a port with a listener", async () => {
    // Start a server on a random port, then query it
    const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    try {
      const port = server.port;
      if (port === undefined) throw new Error("server.port is undefined");
      const result = await getPortHolder(port);
      // lsof should find the bun process holding this port
      expect(result).not.toBeNull();
      expect(result).toContain("PID");
    } finally {
      server.stop(true);
    }
  });
});
