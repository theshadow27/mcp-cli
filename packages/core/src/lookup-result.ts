export interface LookupFailure {
  readonly _tag: "lookup-failure";
  readonly message: string;
}

export type LookupResult<T> = T | LookupFailure;

export function lookupFailure(message: string): LookupFailure {
  return { _tag: "lookup-failure", message };
}

export function isLookupFailure(value: unknown): value is LookupFailure {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    (value as Record<string, unknown>)._tag === "lookup-failure"
  );
}
