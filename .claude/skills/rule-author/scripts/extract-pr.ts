#!/usr/bin/env bun
/**
 * extract-pr.ts — Extract full PR context for rule harvesting.
 *
 * Usage: bun .claude/skills/rule-author/scripts/extract-pr.ts <pr> [<pr> ...]
 *
 * Writes build/harvest/pr/<pr>.md per PR with title, description, changed
 * files, and all review surfaces (issue comments, review bodies, inline
 * review threads with resolution status). Owner/repo are derived from the
 * current `gh` context, so the script is repo-portable.
 *
 * Findings to mine live in the review comments; the diff itself is not
 * fetched (merged-PR `gh pr diff` is unreliable and adds latency).
 */

import { $ } from "bun";

const OUTPUT_DIR = "build/harvest/pr";

async function gh(...args: string[]): Promise<string> {
  return (await $`gh ${args}`.text()).trim();
}

async function ghApi(path: string, jq?: string): Promise<string> {
  const args = ["api", path];
  if (jq) args.push("--jq", jq);
  return gh(...args);
}

const repo = await gh("repo", "view", "--json", "owner,name");
const { owner, name } = (() => {
  const j = JSON.parse(repo);
  return { owner: j.owner.login as string, name: j.name as string };
})();

async function ghGraphQL(query: string): Promise<string> {
  return gh("api", "graphql", "-f", `query=${query}`);
}

async function extractPR(num: string): Promise<string> {
  const s: string[] = [];

  const meta = JSON.parse(
    await gh(
      "pr", "view", num, "--json",
      "number,title,body,state,mergedAt,author,labels,headRefName,baseRefName,url,additions,deletions",
    ),
  );
  s.push(`# PR #${meta.number}: ${meta.title}\n`);
  s.push(`- **URL:** ${meta.url}`);
  s.push(`- **Author:** ${meta.author.login}`);
  s.push(`- **State:** ${meta.state}${meta.mergedAt ? ` (merged ${meta.mergedAt})` : ""}`);
  s.push(`- **Branch:** ${meta.headRefName} → ${meta.baseRefName}`);
  s.push(`- **Size:** +${meta.additions} / -${meta.deletions}`);
  if (meta.labels?.length) {
    s.push(`- **Labels:** ${meta.labels.map((l: { name: string }) => l.name).join(", ")}`);
  }
  s.push("");

  if (meta.body) {
    s.push("## Description\n", meta.body, "");
  }

  const files = JSON.parse(await gh("pr", "view", num, "--json", "files")).files ?? [];
  if (files.length) {
    s.push("## Changed Files\n", "| File | +/- |", "|------|-----|");
    for (const f of files) s.push(`| ${f.path} | +${f.additions}/-${f.deletions} |`);
    s.push("");
  }

  // ① Issue comments (QA/review sticky comments, discussion)
  const issueComments = JSON.parse(
    await ghApi(
      `repos/${owner}/${name}/issues/${num}/comments`,
      "[.[] | {user: .user.login, created_at: .created_at, body: .body}]",
    ),
  );
  if (issueComments.length) {
    s.push("## Issue Comments\n");
    for (const c of issueComments) {
      s.push(`### Comment by ${c.user} (${c.created_at})\n`, c.body, "");
    }
  }

  // ② Review bodies (Copilot, human/agent reviews)
  const reviews = JSON.parse(
    await ghApi(
      `repos/${owner}/${name}/pulls/${num}/reviews`,
      "[.[] | {user: .user.login, state: .state, body: .body, submitted_at: .submitted_at}]",
    ),
  );
  const reviewsWithBody = reviews.filter((r: { body: string }) => r.body);
  if (reviewsWithBody.length) {
    s.push("## Review Bodies\n");
    for (const r of reviewsWithBody) {
      s.push(`### Review by ${r.user} — ${r.state} (${r.submitted_at})\n`, r.body, "");
    }
  }

  // ③ Inline review threads (with resolution status)
  const threadsRaw = await ghGraphQL(`{
    repository(owner: "${owner}", name: "${name}") {
      pullRequest(number: ${num}) {
        reviewThreads(first: 60) {
          nodes {
            isResolved
            comments(first: 12) { nodes { body, author { login }, path, line } }
          }
        }
      }
    }
  }`);
  const threads = JSON.parse(threadsRaw)?.data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  if (threads.length) {
    s.push("## Inline Review Threads\n");
    for (const t of threads) {
      const status = t.isResolved ? "RESOLVED" : "OPEN";
      const first = t.comments.nodes[0];
      const loc = first?.path ? `${first.path}:${first.line ?? "?"}` : "general";
      s.push(`### Thread at ${loc} [${status}]\n`);
      for (const c of t.comments.nodes) {
        s.push(`**${c.author?.login ?? "unknown"}:**`, c.body, "");
      }
    }
  }

  return s.join("\n");
}

const nums = process.argv.slice(2).filter((a) => /^\d+$/.test(a));
if (!nums.length) {
  console.error("Usage: extract-pr.ts <pr> [<pr> ...]");
  process.exit(1);
}

await $`mkdir -p ${OUTPUT_DIR}`;
for (const num of nums) {
  try {
    await Bun.write(`${OUTPUT_DIR}/${num}.md`, await extractPR(num));
    console.log(`${OUTPUT_DIR}/${num}.md`);
  } catch (e) {
    console.error(`FAILED #${num}: ${e instanceof Error ? e.message : e}`);
  }
}
