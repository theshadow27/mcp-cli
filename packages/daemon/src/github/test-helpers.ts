import type { Database } from "bun:sqlite";

/** Minimal StateDb-compatible adapter backed by an in-memory SQLite database. */
export function createCopilotStateDb(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_comment_state (
      pr_number              INTEGER PRIMARY KEY,
      seen_comment_ids       TEXT NOT NULL DEFAULT '[]',
      seen_review_ids        TEXT NOT NULL DEFAULT '[]',
      seen_pr_comment_ids    TEXT NOT NULL DEFAULT '[]',
      seen_issue_comment_ids TEXT NOT NULL DEFAULT '[]',
      last_sticky_body_hash  TEXT,
      last_poll_ts           TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  function getJsonCol(col: string, key: number): number[] {
    const row = db
      .query<Record<string, string>, [number]>(`SELECT ${col} FROM copilot_comment_state WHERE pr_number = ?`)
      .get(key);
    return row ? (JSON.parse(row[col]) as number[]) : [];
  }

  function upsertJsonCol(col: string, key: number, ids: number[]): void {
    db.query(
      `INSERT INTO copilot_comment_state (pr_number, ${col}, last_poll_ts)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(pr_number) DO UPDATE SET
         ${col} = excluded.${col},
         last_poll_ts = excluded.last_poll_ts`,
    ).run(key, JSON.stringify(ids));
  }

  return {
    getSeenCommentIds: (n: number) => getJsonCol("seen_comment_ids", n),
    updateSeenCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_comment_ids", n, ids),
    getSeenReviewIds: (n: number) => getJsonCol("seen_review_ids", n),
    updateSeenReviewIds: (n: number, ids: number[]) => upsertJsonCol("seen_review_ids", n, ids),
    getSeenPRCommentIds: (n: number) => getJsonCol("seen_pr_comment_ids", n),
    updateSeenPRCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_pr_comment_ids", n, ids),
    getSeenIssueCommentIds: (n: number) => getJsonCol("seen_issue_comment_ids", n),
    updateSeenIssueCommentIds: (n: number, ids: number[]) => upsertJsonCol("seen_issue_comment_ids", n, ids),
    getStickyBodyHash(prNumber: number): string | null {
      const row = db
        .query<{ last_sticky_body_hash: string | null }, [number]>(
          "SELECT last_sticky_body_hash FROM copilot_comment_state WHERE pr_number = ?",
        )
        .get(prNumber);
      return row?.last_sticky_body_hash ?? null;
    },
    updateStickyBodyHash(prNumber: number, hash: string | null): void {
      db.query(
        `INSERT INTO copilot_comment_state (pr_number, last_sticky_body_hash, last_poll_ts)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(pr_number) DO UPDATE SET
           last_sticky_body_hash = excluded.last_sticky_body_hash,
           last_poll_ts = excluded.last_poll_ts`,
      ).run(prNumber, hash);
    },
    deleteCopilotCommentState(workItemNumber: number): boolean {
      const result = db.run("DELETE FROM copilot_comment_state WHERE pr_number = ?", [workItemNumber]);
      return result.changes > 0;
    },
  };
}
