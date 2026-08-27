import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { LockedAutomation, Manifest, MonitorEvent } from "@mcp-cli/core";
import { NO_DOMAIN_ID } from "@mcp-cli/core";
import { pollUntil } from "../../../test/harness";
import { type AutomationBootstrapDeps, startAutomationDispatchers } from "./automation-bootstrap";
import { WorkItemDb } from "./db/work-items";
import type { DomainRoot } from "./domain-roots";
import { EventBus } from "./event-bus";

/*
 * `/mcx-test/...` for the same reason as automation-dispatcher.spec.ts: a root that
 * resolves to itself on every platform, since these tests never touch the filesystem but
 * the code under test canonicalizes what it is handed.
 */
const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };
const SETTLE_MS = 30;
const HASH = "a".repeat(64);

function root(over: Partial<DomainRoot> & { id: number; path: string }): DomainRoot {
  return { name: `d${over.id}`, fallback: false, ...over };
}

function manifestAt(dir: string): { path: string; manifest: Manifest } {
  return {
    path: `${dir}/.mcx.yaml`,
    manifest: {
      version: 1,
      initial: "impl",
      phases: { impl: { on: {} } },
      automation: { preset: "auto", modules: {} },
    } as unknown as Manifest,
  };
}

function locked(over: Partial<LockedAutomation> = {}): LockedAutomation {
  return {
    name: "cleanup",
    resolvedPath: ".claude/automation/cleanup.ts",
    contentHash: HASH,
    events: ["pr.merged"],
    enabled: true,
    ...over,
  };
}

describe("startAutomationDispatchers", () => {
  let sqlDb: Database;
  let bus: EventBus;
  let workItems: WorkItemDb;
  /** Roots that have a `.mcx.yaml`. */
  let manifests: Set<string>;
  /** Roots that have a `.mcx.lock`, and what is in it. */
  let lockfiles: Map<string, LockedAutomation[]>;
  /** Every event a module actually ran for, across all dispatchers. */
  let fired: MonitorEvent[];

  beforeEach(() => {
    sqlDb = new Database(":memory:");
    workItems = new WorkItemDb(sqlDb);
    bus = new EventBus();
    manifests = new Set();
    lockfiles = new Map();
    fired = [];
  });

  afterEach(() => {
    sqlDb.close();
  });

  function bootstrap(roots: DomainRoot[], over: Partial<AutomationBootstrapDeps> = {}) {
    const registry = startAutomationDispatchers({
      roots,
      eventBus: bus,
      workItems,
      stateDb: { listAliasState: () => ({}) },
      domainIdForPath: () => NO_DOMAIN_ID,
      endSession: async () => {},
      logger: SILENT_LOGGER,
      loadManifest: (dir) => (manifests.has(dir) ? manifestAt(dir) : null),
      readFile: (path) => {
        // Two files are read per root: the lockfile, and the manifest (to hash it). A root
        // with no lockfile throws ENOENT exactly as the real `readFileSync` would.
        for (const [dir, automations] of lockfiles) {
          if (path === `${dir}/.mcx.lock`) {
            return JSON.stringify({ version: 1, manifestHash: HASH, phases: [], automations });
          }
        }
        if (path.endsWith("/.mcx.yaml")) return "manifest-text";
        throw Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
      },
      stateRootFor: (r) => () => r.path,
      ...over,
    });
    return registry;
  }

  /**
   * Bootstrap with a module executor that records every dispatch.
   *
   * `executeModule` is not told which dispatcher called it, so *which* one ran is recovered
   * from the `repoRoot` on the audit event each dispatcher publishes for its own dispatches.
   */
  function bootstrapRecording(roots: DomainRoot[]) {
    const auditEvents: MonitorEvent[] = [];
    bus.subscribe(
      (event) => auditEvents.push(event),
      (event) => event.event.startsWith("automation."),
    );
    const registry = bootstrap(roots, {
      executeModule: async (_mod, event) => {
        fired.push(event);
        return { action: "none", reason: "test" };
      },
    });
    return { registry, auditEvents };
  }

  test("one dispatcher per project root that declares automation", () => {
    manifests.add("/mcx-test/alpha").add("/mcx-test/beta");
    lockfiles.set("/mcx-test/alpha", [locked()]);
    lockfiles.set("/mcx-test/beta", [locked()]);

    const registry = bootstrap([root({ id: 1, path: "/mcx-test/alpha" }), root({ id: 2, path: "/mcx-test/beta" })]);

    expect(registry.size).toBe(2);
    expect(registry.all().map((d) => [d.root, d.domain])).toEqual([
      ["/mcx-test/alpha", 1],
      ["/mcx-test/beta", 2],
    ]);
    registry.stop();
  });

  test("a root with no manifest, or a manifest but no lockfile, gets no dispatcher", () => {
    // The normal state of a directory that is not an mcx project — and of one that is but
    // has never run `mcx phase install`.
    manifests.add("/mcx-test/beta");

    const registry = bootstrap([
      root({ id: 1, path: "/mcx-test/alpha" }), // no manifest
      root({ id: 2, path: "/mcx-test/beta" }), // manifest, no lockfile
    ]);

    expect(registry.size).toBe(0);
    expect(registry.forRoot("/mcx-test/beta")).toBeNull();
  });

  test("each dispatcher takes only its own domain's events", async () => {
    manifests.add("/mcx-test/alpha").add("/mcx-test/beta");
    lockfiles.set("/mcx-test/alpha", [locked()]);
    lockfiles.set("/mcx-test/beta", [locked()]);

    const { registry, auditEvents } = bootstrapRecording([
      root({ id: 1, path: "/mcx-test/alpha" }),
      root({ id: 2, path: "/mcx-test/beta" }),
    ]);

    bus.publish({ src: "test", event: "pr.merged", category: "work_item", domainId: 2, prNumber: 7 });
    await pollUntil(() => fired.length > 0);
    await Bun.sleep(SETTLE_MS);

    expect(fired).toHaveLength(1);
    expect(auditEvents.map((e) => e.repoRoot)).toEqual(["/mcx-test/beta"]);
    registry.stop();
  });

  test("a sole dispatcher still takes events that resolved to no domain", async () => {
    // Otherwise a single-project box loses automation for every event whose domain could
    // not be resolved — which is the behaviour it had before per-project dispatch.
    manifests.add("/mcx-test/alpha");
    lockfiles.set("/mcx-test/alpha", [locked()]);

    const { registry } = bootstrapRecording([root({ id: 1, path: "/mcx-test/alpha" })]);

    bus.publish({ src: "test", event: "pr.merged", category: "work_item", domainId: NO_DOMAIN_ID, prNumber: 7 });
    await pollUntil(() => fired.length > 0);

    expect(fired).toHaveLength(1);
    registry.stop();
  });

  test("with several dispatchers an un-domained event fires none of them", async () => {
    // Fanning it out would run every project's modules on one event; a duplicate
    // `bye-and-untrack` is worse than a missed one.
    manifests.add("/mcx-test/alpha").add("/mcx-test/beta");
    lockfiles.set("/mcx-test/alpha", [locked()]);
    lockfiles.set("/mcx-test/beta", [locked()]);

    const { registry } = bootstrapRecording([
      root({ id: 1, path: "/mcx-test/alpha" }),
      root({ id: 2, path: "/mcx-test/beta" }),
    ]);

    bus.publish({ src: "test", event: "pr.merged", category: "work_item", domainId: NO_DOMAIN_ID, prNumber: 7 });
    await Bun.sleep(SETTLE_MS);

    expect(fired).toEqual([]);
    registry.stop();
  });

  test("the cwd fallback root takes every event, whatever its domain", async () => {
    manifests.add("/mcx-test/cwd");
    lockfiles.set("/mcx-test/cwd", [locked()]);

    const { registry } = bootstrapRecording([root({ id: NO_DOMAIN_ID, path: "/mcx-test/cwd", fallback: true })]);
    expect(registry.all()[0].domain).toBeNull();

    bus.publish({ src: "test", event: "pr.merged", category: "work_item", domainId: 9, prNumber: 7 });
    await pollUntil(() => fired.length > 0);

    expect(fired).toHaveLength(1);
    registry.stop();
  });

  test("a registered domain's work-item lookups read that domain's partition", async () => {
    manifests.add("/mcx-test/beta");
    lockfiles.set("/mcx-test/beta", [locked()]);
    // The same PR number in two domains — the ambiguity `firstOf` had to warn about, and
    // which a scoped dispatcher does not have.
    workItems.forDomain(1).createWorkItem({ id: "pr:7", prNumber: 7 });
    workItems.forDomain(2).createWorkItem({ id: "pr:7", prNumber: 7 });

    const { registry, auditEvents } = bootstrapRecording([root({ id: 2, path: "/mcx-test/beta" })]);

    bus.publish({ src: "test", event: "pr.merged", category: "work_item", domainId: 2, prNumber: 7 });
    await pollUntil(() => auditEvents.length > 0);

    // Resolved through domain 2's partition, so it is domain 2's row and not domain 1's.
    expect(registry.all()[0].getAuditLog()[0]?.workItemId).toBe("d2:pr:7");
    registry.stop();
  });
});

