/**
 * One automation dispatcher **per project**, built from the `domains` table (#3192).
 *
 * This used to be a block inside `startDaemon` that called `loadManifest(process.cwd())`
 * once. Automation is inherently per-project — the modules come from a project's `.mcx.yaml`
 * and act on that project's work items — so "the daemon's cwd" answered the wrong question:
 * on a box serving two projects, whichever directory happened to auto-start `mcpd` decided
 * whose automation ran, and the other project's simply never did.
 *
 * Extracted rather than fixed in place because `startDaemon` is not a testable unit and this
 * is the part with the decisions in it: which roots get a dispatcher, which events each one
 * takes, and which partition its work-item lookups read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  LOCKFILE_NAME,
  type LockedAutomation,
  type Logger,
  type Manifest,
  ManifestVersionError,
  NO_DOMAIN_ID,
  type WorkItem,
  type WorkItemPatch,
  loadManifest as loadManifestFromDir,
  parseLockfile,
  pathEq,
  sha256Hex,
  workItemStateNamespace,
} from "@mcp-cli/core";
import { AutomationDispatcher } from "./automation-dispatcher";
import { createAutomationStateRoot } from "./automation-state-root";
import type { McxDb } from "./db/state";
import { type WorkItemDb, firstOf } from "./db/work-items";
import type { DomainRoot } from "./domain-roots";
import type { EventBus } from "./event-bus";

/** The work-item reads and writes a dispatcher needs, already resolved to one partition. */
interface DispatcherWorkItems {
  get(id: string): WorkItem | null;
  byPr(prNumber: number): WorkItem | null;
  byBranch(branch: string): WorkItem | null;
  byIssue(issueNumber: number): WorkItem | null;
  update(id: string, patch: WorkItemPatch): void;
  delete(id: string): void;
}

export interface AutomationBootstrapDeps {
  /** Project roots to run automation for — see `resolveDomainRoots`. */
  roots: readonly DomainRoot[];
  eventBus: EventBus;
  workItems: WorkItemDb;
  mcxDb: Pick<McxDb, "listAliasState">;
  /** Domain id for an `alias_state` root — the daemon's one path→domain resolver. */
  domainIdForPath: (repoRoot: string) => number;
  /** Ends one agent session (`claude_bye`, falling back to closing the DB row). */
  endSession: (sessionId: string, reason: string) => Promise<void>;
  logger: Logger;
  /** Injected for testing. */
  loadManifest?: (dir: string) => { path: string; manifest: Manifest } | null;
  /** Injected for testing. */
  readFile?: (path: string) => string;
  /** Injected for testing — bypasses the lazy `git rev-parse` probe. */
  stateRootFor?: (root: DomainRoot) => () => string;
  /** Injected for testing — production spawns each module in a subprocess. */
  executeModule?: ConstructorParameters<typeof AutomationDispatcher>[0]["executeModule"];
}

/**
 * Every dispatcher this daemon is running, indexed by the project it serves.
 *
 * The IPC surface (`mcx automation ls`, `mcx automation log`) passes the caller's
 * `repoRoot`, which was previously accepted and ignored because there was only one
 * dispatcher to return. With one per project it is what picks the right one.
 */
export class AutomationRegistry {
  /**
   * @param dispatchers the running dispatchers — the roots that *declare* automation.
   * @param rootCount how many project roots the daemon serves in total, automation or not.
   *   Separate from `dispatchers.length` on purpose: see {@link forRoot}.
   */
  constructor(
    private readonly dispatchers: readonly AutomationDispatcher[],
    private readonly rootCount: number = dispatchers.length,
  ) {}

  get size(): number {
    return this.dispatchers.length;
  }

  all(): readonly AutomationDispatcher[] {
    return this.dispatchers;
  }

