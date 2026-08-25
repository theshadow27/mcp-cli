import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir as osTmpdir } from "node:os";

/**
 * A **canonical** temp root. `tmpdir()` is `/var/folders/...` on macOS and `/var` is a
 * symlink, so a fixture path built on the raw value already contains an unresolved
 * ancestor — and these tests assert on exactly how much of a path canonicalization
 * leaves alone. Resolving the root once keeps the only symlink in a fixture the one the
 * test creates on purpose.
 */
const tmpdir = (): string => realpathSync(osTmpdir());
import { isAbsolute, join } from "node:path";
import {
  type Domain,
  NO_DOMAIN_ID,
  canonicalizeDomainPath,
  canonicalizeExistingDomainPath,
  expandLocalDomainPath,
  formatDomainLocation,
  isDomainScoped,
  isPathWithin,
  isValidDomainName,
  matchesDomain,
  normalizeDomainPath,
  parseDomainLocation,
  resolveDomainForPath,
  resolveDomainLocation,
  toDomainFilter,
} from "./domain";

function domain(name: string, path: string, host: string | null = null, id = 1): Domain {
  return { id, name, host, path, createdAt: "2026-08-22T00:00:00.000Z" };
}

describe("resolveDomainForPath", () => {
  test("exact match on the domain root", () => {
    const phoenix = domain("phoenix", "/home/u/github/phoenix");
    expect(resolveDomainForPath("/home/u/github/phoenix", [phoenix])).toBe(phoenix);
  });

  test("matches a path underneath the domain root", () => {
    const phoenix = domain("phoenix", "/home/u/github/phoenix");
    expect(resolveDomainForPath("/home/u/github/phoenix/src/deep/file", [phoenix])).toBe(phoenix);
  });

  test("nested domains: longest matching prefix wins", () => {
    const outer = domain("outer", "/home/u/github", null, 1);
    const inner = domain("inner", "/home/u/github/phoenix", null, 2);
    // Registration order must not matter.
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [outer, inner])).toBe(inner);
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [inner, outer])).toBe(inner);
    // Above the inner domain, the outer one still owns it.
    expect(resolveDomainForPath("/home/u/github/other", [outer, inner])).toBe(outer);
  });

  test("returns null above every domain — callers error, never guess", () => {
    const phoenix = domain("phoenix", "/home/u/github/phoenix");
    expect(resolveDomainForPath("/home/u", [phoenix])).toBeNull();
    expect(resolveDomainForPath("/", [phoenix])).toBeNull();
    expect(resolveDomainForPath("/tmp/elsewhere", [phoenix])).toBeNull();
  });

  test("returns null for an empty domain list", () => {
    expect(resolveDomainForPath("/home/u/github/phoenix", [])).toBeNull();
  });

  test("a sibling whose name is a string prefix is NOT inside the domain", () => {
    const bar = domain("bar", "/foo/bar");
    expect(resolveDomainForPath("/foo/barbaz", [bar])).toBeNull();
    expect(resolveDomainForPath("/foo/barbaz/deep", [bar])).toBeNull();
    // ...but the real child still matches.
    expect(resolveDomainForPath("/foo/bar/baz", [bar])).toBe(bar);
  });

  test("trailing slashes on either side do not change the answer", () => {
    const phoenix = domain("phoenix", "/home/u/github/phoenix/");
    expect(resolveDomainForPath("/home/u/github/phoenix", [phoenix])).toBe(phoenix);
    expect(resolveDomainForPath("/home/u/github/phoenix/", [phoenix])).toBe(phoenix);
    expect(resolveDomainForPath("/home/u/github/phoenix/src/", [phoenix])).toBe(phoenix);
  });

  test("a domain bound to a host never owns a local path", () => {
    const remote = domain("remote", "/home/u/github/phoenix", "boxen0010");
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [remote])).toBeNull();
  });

  test("a local domain still wins when a remote domain shares its path", () => {
    const remote = domain("remote", "/home/u/github/phoenix", "boxen0010", 1);
    const local = domain("local", "/home/u/github/phoenix", null, 2);
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [remote, local])).toBe(local);
  });

  test("ties resolve deterministically by name, not by row order", () => {
    const a = domain("alpha", "/home/u/github/phoenix", null, 1);
    const b = domain("beta", "/home/u/github/phoenix", null, 2);
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [a, b])?.name).toBe("alpha");
    expect(resolveDomainForPath("/home/u/github/phoenix/src", [b, a])?.name).toBe("alpha");
  });

  test("a domain registered at / owns everything", () => {
    const root = domain("root", "/");
    expect(resolveDomainForPath("/anything/at/all", [root])).toBe(root);
    expect(resolveDomainForPath("/", [root])).toBe(root);
  });

  test("normalizes '..' and duplicate separators before comparing", () => {
    const phoenix = domain("phoenix", "/home/u/github/phoenix");
    expect(resolveDomainForPath("/home/u/github/other/../phoenix/src", [phoenix])).toBe(phoenix);
    expect(resolveDomainForPath("/home//u/github/phoenix", [phoenix])).toBe(phoenix);
    // Escaping upward out of the domain is not a match.
    expect(resolveDomainForPath("/home/u/github/phoenix/../elsewhere", [phoenix])).toBeNull();
  });
});

