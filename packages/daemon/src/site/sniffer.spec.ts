import { describe, expect, test } from "bun:test";
import { CredentialVault } from "./credentials";
import { Sniffer } from "./sniffer";

describe("Sniffer", () => {
  test("filtered mode without configureSite() treats missing filters as match-all", () => {
    const vault = new CredentialVault();
    const sniffer = new Sniffer(vault);
    sniffer.setMode("teams", "filtered");
    const events = sniffer.asEvents();

    events.onRequest?.("teams", {
      url: "https://teams.example/api/x",
      method: "GET",
      headers: {},
      postData: null,
      resourceType: "xhr",
    });

    // Before the fix, this was silently dropped (empty filter set → returns false).
    const recent = sniffer.getRecentRequests();
    expect(recent).toHaveLength(1);
  });

  test("invalid regex filter falls back to substring match instead of throwing", () => {
    const vault = new CredentialVault();
    const sniffer = new Sniffer(vault);
    sniffer.setMode("teams", "off");
    const events = sniffer.asEvents();

    events.onRequest?.("teams", {
      url: "https://teams.example/api/chat",
      method: "GET",
      headers: {},
      postData: null,
      resourceType: "xhr",
    });

    // `[` is an unclosed character class — invalid regex.
    expect(() => sniffer.getRecentRequests("[invalid")).not.toThrow();
    // Falls back to literal substring match against "[invalid" → no hits, but no throw.
    expect(sniffer.getRecentRequests("[invalid")).toEqual([]);

    // Valid substring filter works through the regex path.
    expect(sniffer.getRecentRequests("chat")).toHaveLength(1);
  });
});
