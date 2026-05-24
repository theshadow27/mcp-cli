/**
 * Export transaction — stages parsed fast-import commits, applies them
 * sequentially to a RemoteProvider, and returns per-ref ok/error status.
 *
 * Solves #1312: on partial failure, git refs are only advanced for
 * operations that succeeded. Refs whose operations failed (or were never
 * attempted) get error lines, so `git push` reports accurate per-ref
 * status and the next push re-attempts only what failed.
 *
 * NOT atomic: providers are remote REST APIs that don't support
 * multi-mutation rollback. Successful mutations persist even when later
 * operations fail. The invariant is ref-consistency: a ref is reported
 * "ok" only if ALL its provider mutations succeeded.
 */

import type { PushResult, RemoteProvider, ResolvedScope } from "../providers/provider";
import type { ParsedChange, ParsedCommit } from "./fast-import-parser";
import { parseFastImport } from "./fast-import-parser";
import { stripFrontmatter } from "./frontmatter";

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
  | {
      type: "modify";
      path: string;
      id: string;
      content: string;
      baseVersion: number;
      ref: string;
      frontmatter: Record<string, unknown> | null;
    }
  | { type: "create"; path: string; title: string; content: string; parentId?: string; ref: string }
  | { type: "delete"; path: string; id: string; ref: string };

/**
 * Stages commits parsed from a fast-import stream and applies them
 * sequentially to a RemoteProvider, returning per-ref ok/error status.
 *
 * Usage:
 *   const tx = new ExportTransaction(opts);
 *   tx.stage(commits);
 *   const result = await tx.commit();
 *   // or: tx.rollback();
 */
export class ExportTransaction {
  private readonly opts: ExportTransactionOptions;
  private readonly staged: StagedOp[] = [];
  private readonly refSet = new Set<string>();
  /** Tracks version updates from successful pushes/creates within this tx. */
  private readonly versionOverrides = new Map<string, { id: string; version: number }>();
  /** Tracks paths staged as creates (index into this.staged) so later ops coalesce. */
  private readonly pendingCreates = new Map<string, number>();
  /** Indices of staged ops that were coalesced away (create+delete same path). */
  private readonly removedIndices = new Set<number>();
  private committed = false;
  private rolledBack = false;
  private hasStageErrors = false;
  /** Refs that saw `deleteall` — external path resolution is bypassed only for these refs. */
  private readonly treeClearedRefs = new Set<string>();

  constructor(opts: ExportTransactionOptions) {
    this.opts = opts;
  }

  /** Stage parsed commits. Returns validation errors (if any). */
  stage(commits: ParsedCommit[]): RefStatus[] {
    if (this.committed) throw new Error("ExportTransaction already committed");
    if (this.rolledBack) throw new Error("ExportTransaction already rolled back");

    const errors: RefStatus[] = [];

    for (const commit of commits) {
      this.refSet.add(commit.ref);

      for (const change of commit.changes) {
        const result = this.stageChange(change, commit.ref);
        if (result) {
          errors.push(result);
          this.hasStageErrors = true;
        }
      }
    }

    return errors;
  }

  private resolvePath(path: string, ref: string): { id: string; version: number } | undefined {
    if (this.treeClearedRefs.has(ref)) return this.versionOverrides.get(path);
    return this.versionOverrides.get(path) ?? this.opts.resolvePath(path);
  }

