/**
 * "Which GitHub repo does this work item's domain live in?" — one answer, shared by both
 * GitHub pollers (#3192).
 *
 * Before this, each poller detected **one** repo from the daemon's startup cwd and queried
 * every tracked PR number against it. That is correct only while every domain is the same
 * repo; on a box serving two projects, one project's PR numbers were looked up in the other
 * project's repo, which resolves to whatever PR happens to carry that number there.
 *
 * The repo is a property of the *domain*, so it is resolved from the domain's registered
 * path and cached per domain. The retry policy (#3243) is unchanged and now lives in one
 * place instead of two copies: detection never gives up permanently, because the reasons it
 * fails — a missing `WorkingDirectory=`, a repo that does not exist yet, a transient `git`
 * hiccup — all resolve without a daemon restart.
 */

import { type Logger, consoleLogger } from "@mcp-cli/core";
import type { RepoInfo } from "./github/graphql-client";

const REPO_DETECT_BACKOFF_BASE_MS = 30_000;
const REPO_DETECT_BACKOFF_MAX_MS = 15 * 60_000;

/** Capped exponential backoff delay for the Nth consecutive repo-detect failure (N ≥ 1). */
export function repoDetectBackoffMs(failureCount: number): number {
  return Math.min(REPO_DETECT_BACKOFF_BASE_MS * 2 ** (failureCount - 1), REPO_DETECT_BACKOFF_MAX_MS);
}

/** What a poller needs from repo resolution. Narrower than the class so tests can hand-roll one. */
export interface DomainRepos {
  /**
   * The repo for `domainId`, detecting it if necessary.
   *
   * Returns null while detection is failing or backing off — the caller skips that domain
   * this cycle and keeps polling the others, rather than losing the whole poll to one
   * misconfigured project.
   */
  repoFor(domainId: number): Promise<RepoInfo | null>;
  /** The already-resolved repo for `domainId`, or null. Never does I/O. */
  cached(domainId: number): RepoInfo | null;
  /** Most recent detection failure, or null when the last attempt for every domain succeeded. */
  readonly lastError: string | null;
}

export interface DomainRepoResolverOptions {
  /**
   * Directory to detect from for a domain id — normally the domain's registered path.
   * Return null for a domain with no local root; detection then falls back to
   * `fallbackRoot`, and to the process cwd if that is unset too.
   */
  rootFor: (domainId: number) => string | null;
  /** Injected for testing; production passes `detectRepo` from the GraphQL client. */
  detectRepo: (cwd?: string) => Promise<RepoInfo>;
  /** Used for `NO_DOMAIN_ID` rows and any domain `rootFor` cannot place. */
  fallbackRoot?: string | null;
  logger?: Logger;
  /** Injected for testing — override Date.now(). */
  now?: () => number;
  /** Prefix for the retry warning, so two pollers' logs stay distinguishable. */
  label?: string;
}

/**
 * Group rows by their domain, so each group can be fetched against its own repo.
 *
 * Insertion-ordered, so a poll cycle visits domains in the order their items came back from
 * the database rather than in a map-hash order that changes between runs.
 */
export function groupByDomain<T extends { domainId: number }>(rows: readonly T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const row of rows) {
    const existing = groups.get(row.domainId);
    if (existing) existing.push(row);
    else groups.set(row.domainId, [row]);
  }
  return groups;
}

/** Per-domain repo detection with capped, never-permanent backoff. */
export class DomainRepoResolver implements DomainRepos {
  private readonly repos = new Map<number, RepoInfo>();
  private readonly failures = new Map<number, number>();
  /** Epoch ms (per `now`) before which detection is skipped for this domain. */
  private readonly nextAttemptMs = new Map<number, number>();
  /** In-flight detections, so a poll cycle with N items in one domain spawns one `git`. */
  private readonly inFlight = new Map<number, Promise<RepoInfo | null>>();
  private readonly logger: Logger;
  private readonly now: () => number;
  private readonly label: string;
  private _lastError: string | null = null;

  constructor(private readonly opts: DomainRepoResolverOptions) {
    this.logger = opts.logger ?? consoleLogger;
    this.now = opts.now ?? (() => Date.now());
    this.label = opts.label ?? "Repo detection";
  }

  get lastError(): string | null {
    return this._lastError;
  }

  cached(domainId: number): RepoInfo | null {
    return this.repos.get(domainId) ?? null;
  }

  async repoFor(domainId: number): Promise<RepoInfo | null> {
    const known = this.repos.get(domainId);
    if (known) return known;

    const pending = this.inFlight.get(domainId);
    if (pending) return pending;

    const nextAttempt = this.nextAttemptMs.get(domainId) ?? 0;
    if (this.now() < nextAttempt) return null;

    const attempt = this.detect(domainId).finally(() => this.inFlight.delete(domainId));
    this.inFlight.set(domainId, attempt);
    return attempt;
  }

  private async detect(domainId: number): Promise<RepoInfo | null> {
    const root = this.opts.rootFor(domainId) ?? this.opts.fallbackRoot ?? undefined;
    try {
      const repo = await this.opts.detectRepo(root);
      this.repos.set(domainId, repo);
      this.failures.delete(domainId);
      this.nextAttemptMs.delete(domainId);
      this._lastError = null;
      return repo;
    } catch (err) {
      const count = (this.failures.get(domainId) ?? 0) + 1;
      this.failures.set(domainId, count);
      const msg = err instanceof Error ? err.message : String(err);
      const delayMs = repoDetectBackoffMs(count);
      this.nextAttemptMs.set(domainId, this.now() + delayMs);
      this._lastError = msg;
      this.logger.warn(
        `[mcpd] ${this.label} failed for domain ${domainId} (cwd=${root ?? "process cwd"}, attempt ${count}): ${msg} — retrying in ${Math.round(delayMs / 1000)}s`,
      );
      return null;
    }
  }
}
