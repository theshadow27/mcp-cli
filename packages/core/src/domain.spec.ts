import { describe, expect, test } from "bun:test";
import {
  type Domain,
  NO_DOMAIN_ID,
  formatDomainLocation,
  isDomainScoped,
  isPathWithin,
  isValidDomainName,
  normalizeDomainPath,
  parseDomainLocation,
  resolveDomainForPath,
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
