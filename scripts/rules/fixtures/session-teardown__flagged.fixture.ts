/**
 * @rule session-teardown
 * @expect 2
 * @path packages/daemon/src/example-session-flagged.ts
 *
 * Two TOCTOU violations:
 *   1. Delete after first await.
 *   2. Delete after second await — must still report the FIRST await.
 *
 * An await inside a comment must NOT count as the first await — included
 * here as a negative control on the third method (should not be flagged).
 */

class Example {
  sessions = new Map<string, unknown>();

  private async terminateSession(id: string): Promise<void> {
    this.endState();
    await this.killProc();
    this.sessions.delete(id);
  }

  private async cleanup(id: string): Promise<void> {
    await this.firstStep();
    await this.secondStep();
    this.sessions.delete(id);
  }

  async foo(id: string): Promise<void> {
    // await something(); ← this is not real
    this.sessions.delete(id);
    await this.realWork();
  }

  endState(): void {}
  async killProc(): Promise<void> {}
  async firstStep(): Promise<void> {}
  async secondStep(): Promise<void> {}
  async realWork(): Promise<void> {}
}

void new Example();
