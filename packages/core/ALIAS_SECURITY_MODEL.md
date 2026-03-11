# Alias Execution Security Model

## Trust Model

Aliases are user-authored (or Claude-authored) code, not untrusted third-party code. They run with the same UID, filesystem access, and environment variables as the daemon/CLI process.

## Isolation Boundaries

### Daemon-side execution (via `mcx call _aliases`)

**Mechanism:** Subprocess via `Bun.spawn`

**Protects against:**
- Sync infinite loops blocking the daemon event loop
- Prototype pollution corrupting daemon state
- Unhandled crashes taking down the daemon
- File descriptor leaks accumulating over daemon lifetime

A buggy alias kills its subprocess, not the daemon.

### Command-side execution (via `mcx run`)

**Mechanism:** In-process eval via `AsyncFunction`

**Acceptable because:** `mcx run` is a short-lived process — crashes or pollution affect only that single invocation. No long-lived state to corrupt.

### Metadata extraction (at save-time)

**Mechanism:** In-process eval in daemon (one-shot)

**Low risk because:** Runs once at alias save time, bounded scope, no persistent state effects. The bundled JS is evaluated with stub dependencies to extract schemas — no real MCP calls or I/O.

## What Workers Provided (previously)

- Separate JS isolate (global scope, module registry, GC)
- NOT a security sandbox (same UID, same filesystem, same env vars)

## What Workers Did NOT Provide

- Resource access restriction
- Environment variable isolation
- Filesystem sandboxing
- Network access restriction

## Why Not Workers

`bun.plugin()` virtual modules + cache-bust `import(?t=...)` from worker threads causes segfaults in Bun's module resolver (#577). Workers were being used as a transport mechanism, not for genuine isolation. The complexity of 3 Worker types + virtual module registration was disproportionate to the actual isolation benefit.

## Why Subprocess Over In-Process for Daemon

The daemon is long-lived and multiplexed. A sync infinite loop or prototype pollution in the main thread takes down all connected clients. Subprocess overhead (~30ms) is acceptable for alias execution frequency.

## Future Consideration

If Bun adds ShadowRealm support, daemon-side execution could move in-process with global isolation and zero startup overhead.
