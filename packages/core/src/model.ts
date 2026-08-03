/**
 * Model tier shortnames, used only as a vocabulary for recognizing the sprint
 * plan's Model column.
 *
 * mcx deliberately does NOT map these to concrete model IDs. The `claude` CLI
 * resolves tier aliases itself — latest-in-tier on the Anthropic API, and via
 * `ANTHROPIC_DEFAULT_{OPUS,SONNET,FABLE,HAIKU}_MODEL` on Bedrock. A local ID map
 * went stale on every model release (silently downgrading `--model sonnet`) and
 * broke Bedrock by pre-resolving past the tier-alias envs (#2659).
 */
export const MODEL_SHORTNAMES: ReadonlySet<string> = new Set(["fable", "opus", "sonnet", "haiku"]);
