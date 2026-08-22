import { describe, expect, test } from "bun:test";
import { AGENT_PROTOCOL_VERSION } from "./agent-protocol";
import type { Domain } from "./domain";
import {
  DomainIdentityMismatchError,
  type DomainReadyMessage,
  type DomainSnapshot,
  assertDomainIdentity,
  domainInitMessage,
  domainSnapshotEquals,
  isDomainWorkerMessage,
  isJsonRpcMessage,
  isRemoteDomain,
  toDomainSnapshot,
} from "./domain-protocol";
import { isWireSafe } from "./wire";

const localRow: Domain = {
  id: 7,
  name: "phoenix",
  host: null,
  path: "/projects/phoenix",
  createdAt: "2026-08-22T00:00:00Z",
};

const ready = (overrides?: Partial<DomainReadyMessage>): DomainReadyMessage => ({
  type: "ready",
  supported_protocol_version: AGENT_PROTOCOL_VERSION,
  domain_id: 7,
  ...overrides,
});

describe("toDomainSnapshot", () => {
  test("copies the routing identity of a domain row", () => {
    expect(toDomainSnapshot(localRow)).toEqual({
      id: 7,
      name: "phoenix",
      host: null,
      path: "/projects/phoenix",
      createdAt: "2026-08-22T00:00:00Z",
    });
  });

  test("produces a snapshot that survives JSON — the property the whole link rests on", () => {
    expect(isWireSafe(toDomainSnapshot(localRow))).toBe(true);
    expect(isWireSafe(toDomainSnapshot({ ...localRow, host: "boxen0010" }))).toBe(true);
  });
});

describe("domainInitMessage", () => {
  test("carries the protocol version, the daemon id and the domain", () => {
    const msg = domainInitMessage(toDomainSnapshot(localRow), "daemon-1");
    expect(msg).toEqual({
      type: "init",
      protocol_version: AGENT_PROTOCOL_VERSION,
      daemonId: "daemon-1",
      domain: toDomainSnapshot(localRow),
    });
  });

  test("is wire-safe with and without a daemon id", () => {
    expect(isWireSafe(domainInitMessage(toDomainSnapshot(localRow), null))).toBe(true);
    expect(isWireSafe(domainInitMessage(toDomainSnapshot(localRow), "d"))).toBe(true);
  });

  test("spells 'no daemon id' as null, never as a missing key", () => {
    // An optional field admits `undefined`, which JSON drops — so the far side
    // cannot tell "not sent" from "sent as absent". null survives.
    const msg = domainInitMessage(toDomainSnapshot(localRow), null);
    expect(Object.hasOwn(msg, "daemonId")).toBe(true);
    expect(JSON.parse(JSON.stringify(msg))).toEqual(msg);
  });
});

describe("domainSnapshotEquals", () => {
  const base = toDomainSnapshot(localRow);

  test("true for an identical snapshot", () => {
    expect(domainSnapshotEquals(base, { ...base })).toBe(true);
  });

  test("false when the name, path, host or id changes", () => {
    expect(domainSnapshotEquals(base, { ...base, name: "renamed" })).toBe(false);
    expect(domainSnapshotEquals(base, { ...base, path: "/elsewhere" })).toBe(false);
    expect(domainSnapshotEquals(base, { ...base, host: "boxen0010" })).toBe(false);
    expect(domainSnapshotEquals(base, { ...base, id: 8 })).toBe(false);
  });

  test("ignores createdAt, which cannot change for a given id", () => {
    expect(domainSnapshotEquals(base, { ...base, createdAt: "1999-01-01T00:00:00Z" })).toBe(true);
  });
});

describe("isRemoteDomain", () => {
  test("a null host is local; any host is remote", () => {
    const snapshot: DomainSnapshot = toDomainSnapshot(localRow);
    expect(isRemoteDomain(snapshot)).toBe(false);
    expect(isRemoteDomain({ ...snapshot, host: "boxen0010" })).toBe(true);
  });
});

describe("message guards", () => {
  test("recognises worker control messages", () => {
    expect(isDomainWorkerMessage(ready())).toBe(true);
    expect(isDomainWorkerMessage({ type: "error", message: "boom" })).toBe(true);
  });

  test("does not mistake JSON-RPC for control traffic", () => {
    const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list" };
    expect(isDomainWorkerMessage(rpc)).toBe(false);
    expect(isJsonRpcMessage(rpc)).toBe(true);
  });

  test("rejects nonsense of every shape", () => {
    for (const value of [null, undefined, 1, "ready", [], {}, { type: 2 }, { type: "init" }]) {
      expect(isDomainWorkerMessage(value)).toBe(false);
    }
    for (const value of [null, undefined, {}, { jsonrpc: "1.0" }, { jsonrpc: 2 }]) {
      expect(isJsonRpcMessage(value)).toBe(false);
    }
  });
});

describe("assertDomainIdentity", () => {
  test("passes when the worker bound the domain it was asked for", () => {
    expect(() => assertDomainIdentity(7, ready())).not.toThrow();
  });

  test("throws when the worker reports a different domain", () => {
    // In-process this is nearly tautological. Over a socket to a host serving
    // several domains it is the check that catches a mis-routed link — which is
    // exactly the failure a supervisor must never paper over.
    expect(() => assertDomainIdentity(7, ready({ domain_id: 9 }))).toThrow(DomainIdentityMismatchError);
    try {
      assertDomainIdentity(7, ready({ domain_id: 9 }));
    } catch (err) {
      expect((err as DomainIdentityMismatchError).requested).toBe(7);
      expect((err as DomainIdentityMismatchError).reported).toBe(9);
    }
  });
});