  private stageChange(change: ParsedChange, ref: string): RefStatus | undefined {
    const { provider } = this.opts;

    if (change.type === "deleteall") {
      this.treeClearedRefs.add(ref);
      for (const [path, idx] of this.pendingCreates) {
        if (this.staged[idx].ref === ref) {
          this.removedIndices.add(idx);
          this.pendingCreates.delete(path);
        }
      }
      return undefined;
    }

    if (change.type === "delete") {
      const pendingIdx = this.pendingCreates.get(change.path);
      if (pendingIdx != null) {
        this.removedIndices.add(pendingIdx);
        this.pendingCreates.delete(change.path);
        return undefined;
      }
      if (!provider.delete) {
        return { ref, ok: false, error: "provider does not support delete" };
      }
      const entry = this.resolvePath(change.path, ref);
      if (!entry) {
        return { ref, ok: false, error: `cannot delete unknown path: ${change.path}` };
      }
      this.staged.push({ type: "delete", path: change.path, id: entry.id, ref });
      return undefined;
    }

    // type === "modify"
    if (change.content === undefined) {
      return { ref, ok: false, error: `no content for path: ${change.path}` };
    }

    const decoded = new TextDecoder().decode(change.content);
    const { content: body, fields } = stripFrontmatter(decoded);

    // Coalesce with a pending create for the same path (same ref only)
    const pendingIdx = this.pendingCreates.get(change.path);
    if (pendingIdx != null && this.staged[pendingIdx].ref === ref) {
      const pending = this.staged[pendingIdx] as StagedOp & { type: "create" };
      pending.content = body;
      return undefined;
    }

    const entry = this.resolvePath(change.path, ref);
    if (entry) {
      if (!provider.push) {
        return { ref, ok: false, error: "provider does not support push" };
      }
      this.staged.push({
        type: "modify",
        path: change.path,
        id: entry.id,
        content: body,
        baseVersion: entry.version,
        ref,
        frontmatter: fields,
      });
    } else {
      if (!provider.create) {
        return { ref, ok: false, error: "provider does not support create" };
      }
      const title = titleFromPath(change.path);
      this.pendingCreates.set(change.path, this.staged.length);
      this.staged.push({ type: "create", path: change.path, title, content: body, ref });
    }

    return undefined;
  }

  /** Number of staged operations (excludes coalesced-away ops). */
  get size(): number {
    return this.staged.length - this.removedIndices.size;
  }

  /** All refs touched by staged commits. */
  get refs(): string[] {
    return [...this.refSet];
  }

  /**
   * Apply all staged operations sequentially.
   *
   * Pre-validates content against the provider. If any validation fails,
   * no operations are applied. On an apply-time error, the transaction
   * halts: refs whose operations all succeeded are reported "ok", the
   * failed ref gets the error, and remaining refs are "aborted".
   */
  async commit(): Promise<ExportTransactionResult> {
    if (this.committed) throw new Error("ExportTransaction already committed");
    if (this.rolledBack) throw new Error("ExportTransaction already rolled back");
    if (this.hasStageErrors) throw new Error("ExportTransaction has unresolved stage errors");
    this.committed = true;

    const ops = this.staged.filter((_, i) => !this.removedIndices.has(i));

    if (ops.length === 0) {
      const ok = this.buildAllOk();
      return { refs: ok, response: this.formatResponse(ok) };
    }

    const preErrors = this.preValidate(ops);
    if (preErrors.length > 0) {
      const refs = this.buildRefStatuses(preErrors, 0, ops);
      return { refs, response: this.formatResponse(refs) };
    }

    let appliedCount = 0;
    const errors: Array<{ ref: string; error: string }> = [];

    for (const op of ops) {
      const result = await this.applyOp(op);
      if (result) {
        errors.push({ ref: op.ref, error: result });
        break;
      }
      appliedCount++;
    }

    if (errors.length > 0) {
      const refs = this.buildRefStatuses(errors, appliedCount, ops);
      return { refs, response: this.formatResponse(refs) };
    }

    const ok = this.buildAllOk();
    return { refs: ok, response: this.formatResponse(ok) };
  }

  /** Discard all staged operations without applying. */
  rollback(): void {
    if (this.committed) throw new Error("ExportTransaction already committed");
    this.rolledBack = true;
    this.staged.length = 0;
  }

