import type { Database } from "bun:sqlite";

/**
 * Minimal McxDb-compatible adapter backed by an in-memory SQLite database.
 *
 * Partitioned by `domain_id` like the real table: the repo-poll cursor is per domain
 * because the fetch it paces is per repo (#3192), and a `pr_number`-only primary key made
 * two domains' cursors the same row.
 */
export function createCopilotMcxDb(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_comment_state (
      domain_id              INTEGER NOT NULL DEFAULT 0,
      pr_number              INTEGER NOT NULL,
      seen_comment_ids       TEXT NOT NULL DEFAULT '[]',
      seen_review_ids        TEXT NOT NULL DEFAULT '[]',
      seen_pr_comment_ids    TEXT NOT NULL DEFAULT '[]',
      seen_issue_comment_ids TEXT NOT NULL DEFAULT '[]',
      last_sticky_body_hash  TEXT,
      last_poll_ts           TEXT NOT NULL DEFAULT (datetime('now')),
      repo_poll_ts           TEXT,
      PRIMARY KEY (domain_id, pr_number)
    )
  `);

  function getJsonCol(col: string, key: number, domainId: number): number[] {
    const row = db
      .query<Record<string, string>, [number, number]>(
        `SELECT ${col} FROM copilot_comment_state WHERE domain_id = ? AND pr_number = ?`,
      )
      .get(domainId, key);
    return row ? (JSON.parse(row[col]) as number[]) : [];
  }

  function upsertJsonCol(col: string, key: number, ids: number[], domainId: number): void {
    db.query(
      `INSERT INTO copilot_comment_state (domain_id, pr_number, ${col}, last_poll_ts)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(domain_id, pr_number) DO UPDATE SET
         ${col} = excluded.${col},
         last_poll_ts = excluded.last_poll_ts`,
    ).run(domainId, key, JSON.stringify(ids));
  }

  return {
    getSeenCommentIds: (n: number, domainId = 0) => getJsonCol("seen_comment_ids", n, domainId),
    updateSeenCommentIds: (n: number, ids: number[], domainId = 0) =>
      upsertJsonCol("seen_comment_ids", n, ids, domainId),
    getSeenReviewIds: (n: number, domainId = 0) => getJsonCol("seen_review_ids", n, domainId),
    updateSeenReviewIds: (n: number, ids: number[], domainId = 0) => upsertJsonCol("seen_review_ids", n, ids, domainId),
    getSeenPRCommentIds: (n: number, domainId = 0) => getJsonCol("seen_pr_comment_ids", n, domainId),
    updateSeenPRCommentIds: (n: number, ids: number[], domainId = 0) =>
      upsertJsonCol("seen_pr_comment_ids", n, ids, domainId),
    getSeenIssueCommentIds: (n: number, domainId = 0) => getJsonCol("seen_issue_comment_ids", n, domainId),
    updateSeenIssueCommentIds: (n: number, ids: number[], domainId = 0) =>
      upsertJsonCol("seen_issue_comment_ids", n, ids, domainId),
    getStickyBodyHash(prNumber: number, domainId = 0): string | null {
      const row = db
        .query<{ last_sticky_body_hash: string | null }, [number, number]>(
          "SELECT last_sticky_body_hash FROM copilot_comment_state WHERE domain_id = ? AND pr_number = ?",
        )
        .get(domainId, prNumber);
      return row?.last_sticky_body_hash ?? null;
    },
    updateStickyBodyHash(prNumber: number, hash: string | null, domainId = 0): void {
      db.query(
        `INSERT INTO copilot_comment_state (domain_id, pr_number, last_sticky_body_hash, last_poll_ts)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(domain_id, pr_number) DO UPDATE SET
           last_sticky_body_hash = excluded.last_sticky_body_hash,
           last_poll_ts = excluded.last_poll_ts`,
      ).run(domainId, prNumber, hash);
    },
    deleteCopilotCommentState(workItemNumber: number, domainId = 0): boolean {
      const result = db.run("DELETE FROM copilot_comment_state WHERE domain_id = ? AND pr_number = ?", [
        domainId,
        workItemNumber,
      ]);
      return result.changes > 0;
    },
    getLastRepoPollTs(domainId = 0): string | null {
      const row = db
        .query<{ repo_poll_ts: string | null }, [number]>(
          "SELECT repo_poll_ts FROM copilot_comment_state WHERE domain_id = ? AND pr_number = 0",
        )
        .get(domainId);
      return row?.repo_poll_ts ?? null;
    },
    updateLastRepoPollTs(isoTs: string, domainId = 0): void {
      db.query(
        `INSERT INTO copilot_comment_state (domain_id, pr_number, repo_poll_ts)
         VALUES (?, 0, ?)
         ON CONFLICT(domain_id, pr_number) DO UPDATE SET
           repo_poll_ts = excluded.repo_poll_ts`,
      ).run(domainId, isoTs);
    },
  };
}
