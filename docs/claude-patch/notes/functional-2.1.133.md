# Functional E2E: v1 patcher on claude-code 2.1.133 (count=3, lower boundary)

**VERDICT: GATE DEFEATED.** 2.1.133 is the first version where fedstart count
dropped 4->3. The v1 transform fully neutralizes the host allowlist here too —
confirming the entire count=3 range (2.1.133 .. 2.1.173) is covered by the same
transform, only `validate`'s `=== 4` assertion is wrong.

## Notes on the source binary
`binaries/2.1.133` is a downloaded copy (not a symlink to the installed
version). It shipped without the +x bit but carries a valid Apple runtime
signature (`flags=0x10000(runtime)`, Identifier=com.anthropic.claude-code).
`chmod +x` + run -> `2.1.133 (Claude Code)`, exit 0.

## Pipeline (exact commands)

```
cp binaries/2.1.133 build/2.1.133.src && chmod +x build/2.1.133.src
SRC=build/2.1.133.src ; OUT=build/2.1.133.patched

bun build/patch.ts "$SRC" "$OUT"
#  -> srcLen==outLen==204170768, lengthPreserved:true,
#     fedstartBefore:3, fedstartLeftover:0, replacementsApplied:3

codesign -d --entitlements :- "$SRC" > build/2.1.133.entitlements.plist  # 426 bytes
codesign --force --sign - --options=runtime \
  --entitlements build/2.1.133.entitlements.plist "$OUT"   # exit 0, flags=0x10002(adhoc,runtime)
"$OUT" --version   # -> "2.1.133 (Claude Code)", exit 0
```

## Decisive result

Matched control, mcx WS-transport flags, only the binary differs:

| binary | --sdk-url | stderr / outcome |
|---|---|---|
| UNPATCHED `build/2.1.133.src` | `wss://[::1]:PORT` | `Error: --sdk-url rejected: host "[::1]" is not an approved Anthropic endpoint.` (REJECT) |
| PATCHED `build/2.1.133.patched` | `wss://[::1]:PORT` | no output, hung past the gate until killed by the 8s probe timeout (SIGKILL) — gate PASSED, blocked only on the dead WS server |
| PATCHED `build/2.1.133.patched` | `ws://[::1]:PORT` | `Error: --sdk-url rejected: scheme "ws:" is not permitted for host "[::1]"; only wss:// and https:// are accepted.` (host accepted; only scheme guard remains) |

On 2.1.133 the patched `wss://[::1]` run doesn't even early-exit on no-auth (as
.173 does) — it actively tries to connect and hangs, which the 8s timeout
reaps. Either way: zero allowlist rejection = gate defeated. The `ws://`
scheme-guard message is the same proof seen on .173 that `[::1]` is now an
approved host.

## Artifacts
- `build/2.1.133.src` (chmod+x copy of the download), `build/2.1.133.patched`,
  `build/2.1.133.entitlements.plist`
- The original `binaries/2.1.133` download was not modified.