  /**
   * The dispatcher for `repoRoot`.
   *
   * Falls back to the sole dispatcher on a **single-project box**: a caller in a subdirectory,
   * or one that passed a worktree path, still gets the answer it would have got before
   * per-project dispatch, and a box with one project never has to be exact. Otherwise an
   * unmatched root gets null, because guessing would show one project's audit log under
   * another's name.
   *
   * "Single-project" is `rootCount`, not `dispatchers.length` (#3397 review). A daemon serving
   * three projects of which only one declares automation has one dispatcher and three roots —
   * so a caller standing in either of the other two is a caller whose project runs no
   * automation, and must be told that, not handed the one project's log.
   */
  forRoot(repoRoot: string | undefined): AutomationDispatcher | null {
    if (this.dispatchers.length === 0) return null;
    if (repoRoot !== undefined) {
      const match = this.dispatchers.find((d) => pathEq(d.root, repoRoot));
      if (match) return match;
    }
    return this.rootCount === 1 && this.dispatchers.length === 1 ? this.dispatchers[0] : null;
  }

  stop(): void {
    for (const dispatcher of this.dispatchers) dispatcher.stop();
  }
}

/**
 * Load each root's manifest + lockfile and start a dispatcher for the ones that declare
 * automation. Roots with no manifest, no automation block, or no locked modules are skipped
 * silently — that is the normal state of a directory that is not an mcx project.
 */
export function startAutomationDispatchers(deps: AutomationBootstrapDeps): AutomationRegistry {
  const load = deps.loadManifest ?? loadManifestFromDir;
  const readFile = deps.readFile ?? ((path: string) => readFileSync(path, "utf-8"));
  const logger = deps.logger;
  const dispatchers: AutomationDispatcher[] = [];

  // Resolved up front: whether a dispatcher is the only one decides whether it may act on
  // events that resolved to no domain. See `acceptUndomainedEvents`.
  const configured = deps.roots
    .map((root) => ({ root, loaded: loadAutomationFor(root, load, readFile, logger) }))
    .filter((entry): entry is { root: DomainRoot; loaded: LoadedAutomation } => entry.loaded !== null);

  // A dispatcher may only *accept* un-domained events if its work-item lookups can *see* the
  // un-domained partition — otherwise it takes an event it structurally cannot resolve. The
  // same flag therefore drives both, and is passed to `workItemsFor` alongside the dispatcher.
  const acceptUndomainedEvents = configured.length === 1;

  for (const { root, loaded } of configured) {
    const items = workItemsFor(root, deps.workItems, logger, acceptUndomainedEvents);
    // The `alias_state` key half, resolved lazily and from the *project* root.
    //
    // #3037 tried substituting a domain's registered path here and it was worse than the
    // cwd, because a domain may legally be registered at an ancestor of the repo, and
    // `alias_state` is keyed by the git root every writer resolves. That failure cannot
    // arise on this path: `findManifest` does not walk up, so a root only gets a dispatcher
    // when the manifest sits directly in it — and a directory holding `.mcx.yaml` is the
    // project. `createAutomationStateRoot` still resolves the git root from it rather than
    // keying on the path, so a worktree or subdirectory registration lands on the same key
    // the phase scripts write (#3209 review / #3378).
    const stateRoot = deps.stateRootFor
      ? deps.stateRootFor(root)
      : createAutomationStateRoot({ cwd: () => root.path, logger });

    const dispatcher = new AutomationDispatcher({
      eventBus: deps.eventBus,
      // The *manifest* root, not a state key: `LockedAutomation.resolvedPath` is stored
      // relative to the directory the lockfile was written in (`relative(cwd, abs)` in
      // `mcx phase install`), so module paths must resolve against that same directory.
      // `automationStateRoot` below is the `alias_state` half, and is deliberately separate
      // — a git-root remap of one is not a remap of the other (#3209 review / #3378).
      repoRoot: root.path,
      domainId: root.fallback ? null : root.id,
      acceptUndomainedEvents,
      ...(deps.executeModule ? { executeModule: deps.executeModule } : {}),
      getWorkItemOverrides: (workItemId) => items.get(workItemId)?.automationOverrides ?? undefined,
      resolveWorkItemId: (prNumber) => items.byPr(prNumber)?.id,
      getWorkItemByBranch: (branch) => items.byBranch(branch),
      getWorkItemByIssue: (issueNumber) => items.byIssue(issueNumber),
      updateWorkItem: (id, patch) => items.update(id, patch as WorkItemPatch),
      getWorkItem: (workItemId) => {
        const item = items.get(workItemId);
        if (!item) return null;
        return {
          id: item.id,
          domainId: item.domainId,
          issueNumber: item.issueNumber,
          prNumber: item.prNumber,
          branch: item.branch,
          phase: item.phase,
        };
      },
      getWorkItemState: (workItemId) => {
        // Automation state lives in alias_state under `workitem:<id>` — the same rows
        // `ctx.state` writes from a phase script, so it must be read from the same
        // partition or a module would see an empty snapshot for a work item whose phase
        // script had just written to it (#3040). `workItemId` here is always the canonical
        // id straight off a DB row, never a caller-typed spelling, so
        // `workItemStateNamespace` is safe to use directly (#3037).
        const path = stateRoot();
        return deps.mcxDb.listAliasState(path, workItemStateNamespace(workItemId), deps.domainIdForPath(path));
      },
      actionExecutor: {
        async byeAndUntrack(workItemId, sessionIds) {
          const results = await Promise.allSettled(
            sessionIds.map((sid) => deps.endSession(sid, "automation cleanup: PR merged")),
          );
          for (let i = 0; i < results.length; i++) {
            if (results[i].status === "rejected") {
              logger.warn(`[automation] failed to end session ${sessionIds[i]}`);
            }
          }
          if (!items.get(workItemId)) return;
          try {
            items.update(workItemId, { phase: "done" });
          } catch {
            logger.warn(`[automation] failed to set phase=done on ${workItemId}`);
          }
          try {
            items.delete(workItemId);
          } catch {
            logger.warn(`[automation] failed to untrack ${workItemId}`);
          }
        },
      },
    });

    dispatcher.load(loaded.automation, loaded.locked);
    dispatcher.start();
    dispatchers.push(dispatcher);
    logger.info(
      `[mcpd] Automation dispatcher started for ${root.fallback ? "the daemon's cwd" : `domain ${root.name} (${root.id})`} at ${root.path} — ${loaded.locked.length} module(s), preset: ${loaded.automation.preset ?? "supervised"}`,
    );
  }

  if (dispatchers.length === 0) {
    logger.info(
      `[mcpd] No automation configured (${deps.roots.length} project root(s) checked) — no dispatcher started`,
    );
  }
  return new AutomationRegistry(dispatchers, deps.roots.length);
}

