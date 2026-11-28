import { type Rule, type TSESTree, walk } from "am-i-done";

/**
 * A fixed port in a test is a global resource. Two spec files running in parallel, or a leftover
 * server from the last run, collide on it and fail in ways that are hard to reproduce (#2013:
 * `wsPort: 19275`, ~94s of contention; also #2005, #1670, #1915, #1099). Bind port 0 and read the
 * real port back (`server.port`, `address().port`).
 *
 * Flags, in test files only:
 *   1. a nonzero literal `port` property in an object passed straight to `serve`, `listen` or
 *      `createServer` (as a call or a `new`);
 *   2. a nonzero literal first argument to `.listen(...)`;
 *   3. any variable initialised to a nonzero literal when its name has `port` as a whole word
 *      (`port`, `wsPort`, `port2`, `myHTTPPort`, `HTTP_PORT`). `transport = 8080` and
 *      `reportCount = 3` do not count.
 * A `port` field in a plain data object, a mock, an assertion argument or a client dial
 * (`connect({ port: 6379 })`) is left alone: that is a value being described, not a socket being
 * bound.
 */
const SERVER_CALLS: ReadonlySet<string> = new Set(["serve", "listen", "createServer"]);

const isFixedPort = (node: TSESTree.Node | null | undefined): node is TSESTree.NumberLiteral =>
  node?.type === "Literal" && typeof node.value === "number" && node.value !== 0;

/** `serve`, or the property of `Bun.serve` and `server.listen`. */
const calleeName = (callee: TSESTree.Node): string | undefined => {
  if (callee.type === "Identifier") return callee.name;
  if (callee.type === "MemberExpression" && !callee.computed && callee.property.type === "Identifier") {
    return callee.property.name;
  }
  return undefined;
};

/** Does `name` contain `port` as a whole word, splitting on case changes (`myHTTPPort`), underscores and digits? */
const hasPortWord = (name: string): boolean =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([A-Za-z])([0-9])|([0-9])([A-Za-z])/g, "$1$3 $2$4")
    .split(/[\s_]+/)
    .some((word) => word.toLowerCase() === "port");

const isPortProperty = (node: TSESTree.Node): node is TSESTree.Property =>
  node.type === "Property" &&
  ((node.key.type === "Identifier" && node.key.name === "port") ||
    (node.key.type === "Literal" && node.key.value === "port"));

/** The values a server call binds: `port` properties of an object argument, and `listen`'s first argument. */
function boundValues(call: TSESTree.CallExpression | TSESTree.NewExpression): TSESTree.Node[] {
  const name = calleeName(call.callee);
  if (name === undefined || !SERVER_CALLS.has(name)) return [];
  const found: TSESTree.Node[] = [];
  for (const arg of call.arguments) {
    if (arg.type !== "ObjectExpression") continue;
    for (const prop of arg.properties) if (isPortProperty(prop)) found.push(prop.value);
  }
  const [first] = call.arguments;
  if (name === "listen" && call.type === "CallExpression" && first) found.push(first);
  return found;
}

export default {
  id: "no-hardcoded-test-port",
  type: "check",
  category: "testing",
  ast: true,
  tests: "only",
  scold: "hardcoded port number in test — use port: 0 and read the OS-assigned port from the server handle",
  guidance: [
    "pass port: 0 to serve()/listen() — the OS picks a free ephemeral port",
    "read the assigned port back: `server.port` (Bun), `server.address().port` (net.Server)",
    "never invent a random-port helper — they reintroduce collision risk (Bun's guide bans them)",
    "if a fixed port is truly required (e.g. OAuth redirect-URI), add: // doing-it-wrong-ignore no-hardcoded-test-port: <reason> (#issue)",
  ],
  documentation: "#2272",
  check(ctx) {
    const lines = ctx.file.content.split("\n");
    const report = (node: TSESTree.Node) => {
      const { line, column } = node.loc.start;
      ctx.violated(line, column + 1, (lines[line - 1] ?? "").trim());
    };
    walk(ctx.ast().program, (node) => {
      if (node.type === "CallExpression" || node.type === "NewExpression") {
        for (const value of boundValues(node)) if (isFixedPort(value)) report(value);
      } else if (node.type === "VariableDeclarator" && node.id.type === "Identifier") {
        if (hasPortWord(node.id.name) && isFixedPort(node.init)) report(node.init);
      }
    });
    return ctx.checked();
  },
} satisfies Rule;
