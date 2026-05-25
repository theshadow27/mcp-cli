/**
 * @rule session-teardown
 * @expect 0
 * @path packages/daemon/src/example-multiline.ts
 *
 * Multi-line method signatures (including object return types like
 * `Promise<{ ... }>`) must be parsed correctly — the `{` inside the
 * generic return type is NOT the body start.
 */

class Example {
  sessions = new Map<string, unknown>();

  async bye(
    sessionId: string,
    message?: string,
  ): Promise<void> {
    this.sessions.delete(sessionId);
    await this.terminate();
    void message;
  }

  async start(): Promise<{ client: unknown; transport: unknown }> {
    await this.connect();
    return { client: null, transport: null };
  }

  async handlePrompt(args: Record<string, unknown>): Promise<{
    content: Array<{ type: string }>;
    isError?: boolean;
  }> {
    this.sessions.delete(String(args.id));
    await this.work();
    return { content: [] };
  }

  async terminate(): Promise<void> {}
  async connect(): Promise<void> {}
  async work(): Promise<void> {}
}

void new Example();