describe("isPathWithin", () => {
  test("a path is within itself", () => {
    expect(isPathWithin("/a/b", "/a/b")).toBe(true);
  });

  test("segment boundaries are respected", () => {
    expect(isPathWithin("/foo/barbaz", "/foo/bar")).toBe(false);
    expect(isPathWithin("/foo/bar/baz", "/foo/bar")).toBe(true);
  });

  test("everything is within root", () => {
    expect(isPathWithin("/foo", "/")).toBe(true);
    expect(isPathWithin("/", "/")).toBe(true);
  });

  test("a parent is not within its child", () => {
    expect(isPathWithin("/foo", "/foo/bar")).toBe(false);
  });
});

describe("normalizeDomainPath — refuses to guess (#3034 review 7)", () => {
  test("throws on a relative path instead of anchoring it at process.cwd()", () => {
    for (const bad of ["work", "./work", "../work", "a/b"]) {
      expect(() => normalizeDomainPath(bad)).toThrow(/must be absolute/);
    }
  });

  test("throws on the empty string rather than confidently answering with cwd", () => {
    // Previously normalizeDomainPath("") returned process.cwd(), so
    // resolveDomainForPath("", domains) returned the domain containing the daemon's cwd —
    // a confident non-null answer for a missing input.
    expect(() => normalizeDomainPath("")).toThrow(/must be absolute/);
    expect(() => resolveDomainForPath("", [domain("d", "/home/u/d")])).toThrow(/must be absolute/);
  });

  test("throws on ~ rather than producing <cwd>/~/work", () => {
    // docs/domains.md uses `mcx domain add phoenix ~/github/phoenix-octovalve` as its
    // canonical example. Unquoted bash expands it; quoted, config-file and programmatic
    // input do not, and that used to silently become <cwd>/~/github/...
    expect(() => normalizeDomainPath("~/work")).toThrow(/must be absolute/);
    expect(() => normalizeDomainPath("~/work")).toThrow(/expand ~ before calling/);
  });

  test("does not expand ~ into this process's home", () => {
    // A tilde in a host-bound domain means THAT machine's home, not ours.
    expect(() => normalizeDomainPath("~")).toThrow();
  });
});

describe("normalizeDomainPath", () => {
  test("strips a trailing separator but keeps root", () => {
    expect(normalizeDomainPath("/a/b/")).toBe("/a/b");
    expect(normalizeDomainPath("/a/b")).toBe("/a/b");
    expect(normalizeDomainPath("/")).toBe("/");
  });

  test("collapses . and .. and duplicate separators", () => {
    expect(normalizeDomainPath("/a//b/./c/../d")).toBe("/a/b/d");
  });
});