  private preValidate(ops: StagedOp[]): Array<{ ref: string; error: string }> {
    const errors: Array<{ ref: string; error: string }> = [];
    const { provider } = this.opts;

    if (!provider.validate) return errors;

    for (const op of ops) {
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
          const content = provider.toRemote?.(op.content) ?? op.content;
          const currentVersion = this.versionOverrides.get(op.path)?.version ?? op.baseVersion;
          const result: PushResult = await provider.push(
            scope,
            op.id,
            content,
            currentVersion,
            op.frontmatter ?? undefined,
          );
          if (!result.ok) return result.error ?? "push failed";
          if (result.newVersion != null) {
            this.versionOverrides.set(op.path, { id: op.id, version: result.newVersion });
          }
          return undefined;
        }
        case "create": {
          if (!provider.create) return "provider does not support create";
          const content = provider.toRemote?.(op.content) ?? op.content;
          const entry = await provider.create(scope, op.parentId, op.title, content);
          this.versionOverrides.set(op.path, { id: entry.id, version: entry.version });
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

  private buildAllOk(): RefStatus[] {
    return [...this.refSet].map((ref) => ({ ref, ok: true }));
  }

  private buildRefStatuses(
    errors: Array<{ ref: string; error: string }>,
    appliedCount: number,
    ops: StagedOp[],
  ): RefStatus[] {
    const errorsByRef = new Map<string, string>();
    for (const { ref, error } of errors) {
      if (!errorsByRef.has(ref)) errorsByRef.set(ref, error);
    }

    const refOpIndices = new Map<string, number[]>();
    for (let i = 0; i < ops.length; i++) {
      const ref = ops[i].ref;
      const existing = refOpIndices.get(ref);
      if (existing) {
        existing.push(i);
      } else {
        refOpIndices.set(ref, [i]);
      }
    }

    const completedRefs = new Set<string>();
    for (const [ref, indices] of refOpIndices) {
      if (!errorsByRef.has(ref) && indices.every((i) => i < appliedCount)) {
        completedRefs.add(ref);
      }
    }

    return [...this.refSet].map((ref) => {
      if (completedRefs.has(ref)) return { ref, ok: true };
      const error = errorsByRef.get(ref);
      if (error) return { ref, ok: false, error };
      return { ref, ok: false, error: "aborted: earlier operation failed" };
    });
  }

  /** Format per-ref status into the git remote helper protocol response. */
  private formatResponse(refs: RefStatus[]): string {
    if (refs.length === 0) return "\n";
    const lines = refs.map((r) =>
      r.ok ? `ok ${r.ref}` : `error ${r.ref} ${sanitizeProtocolError(r.error ?? "unknown")}`,
    );
    return `${lines.join("\n")}\n\n`;
  }
}

function sanitizeProtocolError(msg: string): string {
  return msg.replace(/[\r\n]+/g, " ").trim();
}

function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/, "");
}

/**
 * Create a handleExport function suitable for RemoteHelperHandlers.
 *
 * Reads the full fast-import stream, parses it, stages all commits into
 * an ExportTransaction, and applies them to the provider.
 */
export function createExportHandler(
  opts: ExportTransactionOptions,
): (stdin: ReadableStream<Uint8Array>) => Promise<string> {
  return async (stdin: ReadableStream<Uint8Array>): Promise<string> => {
    const chunks: Uint8Array[] = [];
    const reader = stdin.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }

    const raw = concatUint8Arrays(chunks);
    const commits = parseFastImport(raw);

    const tx = new ExportTransaction(opts);
    const stageErrors = tx.stage(commits);
    if (stageErrors.length > 0) {
      tx.rollback();
      const seen = new Set<string>();
      const lines: string[] = [];
      for (const s of stageErrors) {
        if (seen.has(s.ref)) continue;
        seen.add(s.ref);
        lines.push(`error ${s.ref} ${sanitizeProtocolError(s.error ?? "staging failed")}`);
      }
      return `${lines.join("\n")}\n\n`;
    }

    const result = await tx.commit();
    return result.response;
  };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  if (arrays.length === 1) return arrays[0];
  const total = arrays.reduce((sum, a) => sum + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