interface LoadedAutomation {
  automation: NonNullable<Manifest["automation"]>;
  locked: LockedAutomation[];
}

/** Read one root's manifest + lockfile, or null when that root declares no automation. */
function loadAutomationFor(
  root: DomainRoot,
  load: (dir: string) => { path: string; manifest: Manifest } | null,
  readFile: (path: string) => string,
  logger: Logger,
): LoadedAutomation | null {
  let manifestResult: { path: string; manifest: Manifest } | null = null;
  try {
    manifestResult = load(root.path);
  } catch (err) {
    if (err instanceof ManifestVersionError) {
      logger.warn(`[mcpd] ${err.message}`);
    } else {
      logger.warn(`[mcpd] Failed to load manifest for automation at ${root.path}: ${err} — skipping`);
    }
    return null;
  }
  const automation = manifestResult?.manifest?.automation;
  if (!manifestResult || !automation) return null;

  const lockfilePath = join(root.path, LOCKFILE_NAME);
  let locked: LockedAutomation[] = [];
  try {
    const lock = parseLockfile(readFile(lockfilePath));
    const currentManifestHash = sha256Hex(readFile(manifestResult.path));
    if (lock.manifestHash !== currentManifestHash) {
      logger.warn(
        `[mcpd] Lockfile manifest hash mismatch at ${root.path} (locked: ${lock.manifestHash.slice(0, 8)}… vs current: ${currentManifestHash.slice(0, 8)}…) — run \`mcx phase install\``,
      );
    }
    locked = lock.automations ?? [];
  } catch (err) {
    const isEnoent = err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent) {
      logger.warn(`[mcpd] Automation configured at ${root.path} but no lockfile found — run \`mcx phase install\``);
    } else {
      logger.warn(
        `[mcpd] Automation configured at ${root.path} but lockfile is corrupt: ${err instanceof Error ? err.message : String(err)} — run \`mcx phase install\``,
      );
    }
  }
  if (locked.length === 0) return null;
  return { automation, locked };
}

