/** Map short model names to full model IDs. */
export const MODEL_SHORTNAMES: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-4-6",
  haiku: "claude-haiku-4-5",
};

/** Resolve a model name: accept shortnames or pass through full IDs. */
export function resolveModelName(input: string): string {
  return MODEL_SHORTNAMES[input.toLowerCase()] ?? input;
}