describe("parseDomainLocation", () => {
  test("a bare path is local", () => {
    expect(parseDomainLocation("/home/u/github/phoenix")).toEqual({ host: null, path: "/home/u/github/phoenix" });
    expect(parseDomainLocation("~/github/phoenix")).toEqual({ host: null, path: "~/github/phoenix" });
  });

  test("host:path splits on the first colon", () => {
    expect(parseDomainLocation("boxen0010:~/github/phoenix")).toEqual({
      host: "boxen0010",
      path: "~/github/phoenix",
    });
    expect(parseDomainLocation("box:/a:b")).toEqual({ host: "box", path: "/a:b" });
  });

  test("a colon inside a path is not a host separator", () => {
    expect(parseDomainLocation("/tmp/a:b")).toEqual({ host: null, path: "/tmp/a:b" });
  });

  test("an empty host or empty path is treated as a local path", () => {
    expect(parseDomainLocation(":/tmp/x")).toEqual({ host: null, path: ":/tmp/x" });
    expect(parseDomainLocation("box:")).toEqual({ host: null, path: "box:" });
  });

  test("round-trips through formatDomainLocation", () => {
    for (const spec of ["/home/u/p", "boxen0010:~/github/p", "~/github/p"]) {
      expect(formatDomainLocation(parseDomainLocation(spec))).toBe(spec);
    }
  });
});

describe("isValidDomainName", () => {
  test("accepts the names mail addressing depends on", () => {
    for (const name of ["phoenix", "mcp-cli", "work_2", "a", "A1"]) {
      expect(isValidDomainName(name)).toBe(true);
    }
  });

  test("rejects names that would break user@domain or a path", () => {
    for (const name of ["", "-leading", "_leading", "has space", "has/slash", "has:colon", "has@at", "has.dot"]) {
      expect(isValidDomainName(name)).toBe(false);
    }
  });
});

describe("NO_DOMAIN_ID", () => {
  test("is 0, below every real INTEGER PRIMARY KEY", () => {
    expect(NO_DOMAIN_ID).toBe(0);
  });

  test("isDomainScoped is false only for the sentinel", () => {
    expect(isDomainScoped(NO_DOMAIN_ID)).toBe(false);
    expect(isDomainScoped(1)).toBe(true);
    expect(isDomainScoped(999)).toBe(true);
  });
});

describe("canonicalizeDomainPath — symlinks (#3034 review 8)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const p of made) {
      try {
        rmSync(p, { recursive: true, force: true });
        // dotw-ignore test-empty-catch: best-effort cleanup
      } catch {
        /* ignore */
      }
    }
  });

  test("resolves a symlinked directory to its real path", () => {
    const real = mkdtempSync(join(tmpdir(), "mcx-domain-real-"));
    made.push(real);
    const link = join(tmpdir(), `mcx-domain-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, link);
    try {
      expect(canonicalizeDomainPath(link)).toBe(realpathSync(real));
      // ...and a path *under* the symlink too, which is the .claude/worktrees case.
      expect(canonicalizeDomainPath(join(link, "sub"))).toBe(join(realpathSync(real), "sub"));
    } finally {
      unlinkSync(link);
    }
  });

  test("a symlinked path and its real path resolve to the same domain", () => {
    const real = mkdtempSync(join(tmpdir(), "mcx-domain-real2-"));
    made.push(real);
    const link = join(tmpdir(), `mcx-domain-link2-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, link);
    try {
      const d = domain("proj", canonicalizeDomainPath(real));
      expect(resolveDomainForPath(canonicalizeDomainPath(join(link, "src")), [d])).toBe(d);
    } finally {
      unlinkSync(link);
    }
  });

  test("degrades to the lexical form for a path that does not exist", () => {
    expect(canonicalizeDomainPath("/definitely/not/here/xyz")).toBe("/definitely/not/here/xyz");
  });

  test("still refuses a relative path", () => {
    expect(() => canonicalizeDomainPath("relative/path")).toThrow(/must be absolute/);
  });
});

