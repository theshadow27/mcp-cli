---
name: feedback-send-briefs-via-file
description: Always pass session briefs/messages through a file or single-quoted heredoc — backticks in markdown execute when double-quoted
metadata:
  type: feedback
---

**Never pass a markdown brief to `mcx claude send` / `spawn -t` inside a double-quoted shell
string.** Write it to a file with a quoted heredoc (`<<'EOF'`) and pass `"$(cat file)"`, or
use a single-quoted string.

**Why:** briefs are markdown, and markdown is full of backticks. Inside double quotes,
backticks are command substitution. On 2026-08-22 a directive containing the literal text
`` `gh pr merge --auto` `` executed that command twice from the main checkout. It was
harmless only by luck — the checkout was on `main` with no open PR, so it errored with
"no pull requests found". On a branch with an open PR it would have armed auto-merge on it,
which is precisely the thing the message was written to forbid.

The messages were also delivered mangled, with substituted output in place of the literal
text, so the instruction did not even arrive intact.

This is the same class as the project's own rule — *"never pass template literals with `${}`
to execSync or execFileSync"* in CLAUDE.md — applied to the operator's own shell rather than
to shipped code. The rule exists because the failure is silent and looks like a formatting
problem, not an execution one.

**How to apply:** every brief, every directive, every multi-line message goes through
`cat > $S/msg.txt <<'EOF' … EOF` then `mcx claude send <id> "$(cat $S/msg.txt)"`. Single
quotes on the heredoc delimiter are what disable expansion — `<<EOF` without them still
expands. Related: [[feedback-gate-before-automerge]].
