---
name: Remote Claude orchestration via sprite + mcx agent
description: mcx agent claude commands work transparently over sprite x -- (Sprites.dev persistent VMs), enabling local→remote Claude orchestration
type: project
originSessionId: 15e29ae2-5e9c-40e2-a07c-013b310c529c
---
Observed 2026-04-24: a local Claude Code session naturally discovered that `mcx agent claude {spawn,send,wait,interrupt,ls,log,bye}` composes cleanly with `sprite x --` remote exec. The local Claude drove a remote Claude running on a Sprites.dev persistent VM without any prompting or special plumbing — it just invoked `sprite x -- mcx agent claude send <session> "..."` and `sprite x -- mcx agent claude wait <session>` as if the remote session were local.

Why: This is emergent cross-machine orchestration. Because `mcx agent claude` is a clean CLI surface (not a library), any remote-exec transport (sprite, ssh, mosh, etc.) becomes a distributed-Claude bus for free. Sprites.dev's persistence means the remote Claude retains session state across invocations, so `wait` actually works.

How to apply:
- This is a legitimate new use case worth supporting. When reviewing changes to `mcx agent claude` subcommands, consider how they behave under remote-exec (stdout JSON should stay clean, exit codes meaningful, `wait` should not require TTY).
- If users mention sprite/remote VMs, treat cross-machine orchestration as a supported workflow, not a hack.
- Worth a blog post / docs mention — "mcx agent claude is transport-agnostic" is an under-advertised property.
- If we ever change the agent command surface (flags, output format, exit codes), remember it's being piped through `sprite x --` and similar wrappers.
