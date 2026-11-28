import type { Stage, StageOptions, StageResult } from "am-i-done";

/**
 * A TODO that cites an issue (or a pull request) is a promise that it tracks the work. Once it is
 * closed or merged the comment is either finished work nobody deleted or a decision that was reversed, and
 * in both cases it now misleads. The same goes for a `doing-it-wrong-ignore` comment that cites an
 * issue as the reason a rule is waived: closing the issue should end the waiver.
 *
 * Copied from the am-i-done package's samples (it replaces scripts/check-stale-todos.ts).
 *
 * CI only: it needs the network and `gh`, which is too slow and too flaky for a commit hook. It
 * asks GitHub once, with one batched GraphQL query for every cited issue, and retries that call.
 * It does not follow issues in other repositories (`owner/repo#12`), read comments that cite no
 * number, or check that an open issue is still relevant. Tracked text files are scanned, docs
 * included, so keep example comments out of them; rule fixtures (`fixtures/` directories) are not.
 */

const ATTEMPTS = 3;

interface Ref {
  file: string;
  line: number;
  issues: number[];
}

// A comment marker first, so a string that merely mentions the pattern is not a reference.
const TODO = /(?:\/\/|\/\*|#|<!--|--|^\s*\*)\s*TODO\(#(\d+)\)/;
const WAIVER = /(?:\/\/|\/\*|#|<!--|--)\s*doing-it-wrong-ignore(?:-file)?\s(.*)$/;
// A bare `#12` only: `owner/repo#12` names another repository.
const BARE_REF = /(?<![\w/])#(\d+)/g;

type Run = { code: number; out: string };

async function run(root: string, env: StageOptions["env"], argv: string[]): Promise<Run> {
  const child = Bun.spawn(argv, { cwd: root, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [out, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  return { code, out };
}

function refsIn(file: string, line: number, text: string): Ref[] {
  const todo = TODO.exec(text)?.[1];
  const waiver = WAIVER.exec(text)?.[1];
  const issues = todo !== undefined ? [Number(todo)] : [...(waiver ?? "").matchAll(BARE_REF)].map((m) => Number(m[1]));
  return issues.length > 0 ? [{ file, line, issues }] : [];
}

/** The references in the tracked files, or why git could not be asked. */
async function references(root: string, env: StageOptions["env"]): Promise<Ref[] | string> {
  const grep = await run(root, env, [
    "git",
    "grep",
    "-n",
    "-I",
    "-E",
    "-e",
    "TODO\\(#[0-9]+\\)",
    "-e",
    "doing-it-wrong-ignore.*#[0-9]",
    "--",
    ".",
    // Rule fixtures hold example comments, written to show a rule what to catch.
    ":(exclude,glob)**/fixtures/**",
  ]);
  // Exit 1 means no match; anything above that is git failing (not a repository, unsafe owner).
  if (grep.code > 1) return `git grep failed (exit ${grep.code}), so no comment was checked`;
  const refs: Ref[] = [];
  for (const raw of grep.out.split("\n")) {
    const match = /^(.*?):(\d+):(.*)$/.exec(raw);
    if (match) refs.push(...refsIn(match[1] ?? "", Number(match[2]), match[3] ?? ""));
  }
  return refs;
}

/** Number to state (`OPEN`, `CLOSED`, `MERGED`), `null` when no issue or pull request has it. */
async function states(root: string, env: StageOptions["env"], numbers: number[]): Promise<Map<number, string | null>> {
  const repo = JSON.parse((await run(root, env, ["gh", "repo", "view", "--json", "nameWithOwner"])).out) as {
    nameWithOwner: string;
  };
  const [owner, name] = repo.nameWithOwner.split("/");
  const fields = numbers
    .map((n) => `i${n}: issueOrPullRequest(number: ${n}) { ... on Issue { state } ... on PullRequest { state } }`)
    .join(" ");
  const query = `query { repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { ${fields} } }`;
  for (let attempt = 1; ; attempt++) {
    // `gh` exits non-zero when some alias is missing yet still prints the rest, so read stdout first.
    const answer = await run(root, env, ["gh", "api", "graphql", "-f", `query=${query}`]);
    try {
      const data = (JSON.parse(answer.out) as { data?: { repository?: Record<string, { state: string } | null> } })
        .data;
      if (data?.repository) {
        return new Map(numbers.map((n) => [n, data.repository?.[`i${n}`]?.state ?? null]));
      }
    } catch {
      // Not JSON: fall through to the retry.
    }
    if (attempt === ATTEMPTS) throw new Error(`gh api graphql gave no answer after ${ATTEMPTS} attempts`);
    await Bun.sleep(attempt * 200);
  }
}

export default {
  id: "stale-todos",
  description: "TODO(#n) comments do not cite closed issues",
  phase: "check",
  modes: ["ci"],
  sh: false,
  ai: false,
  reads: ["*"],
  command: async ({ root, env }: StageOptions): Promise<StageResult> => {
    const refs = await references(root, env);
    if (typeof refs === "string") return { success: false, error: refs };
    if (refs.length === 0) return { success: true };
    const found = await states(root, env, [...new Set(refs.flatMap((r) => r.issues))]);
    const stale = refs.flatMap((r) =>
      r.issues.flatMap((n) =>
        found.get(n) === "OPEN" ? [] : [`${r.file}:${r.line}: #${n} is ${found.get(n)?.toLowerCase() ?? "not found"}`],
      ),
    );
    if (stale.length === 0) return { success: true };
    return {
      success: false,
      error: `comments cite issues or pull requests that are not open:\n${stale.join("\n")}`,
      output: stale.join("\n"),
    };
  },
  onFailure: [
    "Do the work and delete the comment, or reopen the issue if the work is still wanted.",
    "A waiver whose issue is closed should be removed and the rule satisfied.",
  ],
} satisfies Stage;