describe("canonicalizeExistingDomainPath — the registration-time rule (#3210)", () => {
  const made: string[] = [];
  afterAll(() => {
    for (const p of made) {
      try {
        rmSync(p, { recursive: true, force: true });
        // dotw-ignore test-empty-catch: best-effort cleanup
      } catch {
        /* ignore */
      }
    }
  });

  test("refuses a path that does not exist, where the lexical degradation would happen", () => {
    // The exact input `canonicalizeDomainPath` answers with a *lexical* join — an answer
    // that is only true until the missing segments appear.
    expect(() => canonicalizeExistingDomainPath("/definitely/not/here/xyz")).toThrow(/does not exist/);
  });

  test("accepts an existing path and resolves it, so the answer cannot change later", () => {
    const real = mkdtempSync(join(tmpdir(), "mcx-domain-exists-"));
    made.push(real);
    mkdirSync(join(real, "sub"));
    const link = join(tmpdir(), `mcx-domain-exists-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    symlinkSync(real, link);
    try {
      // Both spellings collapse to the same fully-resolved path — nothing lexical is left
      // in the answer, which is the whole reason existence is required.
      expect(canonicalizeExistingDomainPath(join(link, "sub"))).toBe(join(realpathSync(real), "sub"));
      expect(canonicalizeExistingDomainPath(join(real, "sub"))).toBe(join(realpathSync(real), "sub"));
    } finally {
      unlinkSync(link);
    }
  });

  test("this is the drift #3210 describes: the two spellings agree only once the path exists", () => {
    const real = mkdtempSync(join(tmpdir(), "mcx-domain-drift-"));
    made.push(real);
    const link = join(tmpdir(), `mcx-domain-drift-link-${process.pid}-${Math.random().toString(36).slice(2)}`);
    const viaLink = join(link, "sub");

    // Before the path exists, the tolerant form answers with the un-resolved spelling...
    expect(canonicalizeDomainPath(viaLink)).toBe(viaLink);
    expect(() => canonicalizeExistingDomainPath(viaLink)).toThrow(/does not exist/);

    mkdirSync(join(real, "sub"));
    symlinkSync(real, link);
    made.push(link);
    try {
      // ...and afterwards with a different one. A row stored before this moment no longer
      // matches what a lookup computes now — `ls` shows it, `which` cannot find it.
      expect(canonicalizeDomainPath(viaLink)).toBe(join(realpathSync(real), "sub"));
      expect(canonicalizeDomainPath(viaLink)).not.toBe(viaLink);
    } finally {
      unlinkSync(link);
    }
  });

  test("a relative path is still refused first — absoluteness is not existence", () => {
    expect(() => canonicalizeExistingDomainPath("relative/path")).toThrow(/must be absolute/);
  });

  test("an existing FILE is accepted: a fully resolved realpath is the whole invariant", () => {
    // Deliberately not a directory check. Requiring one would be a separate policy about
    // what a domain may be bound to, and it is not what closes the drift class.
    const real = mkdtempSync(join(tmpdir(), "mcx-domain-file-"));
    made.push(real);
    const file = join(real, "a-file");
    writeFileSync(file, "");
    expect(canonicalizeExistingDomainPath(file)).toBe(join(realpathSync(real), "a-file"));
  });
});

describe("expandLocalDomainPath (#3035)", () => {
  const env = { home: "/home/tester", cwd: "/home/tester/repo" };

  test("expands a bare tilde to home", () => {
    expect(expandLocalDomainPath("~", env)).toBe("/home/tester");
  });

  test("expands ~/ to a path under home", () => {
    expect(expandLocalDomainPath("~/github/phoenix", env)).toBe("/home/tester/github/phoenix");
  });

  test("resolves a relative path against the CALLER's cwd, not the daemon's", () => {
    // The bug this prevents: a relative path stored verbatim resolves against whatever
    // directory the daemon happened to start in, and only misbehaves after a restart.
    expect(expandLocalDomainPath("packages/core", env)).toBe("/home/tester/repo/packages/core");
    expect(expandLocalDomainPath(".", env)).toBe("/home/tester/repo");
    expect(expandLocalDomainPath("../other", env)).toBe("/home/tester/other");
  });

  test("passes an absolute path through, normalized", () => {
    expect(expandLocalDomainPath("/srv/app/", env)).toBe("/srv/app");
    expect(expandLocalDomainPath("/srv/./app/../app", env)).toBe("/srv/app");
  });

  test("refuses ~user — another account's home is not ours to resolve", () => {
    expect(() => expandLocalDomainPath("~alice/work", env)).toThrow(/only "~" for the current user/);
  });

  test("refuses an empty path", () => {
    expect(() => expandLocalDomainPath("", env)).toThrow(/required/);
  });

  test("refuses to anchor on a relative cwd", () => {
    expect(() => expandLocalDomainPath("sub", { home: "/home/u", cwd: "relative" })).toThrow(/cwd must be absolute/);
  });

  test("every expansion is absolute — the property the table depends on", () => {
    for (const input of ["~", "~/x", ".", "..", "a/b", "/abs", "/abs/"]) {
      expect(isAbsolute(expandLocalDomainPath(input, env))).toBe(true);
    }
  });
});

describe("resolveDomainLocation (#3035)", () => {
  const env = { home: "/home/tester", cwd: "/home/tester/repo" };

  test("the local and host forms are the same command, differing only in host", () => {
    const local = resolveDomainLocation("~/github/phoenix", env);
    const remote = resolveDomainLocation("boxen0010:~/github/phoenix", env);
    expect(local).toEqual({ host: null, path: "/home/tester/github/phoenix" });
    expect(remote.host).toBe("boxen0010");
  });

  test("a host-bound path is stored verbatim — its ~ is that host's home, not ours", () => {
    expect(resolveDomainLocation("boxen0010:~/github/phoenix", env).path).toBe("~/github/phoenix");
    expect(resolveDomainLocation("boxen0010:/srv/app", env).path).toBe("/srv/app");
  });

  test("but verbatim is not unchecked: a relative remote path is refused (#3160 N6)", () => {
    // `a:b` and `C:\\work` both parse to a VALID hostname plus junk, so the host check
    // passes and the path is nonsense. And a relative row is not inert: resolveDomainForPath
    // normalizes every row inside its loop, so one of them breaks `which` for every query.
    expect(() => resolveDomainLocation("boxen0010:relative/path", env)).toThrow(/invalid remote path/);
    expect(() => resolveDomainLocation("a:b", env)).toThrow(/invalid remote path/);
    expect(() => resolveDomainLocation("C:\\work", env)).toThrow(/invalid remote path/);
  });

  test("round-trips through formatDomainLocation", () => {
    for (const spec of ["/srv/app", "boxen0010:~/work"]) {
      expect(formatDomainLocation(resolveDomainLocation(spec, env))).toBe(spec);
    }
  });

  test("a colon after a separator is part of a local path, not a host", () => {
    expect(resolveDomainLocation("/tmp/a:b", env)).toEqual({ host: null, path: "/tmp/a:b" });
  });
});

describe("resolveDomainLocation — malformed specs (#3160 review finding 3)", () => {
  const env = { home: "/home/tester", cwd: "/home/tester/repo" };

  test("rejects a colon form that yields only one half, instead of expanding it to garbage", () => {
    // Each of these used to become an absolute-looking path under cwd — e.g.
    // ":/tmp/foo" -> "/home/tester/repo/:/tmp/foo" — which normalizeDomainPath accepts and
    // nothing downstream rejects, because a domain path need not exist.
    for (const spec of [":/tmp/foo", "boxen:", ":"]) {
      expect(() => resolveDomainLocation(spec, env)).toThrow(/malformed location/);
    }
  });

  test("rejects a host that is not a hostname", () => {
    expect(() => resolveDomainLocation("  spacey:/tmp/x", env)).toThrow(/invalid host/);
    expect(() => resolveDomainLocation("a b:/tmp/x", env)).toThrow(/invalid host/);
  });

  test("accepts real hostnames, including dotted and hyphenated", () => {
    expect(resolveDomainLocation("box-1.lan:/srv/x", env)).toEqual({ host: "box-1.lan", path: "/srv/x" });
  });

  test("a colon AFTER a separator is still an ordinary local path", () => {
    expect(resolveDomainLocation("/tmp/a:b", env)).toEqual({ host: null, path: "/tmp/a:b" });
    expect(resolveDomainLocation("~/a:b", env)).toEqual({ host: null, path: "/home/tester/a:b" });
    expect(resolveDomainLocation("sub/a:b", env)).toEqual({ host: null, path: "/home/tester/repo/sub/a:b" });
  });

  test("no accepted spec ever expands to a path containing a bare colon segment", () => {
    // The property, not the cases: whatever survives is either host-bound (stored verbatim)
    // or an absolute local path whose first segment is not a `host:` fragment.
    for (const spec of ["/tmp/x", "~/x", "sub/x", "/tmp/a:b", "boxen0010:~/work"]) {
      const loc = resolveDomainLocation(spec, env);
      if (loc.host === null) {
        expect(isAbsolute(loc.path)).toBe(true);
        expect(loc.path.split("/").filter(Boolean)[0]).not.toContain(":");
      }
    }
  });
});

describe("toDomainFilter", () => {
  test("a real domain id filters", () => {
    expect(toDomainFilter(1)).toBe(1);
    expect(toDomainFilter(42)).toBe(42);
  });

  test("the unassigned sentinel is NOT a filter", () => {
    // Filtering on 0 would answer "which sessions are in no domain?" while
    // reading like a domain filter at the call site — and would hide every
    // session the moment domains started being registered.
    expect(toDomainFilter(NO_DOMAIN_ID)).toBeUndefined();
  });

  test("absent stays absent", () => {
    expect(toDomainFilter(undefined)).toBeUndefined();
  });
});

describe("matchesDomain", () => {
  test("no filter admits everything, including a session-less event", () => {
    expect(matchesDomain({ domainId: 3 }, undefined)).toBe(true);
    expect(matchesDomain(undefined, undefined)).toBe(true);
  });

  test("an active filter drops an event with no session (#1308)", () => {
    expect(matchesDomain(undefined, 3)).toBe(false);
  });

  test("admits only the matching domain", () => {
    expect(matchesDomain({ domainId: 3 }, 3)).toBe(true);
    expect(matchesDomain({ domainId: 4 }, 3)).toBe(false);
    expect(matchesDomain({ domainId: NO_DOMAIN_ID }, 3)).toBe(false);
  });

  test("sibling-prefix directories RESOLVE to different domains — the historic scopeRoot bug", () => {
    // The previous version of this test built two sessions with two different ids and
    // asserted they compared unequal. That is true by construction and cannot fail; it
    // read as coverage of the scopeRoot bug while testing nothing.
    //
    // The bug lived in RESOLUTION, not comparison: `cwd.startsWith(scopeRoot)` put
    // /foo/barbaz inside /foo/bar. So assert resolution, and assert it against the
    // string-prefix rule that was wrong — this fails if isPathWithin ever loses its
    // segment awareness.
    const bar = domain("bar", "/foo/bar", null, 1);
    const barbaz = domain("barbaz", "/foo/barbaz", null, 2);
    const domains = [bar, barbaz];

    for (const path of ["/foo/barbaz", "/foo/barbaz/src", "/foo/barbaz/deep/nested"]) {
      // The rule that shipped the bug would have said "yes" to all three.
      expect(path.startsWith("/foo/bar")).toBe(true);
      expect(isPathWithin(path, "/foo/bar")).toBe(false);
      expect(resolveDomainForPath(path, domains)).toBe(barbaz);
    }

    expect(resolveDomainForPath("/foo/bar/src", domains)).toBe(bar);
    // And the ids that resolution produced are what filtering then compares.
    expect(matchesDomain({ domainId: barbaz.id }, bar.id)).toBe(false);
    expect(matchesDomain({ domainId: barbaz.id }, barbaz.id)).toBe(true);
  });
});
