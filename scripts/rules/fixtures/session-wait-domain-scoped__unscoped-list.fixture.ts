/**
 * @rule session-wait-domain-scoped
 * @expect 0
 * @path packages/daemon/src/codex-session-worker.ts
 *
 * A worker that has not opted into the partition at all is NOT flagged: the rule
 * keys off handleSessionList already being scoped. That asymmetry is deliberate —
 * it means the rule cannot be satisfied by removing scoping from both functions,
 * only by adding it to wait.
 */

declare const sessions: Map<string, { getInfo(): unknown; waitForEvent(ms: number): Promise<unknown> }>;

function handleSessionList(): { content: Array<{ type: "text"; text: string }> } {
	const list = [...sessions.values()].map((s) => s.getInfo());
	return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const timeoutMs = (args.timeout as number) ?? 1000;
	const event = await Promise.race([...sessions.values()].map((s) => s.waitForEvent(timeoutMs)));
	return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
}

export { handleSessionList, handleWait };
