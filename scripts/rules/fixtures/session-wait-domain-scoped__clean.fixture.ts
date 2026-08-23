/**
 * @rule session-wait-domain-scoped
 * @expect 0
 * @path packages/daemon/src/codex-session-worker.ts
 *
 * Both read paths honour the partition, which is all the rule asks for.
 */

declare function domainFilterArg(args: Record<string, unknown>): number | undefined;
declare function matchesDomain(s: { domainId: number }, id: number | undefined): boolean;
declare const sessions: Map<string, { getInfo(): { domainId: number }; waitForEvent(ms: number): Promise<unknown> }>;

interface BufferedEvent {
	seq: number;
	sessionId: string;
	event: unknown;
	/** Captured at buffer time, so it outlives the session. */
	domainId: number;
}

declare const eventBuffer: BufferedEvent[];

function handleSessionList(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	const domainId = domainFilterArg(args);
	const list = [...sessions.values()].map((s) => s.getInfo()).filter((s) => matchesDomain(s, domainId));
	return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const timeoutMs = (args.timeout as number) ?? 1000;
	const domainId = domainFilterArg(args);
	const scoped = [...sessions.values()].filter((s) => matchesDomain(s.getInfo(), domainId));
	const event = await Promise.race(scoped.map((s) => s.waitForEvent(timeoutMs)));
	return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
}

export { handleSessionList, handleWait };
