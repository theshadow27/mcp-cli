/**
 * Shared test helpers for daemon spec files.
 */
import { mock } from "bun:test";
import {
  AGENT_PROTOCOL_VERSION,
  type ConfigSource,
  type DomainControlMessage,
  type DomainReadyMessage,
  type DomainSnapshot,
  type ResolvedConfig,
  type ResolvedServer,
  type ServerConfig,
  assertWireSafe,
} from "@mcp-cli/core";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { DomainLink } from "./domain-link";

export const testSource: ConfigSource = { file: "/test", scope: "user" };

/** Build a minimal ResolvedConfig for testing. */
export function makeConfig(servers: Record<string, ServerConfig>): ResolvedConfig {
  const map = new Map<string, ResolvedServer>();
  for (const [name, config] of Object.entries(servers)) {
    map.set(name, { name, config, source: testSource });
  }
  return { servers: map, sources: [] };
}

export function makeMockTransport() {
  return {
    close: mock(() => Promise.resolve()),
    start: mock(() => Promise.resolve()),
    send: mock(() => Promise.resolve()),
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((err: Error) => void) | undefined,
  };
}

/** Build a mock MCP Client with optional overrides for specific methods. */
export function makeMockClient(overrides?: {
  callTool?: (...args: unknown[]) => Promise<unknown>;
  listTools?: () => Promise<{ tools: unknown[] }>;
  close?: () => Promise<void>;
}) {
  return {
    callTool: overrides?.callTool ?? mock(() => Promise.resolve({ content: [] })),
    listTools: overrides?.listTools ?? mock(() => Promise.resolve({ tools: [] })),
    close: overrides?.close ?? mock(() => Promise.resolve()),
  };
}

// ── Domain worker links ──

/**
 * A {@link DomainLink} with no thread behind it.
 *
 * Supervision is about lifecycle — handshakes, deaths, backoff, reaping — and
 * none of that needs a real worker to exercise. Spawning one per test would
 * also make the suite's timing a function of machine speed, which is the thing
 * `test/CLAUDE.md` forbids. The real link is covered end-to-end in
 * `domain-worker.spec.ts`.
 */
export interface FakeDomainLink extends DomainLink {
  /** Control messages the daemon has sent, in order. */
  readonly sent: DomainControlMessage[];
  /** JSON-RPC frames the daemon has sent, in order. */
  readonly rpc: unknown[];
  /** Reply to the pending handshake with `ready`. */
  sendReady(overrides?: Partial<DomainReadyMessage>): void;
  /** Reply to the pending handshake with `error`. */
  sendError(message: string): void;
  /** The link died — a crashed worker, a dropped socket. */
  die(reason: string): void;
  readonly isClosed: boolean;
}

export interface FakeDomainLinkOptions {
  /** Answer `init` with `ready` automatically (the happy path). Default true. */
  autoReady?: boolean;
  /** Override fields on the auto-`ready` reply — e.g. a mismatched `domain_id`. */
  readyOverrides?: Partial<DomainReadyMessage>;
}

export function makeFakeDomainLink(domain: DomainSnapshot, options?: FakeDomainLinkOptions): FakeDomainLink {
  const sent: DomainControlMessage[] = [];
  const rpc: unknown[] = [];
  let closed = false;

  const transport = {
    async start(): Promise<void> {},
    async send(message: unknown): Promise<void> {
      rpc.push(message);
    },
    async close(): Promise<void> {
      transport.onclose?.();
    },
    onclose: undefined as (() => void) | undefined,
    onerror: undefined as ((error: Error) => void) | undefined,
    onmessage: undefined as ((message: JSONRPCMessage) => void) | undefined,
  };

  const link: FakeDomainLink = {
    sent,
    rpc,
    transport: transport as unknown as Transport,
    onControl: null,
    onFailure: null,
    postControl(message: DomainControlMessage): void {
      // Wire-check on the fake too: a message that only survives structured
      // clone must fail in tests, not only in production.
      assertWireSafe(message, `domain control message "${message.type}"`);
      sent.push(message);
      if (message.type === "init" && (options?.autoReady ?? true)) {
        queueMicrotask(() => link.sendReady(options?.readyOverrides));
      }
    },
    sendReady(overrides?: Partial<DomainReadyMessage>): void {
      link.onControl?.({
        type: "ready",
        supported_protocol_version: AGENT_PROTOCOL_VERSION,
        domain_id: domain.id,
        ...overrides,
      });
    },
    sendError(message: string): void {
      link.onControl?.({ type: "error", message });
    },
    die(reason: string): void {
      transport.onerror?.(new Error(reason));
      link.onFailure?.(reason);
    },
    async close(): Promise<void> {
      closed = true;
      link.onControl = null;
      link.onFailure = null;
      transport.onclose?.();
    },
    get isClosed(): boolean {
      return closed;
    },
  };
  return link;
}

/** A stub MCP client that connects instantly and records the tools it was asked for. */
export function makeStubDomainClient(overrides?: {
  callTool?: (params: { name: string; arguments?: Record<string, unknown> }) => Promise<unknown>;
  connect?: (transport: Transport) => Promise<void>;
  close?: () => Promise<void>;
}): Client {
  const stub = {
    connect: overrides?.connect ?? (async () => {}),
    close: overrides?.close ?? (async () => {}),
    callTool: overrides?.callTool ?? (async () => ({ content: [] })),
  };
  return stub as unknown as Client;
}
