/**
 * Environment variable expansion.
 *
 * Supports ${VAR} and ${VAR:-default} syntax, matching Claude Code's behavior.
 */

const ENV_VAR_RE = /\$\{([^}]+)\}/g;

/**
 * Expand ${VAR} and ${VAR:-default} in a string value.
 * Returns the expanded string.
 * Throws if a variable is not found and no default is provided (strict mode).
 */
export function expandEnvVars(
  value: string,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  strict = true,
): string {
  return value.replace(ENV_VAR_RE, (match, expr: string) => {
    const sepIndex = expr.indexOf(":-");
    if (sepIndex >= 0) {
      const name = expr.slice(0, sepIndex);
      const fallback = expr.slice(sepIndex + 2);
      return env[name] ?? fallback;
    }
    const resolved = env[expr];
    if (resolved === undefined && strict) {
      throw new Error(`Environment variable \${${expr}} is not set`);
    }
    return resolved ?? match;
  });
}

/**
 * Deep-expand env vars in an object tree.
 * Walks all string values recursively (objects and arrays).
 */
export function expandEnvVarsDeep<T>(
  obj: T,
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
  strict = true,
): T {
  if (typeof obj === "string") {
    return expandEnvVars(obj, env, strict) as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => expandEnvVarsDeep(item, env, strict)) as T;
  }
  if (obj !== null && typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = expandEnvVarsDeep(value, env, strict);
    }
    return result as T;
  }
  return obj;
}
