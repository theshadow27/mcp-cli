/**
 * @rule session-wait-domain-scoped
 * @expect 1
 * @path packages/daemon/src/codex-session-worker.ts
 *
 * handleWait READS the filter — the first half of the invariant is satisfied and the
 * original version of this rule passed this file. But BufferedEvent does not carry the
 * domain, so a buffered event can only be attributed by looking its emitter up in the
 * live `sessions` map, which is cleared on session:ended while the buffer survives.
 * That is the shape that lost a scoped `wait --after` its OWN domain's events.
 */

declare function domainFilterArg(args: Record<string, unknown>): number | undefined;
declare function matchesDomain(s: { domainId: number }, id: number | undefined): boolean;
declare const sessions: Map<string, { getInfo(): { domainId: number }; waitForEvent(ms: number): Promise<unknown> }>;

interface BufferedEvent {
	seq: number;
	sessionId: string;
	event: unknown;
}

const eventBuffer: BufferedEvent[] = [];

function handleSessionList(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	const domainId = domainFilterArg(args);
	const list = [...sessions.values()].map((s) => s.getInfo()).filter((s) => matchesDomain(s, domainId));
	return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const domainId = domainFilterArg(args);
	// Re-derives the domain from a map that does not outlive the session.
	const replay = eventBuffer.filter((e) => {
		const live = sessions.get(e.sessionId);
		return live !== undefined && matchesDomain(live.getInfo(), domainId);
	});
	return { content: [{ type: "text", text: JSON.stringify(replay) }] };
}

export { handleSessionList, handleWait };
