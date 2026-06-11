# Functional E2E: v1 patcher on claude-code 2.1.173 (count=3)

**VERDICT: GATE DEFEATED. The v1 byte transform still neutralizes the
`--sdk-url` host allowlist on 2.1.173, despite fedstart count being 3 (not 4).**
The only thing v1's `validate` is wrong about is the *count assertion* — the
transform itself is fully effective. Relaxing `validate` (accept per-era count
or `>= 1` live source-array hit) is the correct fix; no new transform needed.

## The behavioral fingerprint of the gate (3-way control, established first)

Spawned with mcx's exact WS-transport flags (from
`packages/daemon/src/claude-session/ws-server.ts:982-1007`):
`--sdk-url <URL> -p "" --permission-mode default --print --output-format
stream-json --input-format stream-json`.

UNPATCHED 2.1.173:

| --sdk-url | stderr | meaning |
|---|---|---|
| `ws://localhost:PORT` | `Error: --sdk-url rejected: host "localhost" is not an approved Anthropic endpoint.` | host allowlist REJECT |
| `ws://[::1]:PORT` | `Error: --sdk-url rejected: host "[::1]" is not an approved Anthropic endpoint.` | host allowlist REJECT |
| `wss://[::1]:PORT` | `Error: --sdk-url rejected: host "[::1]" is not an approved Anthropic endpoint.` | host allowlist REJECT |
| `wss://api.anthropic.com:443` | `SDKStartup: phase=connecting_transport ... worker registration failed (no_auth_headers)` | host APPROVED — passes gate, fails downstream on auth |

So the discriminator is unambiguous: a rejected host dies with
`host "X" is not an approved Anthropic endpoint` *before any connection*; an
approved host enters `SDKStartup: phase=connecting_transport` and fails later
on auth/connection (no allowlist error).

## Patch pipeline (exact commands)

```
SRC=$(readlink -f binaries/2.1.173)   # -> ~/.local/share/claude/versions/2.1.173 (read-only)
OUT=build/2.1.173.patched

# 1. v1 transform (length-preserving), via core/claude-patch/strategies.ts helpers
bun build/patch.ts "$SRC" "$OUT"
#   -> srcLen==outLen==223390752, lengthPreserved:true,
#      fedstartBefore:3, fedstartLeftover:0, replacementsApplied:3

# 2. re-sign (macOS), per patcher.ts defaultExtractEntitlements/defaultResignBinary
codesign -d --entitlements :- "$SRC" > build/2.1.173.entitlements.plist
#   entitlements: allow-jit, allow-unsigned-executable-memory,
#                 disable-library-validation, device.audio-input
codesign --force --sign - --options=runtime \
  --entitlements build/2.1.173.entitlements.plist "$OUT"
#   -> "replacing existing signature", exit 0
#   -> codesign -dv: flags=0x10002(adhoc,runtime)

# 3. smoke
"$OUT" --version    # -> "2.1.173 (Claude Code)", exit 0
```

Pre-resign smoke `--version` is SIGKILLed (137) — expected, the byte edit
invalidates the original signature; re-signing fixes it.

## The decisive result

```
bun build/probe.ts build/2.1.173.patched "wss://[::1]:54321/session/probe-patched"
```
PATCHED 2.1.173, `wss://[::1]`:
```
SDKStartup: phase=connecting_transport t=0s
SDKStartup: worker registration failed (no_auth_headers), exiting
SDKStartup: phase=transcript_hydrated t=0s messages=0
SDKStartup: phase=starting_query_loop t=0s
SDKStartup: SSE connect failed (The operation was aborted.) attempt=1 took=15ms
```
**No allowlist rejection.** Identical fingerprint to the genuine approved host
(`api.anthropic.com`). `[::1]` is now treated as an approved endpoint — the
process passes the gate and only fails downstream because no real WS server is
listening (and no auth). This is the gate-defeated signal.

Matched control (same flag, only the binary differs):
- UNPATCHED `wss://[::1]` -> `host "[::1]" is not an approved Anthropic endpoint`
- PATCHED   `wss://[::1]` -> `SDKStartup: phase=connecting_transport` (no rejection)

### Bonus: the scheme guard is now the only remaining check for [::1]

PATCHED 2.1.173 with `ws://[::1]` (plaintext) errors with a *different*,
later-stage message:
```
Error: --sdk-url rejected: scheme "ws:" is not permitted for host "[::1]";
only wss:// and https:// are accepted.
```
The host-allowlist rejection is gone; only a scheme check remains, demanding
`wss://`/`https://`. This is exactly why mcx's ws-server builds
`wss://[::1]:PORT` (TLS) for the WS transport (`ws-server.ts:990-992`) — the
TLS form sails straight through, as the `wss://[::1]` run above shows.

## Mechanism confirmation (kills/confirms the de-dup hypothesis)

The 4->3 fedstart drop at 2.1.133 is pure de-duplication of a
doubly-bundled JS chunk (the orchestrator's triage hypothesis). Functionally
proven: the live allowlist builder (`new URL(H).hostname` over the origins
array, `fd()`/source-array chunk) still ingests the rewritten
`[000:000:000:000:000:0:0:1]` origin and admits `[::1]`. Were the live builder
the dropped copy, `[::1]` would still be rejected — it is not.

## Artifacts
- `build/2.1.173.patched` — patched + re-signed, smoke-passing
- `build/2.1.173.entitlements.plist`
- `build/patch.ts`, `build/probe.ts`
- Source binary (`~/.local/share/claude/versions/2.1.173`) was never modified;
  opened read-only, all writes went to `build/`.
