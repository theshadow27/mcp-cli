import type { PatternRule } from "./_engine/rule";

const rule: PatternRule = {
  id: "prod-empty-catch",
  kind: "pattern",
  appliesToTests: false,
  scold: "empty catch block in production code — swallows errors silently",
  // Single-line only — relies on Biome keeping empty catch bodies on one line
  pattern: /\}\s*catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
  except: ["// dotw-ignore prod-empty-catch:", "// dotw-todo prod-empty-catch:", " * "],
  guidance: [
    "log the error: catch (e) { warn('context', e); }",
    "re-throw a typed error: catch (e) { throw new SpecificError('msg', { cause: e }); }",
    "if the catch is intentionally a no-op, add // dotw-ignore prod-empty-catch: <reason>",
  ],
  documentation: "#2496",
};

export default rule;
