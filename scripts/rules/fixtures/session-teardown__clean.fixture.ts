/**
 * @rule session-teardown
 * @expect 0
 * @path packages/daemon/src/example-session.ts
 *
 * Three clean shapes:
 *   - delete BEFORE the first await
 *   - delete but no await at all
 *   - await but no delete at all
 */

declare const id: string;

class Example {
  sessions = new Map<string, unknown>();

  async bye(sessionId: string): Promise<void> {
    const info = this.extract(sessionId);
    this.sessions.delete(sessionId);
    await this.terminate(sessionId);
    void info;
  }

  removeUnspawned(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  async stop(): Promise<void> {
    await this.killAll();
  }

  extract(_id: string): unknown {
    return null;
  }

  async terminate(_id: string): Promise<void> {}
  async killAll(): Promise<void> {}
}

void new Example();
void id;