/**
 * The partition a dispatcher's work-item lookups read.
 *
 * A registered domain reads **its own** partition: a PR/branch/issue number is unique per
 * domain, so scoping is what makes the lookup single-valued instead of ambiguous.
 *
 * Two cases legitimately read wider than one domain, and they are exactly the two cases where
 * the dispatcher also *accepts* events that resolved to no domain — the alignment is the point
 * (#3397 review). A dispatcher that accepts an un-domained event but cannot look one up finds
 * nothing (a silent no-op, strictly worse than the pre-#3192 global dispatcher) or, worse,
 * finds a same-numbered row of its own and acts on it:
 *
 * - **The cwd fallback** has no domain to be scoped to at all, so it keeps the ring-0
 *   cross-domain read and disambiguates with `firstOf` — the pre-#3192 behaviour, for the box
 *   where nothing is registered.
 * - **A sole registered dispatcher** reads its own partition *unioned with* the un-domained
 *   one, because that is the set of rows an un-domained event can honestly be about on a box
 *   with one project: its own, plus rows that predate domain assignment (`domain_id = 0`).
 *   Its own domain wins a tie, and `firstOf` warns; another *registered* domain's rows stay
 *   invisible to it, as they are to any scoped dispatcher.
 */
function workItemsFor(
  root: DomainRoot,
  db: WorkItemDb,
  logger: Logger,
  acceptsUndomainedEvents: boolean,
): DispatcherWorkItems {
  const registered = !root.fallback && root.id !== NO_DOMAIN_ID;

  if (registered && !acceptsUndomainedEvents) {
    const scoped = db.forDomain(root.id);
    return {
      get: (id) => scoped.getWorkItem(id),
      byPr: (prNumber) => scoped.getWorkItemByPr(prNumber),
      byBranch: (branch) => scoped.getWorkItemByBranch(branch),
      byIssue: (issueNumber) => scoped.getWorkItemByIssue(issueNumber),
      update: (id, patch) => {
        scoped.updateWorkItem(id, patch);
      },
      delete: (id) => {
        scoped.deleteWorkItem(id);
      },
    };
  }

  // null = the fallback's "every domain"; a number = "my domain, plus the un-domained rows".
  const ownDomainId = registered ? root.id : null;
  const cross = db.acrossDomains();

  const visible = (item: Pick<WorkItem, "domainId">): boolean =>
    ownDomainId === null || item.domainId === ownDomainId || item.domainId === NO_DOMAIN_ID;

  const rank = (item: Pick<WorkItem, "domainId">): number => (item.domainId === ownDomainId ? 0 : 1);

  /** Visible matches, this dispatcher's own domain first; `firstOf` warns if several remain. */
  const pick = (matches: WorkItem[], label: string): WorkItem | null => {
    const inScope = matches.filter(visible);
    const ordered = ownDomainId === null ? inScope : inScope.sort((a, b) => rank(a) - rank(b));
    return firstOf(ordered, label, logger.warn);
  };

  const writeRow = (id: string, apply: (item: WorkItem) => void): void => {
    const item = cross.getWorkItem(id);
    if (!item || !visible(item)) return;
    apply(item);
  };
  return {
    // `id` is the global primary key, so this is unambiguous — but still gated on visibility,
    // because a scoped dispatcher must not act on an id belonging to another project just
    // because an event carried one (`resolveWorkItemIdFromEvent` takes `event.workItemId` raw).
    get: (id) => {
      const item = cross.getWorkItem(id);
      return item && visible(item) ? item : null;
    },
    byPr: (prNumber) => pick(cross.findByPr(prNumber), `PR #${prNumber}`),
    byBranch: (branch) => pick(cross.findByBranch(branch), `branch ${branch}`),
    byIssue: (issueNumber) => pick(cross.findByIssue(issueNumber), `issue #${issueNumber}`),
    update: (id, patch) => {
      // Write into the row's OWN partition, not a partition the daemon guessed.
      writeRow(id, (item) => cross.forRow(item).updateWorkItem(id, patch));
    },
    delete: (id) => {
      writeRow(id, (item) => cross.forRow(item).deleteWorkItem(id));
    },
  };
}
