# Privacy & Telemetry

A future release of mcp-cli will collect **anonymous usage telemetry** to identify which commands are actively used and which can be safely removed. No arguments, file contents, server names, or personally identifiable information (PII) are ever collected.

**Current status**: the telemetry framework is in place but collection is not active. As of v1.4.0, every invocation short-circuits before sending — zero events are transmitted. The PostHog project key ships as a placeholder, and the code guards against it at runtime. Actual collection begins in a future release once the backend project is configured.

**On first run**, mcx displays a one-time notice about the upcoming telemetry so you can opt out in advance, before any data is sent. Telemetry will be automatically disabled in CI environments when collection is enabled.

## What is collected

Each command invocation sends a single event with this exact schema:

| Field        | Example              | Description                              |
|-------------|----------------------|------------------------------------------|
| `event`     | `"mcx_command"`      | Fixed event name                         |
| `command`   | `"call"`             | The top-level command name               |
| `subcommand`| `"status"`           | Safe subcommand from allowlist (if any)  |
| `version`   | `"0.3.0"`            | mcp-cli version                          |
| `os`        | `"darwin"`            | Operating system (`process.platform`)    |
| `arch`      | `"arm64"`            | CPU architecture (`process.arch`)        |
| `distinct_id`| `"a3f2b1c9-..."` | Random UUID (generated once, stored locally) |

**Not collected:** tool arguments, file paths, server names, environment variables, stdin content, output, error messages, IP addresses (beyond what the transport reveals), or any other user data.

The `subcommand` field only records values from a hardcoded allowlist of known mcx subcommands (e.g. `status`, `on`, `off`, `spawn`). User-supplied values like server names or alias names are never recorded.

The `distinct_id` is a random UUID generated on first run and persisted to `~/.mcp-cli/device-id`. It is not derived from any machine identifier or personal information.

## Where data is sent

Events are sent via HTTPS POST to [PostHog](https://posthog.com) (`us.i.posthog.com`), a product analytics platform. PostHog's privacy policy applies to data after receipt. Requests have a 2-second timeout to avoid delaying CLI execution.

## When telemetry is NOT sent

- When `MCX_NO_TELEMETRY=1` is set
- When `mcx telemetry off` has been run
- In CI environments (`CI`, `GITHUB_ACTIONS`, `JENKINS_URL`, `BUILDKITE`, `CIRCLECI`, `GITLAB_CI`, `TRAVIS`, `TF_BUILD`)
- For the `mcx telemetry` command itself
- Before the first-run notice has been displayed

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
