import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "no-as-any",
  kind: "pattern",
  appliesToTests: false,
  scold: "`as any` cast in production code — defeats TypeScript's type system",
  // Line-level regex — matches inside string literals and comments (see #2534 for engine-level fix)
  pattern: /\bas\s+any\b/,
  except: ["// dotw-ignore no-as-any:", "// dotw-todo no-as-any:"],
  guidance: [
    "narrow to a concrete type: `as SomeType`, `as unknown as SomeType`, or a Zod parse",
    "if the type really is unknowable, use `unknown` and narrow with a type guard",
    "false positive in a string/comment? suppress with `// dotw-ignore no-as-any: in string literal` (#2534)",
  ],
  documentation: "#2496",
};

export default rule;
