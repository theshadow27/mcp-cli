#!/usr/bin/env python3
"""Dump a sprint's PR comment corpus to build/<name>.json for offline audit.

Lives in the repo rather than session scratch: the report it feeds was nearly lost to a
session-scoped temp dir, and a tool that regenerates the input has the same exposure.

Usage:  python3 .claude/boss/dump-pr-reviews.py 2026-08-22T04:00:00Z build/sprint-78-reviews.json
"""
import json, subprocess, sys

since = sys.argv[1] if len(sys.argv) > 1 else "2026-08-22T04:00:00Z"
outpath = sys.argv[2] if len(sys.argv) > 2 else "build/sprint-78-reviews.json"
REPO = "theshadow27/mcp-cli"

prs = subprocess.run(
    ["gh", "pr", "list", "--repo", REPO, "--state", "all", "--limit", "60",
     "--json", "number,updatedAt", "--jq",
     f'.[]|select(.updatedAt>"{since}")|.number'],
    capture_output=True, text=True).stdout.split()

out, total, edited = {}, 0, 0
for pr in prs:
    rec = {"number": int(pr)}
    for key, path in (("issue_comments", f"/repos/{REPO}/issues/{pr}/comments"),
                      ("review_comments", f"/repos/{REPO}/pulls/{pr}/comments"),
                      ("reviews", f"/repos/{REPO}/pulls/{pr}/reviews")):
        r = subprocess.run(["gh", "api", "--paginate", path], capture_output=True, text=True)
        try:
            data = json.loads(r.stdout) if r.stdout.strip() else []
        except Exception:
            data = []
        rows = []
        for c in (data if isinstance(data, list) else []):
            ca, ua = c.get("created_at"), c.get("updated_at")
            # updated_at != created_at means the body was rewritten after posting. A
            # round-1 sticky edited hours later may have had its original findings
            # erased; GitHub exposes no edit history, so this flag is the only signal.
            if ca and ua and ca != ua:
                edited += 1
            rows.append({"id": c.get("id"), "created_at": ca, "updated_at": ua,
                         "edited": bool(ca and ua and ca != ua),
                         "user": (c.get("user") or {}).get("login"),
                         "path": c.get("path"), "line": c.get("line"),
                         "state": c.get("state"), "body": c.get("body")})
        rec[key] = rows
        total += len(rows)
    out[pr] = rec

json.dump(out, open(outpath, "w"), indent=1)
print(f"wrote {outpath}: {len(prs)} PRs, {total} items, {edited} edited-after-posting")
