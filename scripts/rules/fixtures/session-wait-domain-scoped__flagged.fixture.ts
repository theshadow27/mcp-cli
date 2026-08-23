/**
 * @rule session-wait-domain-scoped
 * @expect 1
 * @path packages/daemon/src/codex-session-worker.ts
 *
 * handleSessionList honours the domain partition; handleWait twenty lines below
 * does not. This is the exact shape that shipped: `wait` accepted the resolved
 * domainId, the tool schema advertised it, and the any-session path then raced
 * every session in the process — so an orchestrator blocking on a scoped wait
 * read a completion for a session it does not own.
 */

declare function domainFilterArg(args: Record<string, unknown>): number | undefined;
declare function matchesDomain(s: { domainId: number }, id: number | undefined): boolean;
declare const sessions: Map<string, { getInfo(): { domainId: number }; waitForEvent(ms: number): Promise<unknown> }>;

function handleSessionList(args: Record<string, unknown>): { content: Array<{ type: "text"; text: string }> } {
	const domainId = domainFilterArg(args);
	const list = [...sessions.values()].map((s) => s.getInfo()).filter((s) => matchesDomain(s, domainId));
	return { content: [{ type: "text", text: JSON.stringify(list, null, 2) }] };
}

async function handleWait(args: Record<string, unknown>): Promise<{
	content: Array<{ type: "text"; text: string }>;
}> {
	const timeoutMs = (args.timeout as number) ?? 1000;
	// No domain filter read here — every session is raced regardless of the caller's domain.
	const waiters = [...sessions.values()].map((s) => s.waitForEvent(timeoutMs));
	const event = await Promise.race(waiters);
	return { content: [{ type: "text", text: JSON.stringify(event, null, 2) }] };
}

export { handleSessionList, handleWait };
