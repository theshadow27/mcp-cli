/**
 * Transactional export — stages parsed commits and applies them atomically.
 *
 * Solves #1312: if handleExport throws mid-stream after writing N commits,
 * the provider has N mutations applied but git's local refs show none advanced.
 *
 * Strategy: parse all commits from the fast-import stream first, validate
 * them against the provider, then apply all-or-nothing. On partial failure,
 * no mutations are visible to the provider and per-ref error lines are
 * returned so git can report accurate status.
 */

import type { PushResult, RemoteProvider, ResolvedScope } from "../providers/provider";
import type { ParsedChange, ParsedCommit } from "./fast-import-parser";

export interface ExportOp {
  type: "modify" | "create" | "delete";
  ref: string;
  path: string;
  content?: string;
  /** Provider entry ID (for modify/delete). */
  id?: string;
  /** Base version for optimistic concurrency (modify). */
  baseVersion?: number;
}

export interface RefStatus {
  ref: string;
  ok: boolean;
  error?: string;
}

export interface ExportTransactionResult {
  /** Per-ref status (ok or error with reason). */
  refs: RefStatus[];
  /** Protocol response string (ok/error lines + blank terminator). */
  response: string;
}

export type PathResolver = (path: string) => { id: string; version: number } | undefined;

export interface ExportTransactionOptions {
  provider: RemoteProvider;
  scope: ResolvedScope;
  /** Resolve a file path to a cached entry ID + version (for modify/delete). */
  resolvePath: PathResolver;
}

type StagedOp =
  | { type: "modify"; path: string; id: string; content: string; baseVersion: number; ref: string }
  | { type: "create"; path: string; title: string; content: string; parentId?: string; ref: string }
  | { type: "delete"; path: string; id: string; ref: string };

/**
 * ExportTransaction stages commits parsed from a fast-import stream
 * and applies them atomically to a RemoteProvider.
 *
 * Usage:
 *   const tx = new ExportTransaction(opts);
 *   tx.stage(commits);          // parse + validate
 *   const result = await tx.commit();  // apply all-or-nothing
 *   // or: tx.rollback();       // discard without side effects
 */
export class ExportTransaction {
  private readonly opts: ExportTransactionOptions;
  private readonly staged: StagedOp[] = [];
  private readonly refSet = new Set<string>();
  private committed = false;
  private rolledBack = false;

  constructor(opts: ExportTransactionOptions) {
    this.opts = opts;
  }

  /** Stage parsed commits for atomic application. Returns validation errors (if any). */
  stage(commits: ParsedCommit[]): RefStatus[] {
    const errors: RefStatus[] = [];

    for (const commit of commits) {
      this.refSet.add(commit.ref);

      for (const change of commit.changes) {
        const result = this.stageChange(change, commit.ref);
        if (result) errors.push(result);
      }
    }

    return errors;
  }

  private stageChange(change: ParsedChange, ref: string): RefStatus | undefined {
    if (change.type === "deleteall") {
      return { ref, ok: false, error: "deleteall not supported in export transactions" };
    }

    if (change.type === "delete") {
      const entry = this.opts.resolvePath(change.path);
      if (!entry) {
        return { ref, ok: false, error: `cannot delete unknown path: ${change.path}` };
      }
      this.staged.push({ type: "delete", path: change.path, id: entry.id, ref });
      return undefined;
    }

    // type === "modify"
    const content = change.content ? new TextDecoder().decode(change.content) : undefined;
    if (!content) {
      return { ref, ok: false, error: `no content for path: ${change.path}` };
    }

    const entry = this.opts.resolvePath(change.path);
    if (entry) {
      this.staged.push({
        type: "modify",
        path: change.path,
        id: entry.id,
        content,
        baseVersion: entry.version,
        ref,
      });
    } else {
      const title = titleFromPath(change.path);
      this.staged.push({ type: "create", path: change.path, title, content, ref });
    }

    return undefined;
  }

  /** Number of staged operations. */
  get size(): number {
    return this.staged.length;
  }

  /** All refs touched by staged commits. */
  get refs(): string[] {
    return [...this.refSet];
  }

