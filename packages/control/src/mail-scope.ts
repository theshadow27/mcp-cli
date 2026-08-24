/**
 * The domain scope `mcpctl`'s mail calls carry (#3038).
 *
 * Every mail IPC method is domain-partitioned, and the daemon refuses a call that does
 * not say which partition it is acting in. `mcpctl` acts in the domain owning the
 * directory it was launched from — the same rule `mcx mail` follows.
 *
 * One helper rather than four inline copies: the four mail call sites in this package
 * (`use-mail`, `use-unread-mail`, and two `markRead`s in `use-keyboard-mail`) must all
 * agree on the partition, or the mail tab would list messages from one domain and mark
 * them read in another.
 *
 * A domain **selector** for the TUI is a later piece of the epic (`docs/console.md`);
 * when it lands it overrides this, it does not sit alongside it.
 *
 * `cwd`-only scope is safe for the four "daemon unreachable, skip this tick" catch
 * blocks in this package precisely because `resolveCallerDomain`'s cwd branch is now a total
 * function (#3038 RED 1): a `cwd` outside every registered domain resolves to the
 * reserved, always-addressable partition 0 rather than throwing. There is no longer a
 * *permanent* domain-resolution failure a `cwd`-only caller can hit — every remaining
 * throw needs an explicit `-d`, which nothing in this package passes — so those catches
 * only ever swallow the transient case they document (#3038 review finding #7).
 */
export function controlMailScope(): { cwd: string } {
  return { cwd: process.cwd() };
}