describe("AutomationRegistry.forRoot", () => {
  let sqlDb: Database;
  let workItems: WorkItemDb;

  beforeEach(() => {
    sqlDb = new Database(":memory:");
    workItems = new WorkItemDb(sqlDb);
  });

  afterEach(() => sqlDb.close());

  function build(roots: DomainRoot[]) {
    return startAutomationDispatchers({
      roots,
      eventBus: new EventBus(),
      workItems,
      stateDb: { listAliasState: () => ({}) },
      domainIdForPath: () => NO_DOMAIN_ID,
      endSession: async () => {},
      logger: SILENT_LOGGER,
      loadManifest: (dir) => manifestAt(dir),
      readFile: (path) =>
        path.endsWith(".mcx.lock")
          ? JSON.stringify({ version: 1, manifestHash: HASH, phases: [], automations: [locked()] })
          : "manifest-text",
      stateRootFor: (r) => () => r.path,
      executeModule: async () => ({ action: "none", reason: "test" }),
    });
  }

  test("selects the dispatcher whose root the caller is standing in", () => {
    const registry = build([root({ id: 1, path: "/mcx-test/alpha" }), root({ id: 2, path: "/mcx-test/beta" })]);
    expect(registry.forRoot("/mcx-test/beta")?.domain).toBe(2);
    registry.stop();
  });

  test("an unmatched root with several dispatchers gets nothing, not someone else's log", () => {
    const registry = build([root({ id: 1, path: "/mcx-test/alpha" }), root({ id: 2, path: "/mcx-test/beta" })]);
    expect(registry.forRoot("/mcx-test/gamma")).toBeNull();
    registry.stop();
  });

  test("a sole dispatcher answers any root — a caller in a subdirectory still gets it", () => {
    const registry = build([root({ id: 1, path: "/mcx-test/alpha" })]);
    expect(registry.forRoot("/mcx-test/alpha/packages/core")?.domain).toBe(1);
    expect(registry.forRoot(undefined)?.domain).toBe(1);
    registry.stop();
  });
});