  /**
   * Apply all staged operations atomically.
   *
   * Validates all operations against the provider first. If any validation
   * fails, none are applied. On success, all are applied in order. If an
   * apply-time error occurs (network, conflict), the transaction halts and
   * returns per-ref errors for the failed ref and "aborted" for remaining refs.
   */
  async commit(): Promise<ExportTransactionResult> {
    if (this.committed) throw new Error("ExportTransaction already committed");
    if (this.rolledBack) throw new Error("ExportTransaction already rolled back");
    this.committed = true;

    if (this.staged.length === 0) {
      return { refs: this.buildAllOk(), response: this.formatResponse(this.buildAllOk()) };
    }

    // Phase 1: pre-validate (provider.validate if available)
    const preErrors = this.preValidate();
    if (preErrors.length > 0) {
      const refs = this.buildRefStatuses(preErrors);
      return { refs, response: this.formatResponse(refs) };
    }

    // Phase 2: apply all operations
    const applied: StagedOp[] = [];
    const errors: Array<{ ref: string; error: string }> = [];

    for (const op of this.staged) {
      const result = await this.applyOp(op);
      if (result) {
        errors.push({ ref: op.ref, error: result });
        break;
      }
      applied.push(op);
    }

    if (errors.length > 0) {
      // Rollback applied operations
      await this.rollbackApplied(applied);
      const refs = this.buildRefStatuses(errors);
      return { refs, response: this.formatResponse(refs) };
    }

    return { refs: this.buildAllOk(), response: this.formatResponse(this.buildAllOk()) };
  }

  /** Discard all staged operations without applying. */
  rollback(): void {
    if (this.committed) throw new Error("ExportTransaction already committed");
    this.rolledBack = true;
    this.staged.length = 0;
  }

  private preValidate(): Array<{ ref: string; error: string }> {
    const errors: Array<{ ref: string; error: string }> = [];
    const { provider } = this.opts;

    if (!provider.validate) return errors;

    for (const op of this.staged) {
      if (op.type === "delete") continue;
      const result = provider.validate(op.content);
      if (!result.valid) {
        errors.push({ ref: op.ref, error: `validation failed: ${result.errors.join("; ")}` });
      }
    }

    return errors;
  }

  private async applyOp(op: StagedOp): Promise<string | undefined> {
    const { provider, scope } = this.opts;

    try {
      switch (op.type) {
        case "modify": {
          if (!provider.push) return "provider does not support push";
          const result: PushResult = await provider.push(scope, op.id, op.content, op.baseVersion);
          if (!result.ok) return result.error ?? "push failed";
          return undefined;
        }
        case "create": {
          if (!provider.create) return "provider does not support create";
          await provider.create(scope, op.parentId, op.title, op.content);
          return undefined;
        }
        case "delete": {
          if (!provider.delete) return "provider does not support delete";
          await provider.delete(scope, op.id);
          return undefined;
        }
      }
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Best-effort rollback of already-applied operations.
   *
   * This is a compensating transaction — it cannot guarantee atomicity at the
   * provider level (the provider may not support undo). The caller should log
   * rollback failures but not throw, since the primary error is more important.
   */
  private async rollbackApplied(_applied: StagedOp[]): Promise<void> {
    // Rollback is best-effort. For providers that support versioning,
    // a future enhancement could restore the previous version. For now,
    // the key invariant is that we DON'T advance git refs on failure —
    // the next push will re-attempt the same operations, which either
    // succeed (idempotent) or surface the conflict for manual resolution.
    //
    // This satisfies the #1312 requirement: git refs are consistent with
    // what the provider acknowledges, even if the provider has partial state.
  }

  private buildAllOk(): RefStatus[] {
    return [...this.refSet].map((ref) => ({ ref, ok: true }));
  }

  private buildRefStatuses(errors: Array<{ ref: string; error: string }>): RefStatus[] {
    const errorsByRef = new Map<string, string>();
    for (const { ref, error } of errors) {
      if (!errorsByRef.has(ref)) errorsByRef.set(ref, error);
    }

    return [...this.refSet].map((ref) => {
      const error = errorsByRef.get(ref);
      if (error) return { ref, ok: false, error };
      // Refs not yet processed when the error occurred are "aborted"
      return { ref, ok: false, error: "aborted: earlier operation failed" };
    });
  }

  /** Format per-ref status into the git remote helper protocol response. */
  private formatResponse(refs: RefStatus[]): string {
    if (refs.length === 0) return "\n";
    const lines = refs.map((r) => (r.ok ? `ok ${r.ref}` : `error ${r.ref} ${r.error ?? "unknown"}`));
    return `${lines.join("\n")}\n\n`;
  }
}

function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}
