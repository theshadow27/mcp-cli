/**
 * @rule no-raw-path-handling
 * @expect 6
 * @path packages/daemon/src/example-flagged.ts
 *
 * Raw path handling patterns that should be flagged.
 */

// startsWith("/") — use path.isAbsolute instead
if (target.startsWith("/")) doSomething();

// startsWith("\\\\") — UNC path check, use path.isAbsolute instead
if (target.startsWith("\\\\")) doSomething();

// process.cwd() in === comparison (daemon scope)
if (repoRoot === process.cwd()) doSomething();

// Map-like method with raw process.cwd() argument (daemon scope)
cache.get(process.cwd());
cache.set(process.cwd(), value);

// Variable-bound process.cwd() in comparison (daemon scope)
const dir = process.cwd();
if (dir === repoRoot) doSomething();
