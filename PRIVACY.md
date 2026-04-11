# Privacy & Telemetry

mcp-cli collects **anonymous usage telemetry** to identify which commands are actively used and which can be safely removed. No arguments, file contents, server names, or personally identifiable information (PII) are ever collected.

## What is collected

Each command invocation sends a single event with this exact schema:

| Field        | Example              | Description                              |
|-------------|----------------------|------------------------------------------|
| `event`     | `"mcx_command"`      | Fixed event name                         |
| `command`   | `"call"`             | The top-level command name               |
| `subcommand`| `"save"`             | The first argument (if present)          |
| `version`   | `"0.3.0"`            | mcp-cli version                          |
| `os`        | `"darwin"`           | Operating system (`process.platform`)    |
| `arch`      | `"arm64"`            | CPU architecture (`process.arch`)        |
| `distinct_id`| `"a3f2b1c9d0e1..."` | SHA-256 hash of hostname (first 16 chars)|

**Not collected:** tool arguments, file paths, server names, environment variables, stdin content, output, error messages, IP addresses (beyond what the transport reveals), or any other user data.

## Where data is sent

Events are sent via HTTPS POST to [PostHog](https://posthog.com) (`us.i.posthog.com`), a product analytics platform. PostHog's privacy policy applies to data after receipt.

## How to opt out

Any of these methods disable telemetry immediately:

```bash
# Environment variable (session or shell profile)
export MCX_NO_TELEMETRY=1

# Persistent config toggle
mcx telemetry off

# Check current status
mcx telemetry status
```

## Implementation

The telemetry module lives in `packages/core/src/telemetry.ts`. The `recordCommand()` function is fire-and-forget: it never awaits the network request, never throws on failure, and adds zero latency to command execution.
