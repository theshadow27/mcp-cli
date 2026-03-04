/**
 * JSON Schema → compact TypeScript notation.
 *
 * Converts JSON Schema objects (as returned by MCP tool definitions) into
 * readable TypeScript-style type strings.
 */

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema | JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  description?: string;
  default?: unknown;
  additionalProperties?: boolean | JsonSchema;
  [key: string]: unknown;
}

export interface SchemaDisplayOpts {
  /** Max recursion depth before collapsing to `{...}` (default: 3) */
  maxDepth?: number;
  /** Max properties to show before truncating (default: 10) */
  maxProps?: number;
}

const DEFAULT_OPTS: Required<SchemaDisplayOpts> = {
  maxDepth: 3,
  maxProps: 10,
};

/**
 * Convert a JSON Schema to compact TypeScript notation.
 *
 * Examples:
 *   `{ type: "string" }` → `string`
 *   `{ type: "object", properties: { id: { type: "string" } }, required: ["id"] }` → `{id: string}`
 *   `{ enum: ["a", "b"] }` → `'a' | 'b'`
 */
export function jsonSchemaToTs(schema: JsonSchema, opts?: SchemaDisplayOpts): string {
  const resolved = { ...DEFAULT_OPTS, ...opts };
  return walk(schema, resolved, 0);
}

/**
 * Format a tool name + input schema as a compact function signature.
 *
 * Example: `getConfluencePage({cloudId: string, pageId: string, contentFormat?: 'markdown' | 'adf'})`
 */
export function formatToolSignature(name: string, inputSchema: JsonSchema): string {
  const props = inputSchema.properties;
  if (!props || Object.keys(props).length === 0) {
    return `${name}()`;
  }

  const required = inputSchema.required ?? [];
  const entries = Object.entries(props);
  const parts: string[] = [];
  const maxSigProps = 8;

  for (let i = 0; i < entries.length && i < maxSigProps; i++) {
    const [key, value] = entries[i];
    const opt = required.includes(key) ? "" : "?";
    const type = walk(value, { maxDepth: 1, maxProps: 4 }, 0);
    parts.push(`${key}${opt}: ${type}`);
  }

  if (entries.length > maxSigProps) {
    parts.push(`...${entries.length - maxSigProps} more`);
  }

  return `${name}({${parts.join(", ")}})`;
}

/**
 * Format an alias name + optional input/output schemas as a compact signature.
 *
 * Example: `gf-search({query: string}): {dashboards: {name, url}[]}`
 */
export function formatAliasSignature(name: string, inputSchema?: JsonSchema, outputSchema?: JsonSchema): string {
  // Input part
  let input = "";
  if (inputSchema?.properties && Object.keys(inputSchema.properties).length > 0) {
    const required = inputSchema.required ?? [];
    const entries = Object.entries(inputSchema.properties);
    const parts: string[] = [];
    const maxSigProps = 6;
    for (let i = 0; i < entries.length && i < maxSigProps; i++) {
      const [key, value] = entries[i];
      const opt = required.includes(key) ? "" : "?";
      const type = walk(value, { maxDepth: 1, maxProps: 4 }, 0);
      parts.push(`${key}${opt}: ${type}`);
    }
    if (entries.length > maxSigProps) {
      parts.push(`...${entries.length - maxSigProps} more`);
    }
    input = `{${parts.join(", ")}}`;
  }

  // Output part
  let output = "";
  if (outputSchema) {
    const ts = walk(outputSchema, { maxDepth: 3, maxProps: 4 }, 0);
    if (ts !== "unknown") output = ts;
  }

  const sig = `${name}(${input})`;
  return output ? `${sig}: ${output}` : sig;
}

// -- Internal recursive walker --

function walk(schema: JsonSchema, opts: Required<SchemaDisplayOpts>, depth: number): string {
  // Depth guard
  if (depth > opts.maxDepth) return "{...}";

  // const value
  if (schema.const !== undefined) {
    return formatLiteral(schema.const);
  }

  // enum
  if (schema.enum) {
    return schema.enum.map(formatLiteral).join(" | ");
  }

  // allOf → intersection
  if (schema.allOf && schema.allOf.length > 0) {
    const parts = schema.allOf.map((s) => walk(s, opts, depth));
    return parts.length === 1 ? parts[0] : parts.join(" & ");
  }

  // anyOf / oneOf → union
  const unionSchemas = schema.anyOf ?? schema.oneOf;
  if (unionSchemas && unionSchemas.length > 0) {
    // Collapse `{type: X} | {type: "null"}` into `X | null`
    const parts = unionSchemas.map((s) => walk(s, opts, depth));
    return parts.length === 1 ? parts[0] : parts.join(" | ");
  }

  // Handle type as array: ["string", "null"] → string | null
  if (Array.isArray(schema.type)) {
    const parts = schema.type.map((t) => walk({ ...schema, type: t }, opts, depth));
    return parts.join(" | ");
  }

  // Typed
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return walkArray(schema, opts, depth);
    case "object":
      return walkObject(schema, opts, depth);
    default:
      break;
  }

  // No explicit type — infer from shape
  if (schema.properties) {
    return walkObject({ ...schema, type: "object" }, opts, depth);
  }
  if (schema.items) {
    return walkArray({ ...schema, type: "array" }, opts, depth);
  }

  return "unknown";
}

function walkArray(schema: JsonSchema, opts: Required<SchemaDisplayOpts>, depth: number): string {
  if (!schema.items) return "unknown[]";

  // Tuple
  if (Array.isArray(schema.items)) {
    const parts = schema.items.map((s) => walk(s, opts, depth + 1));
    return `[${parts.join(", ")}]`;
  }

  const itemType = walk(schema.items, opts, depth + 1);
  // Wrap unions in parens for readability: (string | number)[]
  if (itemType.includes(" | ") || itemType.includes(" & ")) {
    return `(${itemType})[]`;
  }
  return `${itemType}[]`;
}

function walkObject(schema: JsonSchema, opts: Required<SchemaDisplayOpts>, depth: number): string {
  if (!schema.properties || Object.keys(schema.properties).length === 0) {
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const valType = walk(schema.additionalProperties, opts, depth + 1);
      return `Record<string, ${valType}>`;
    }
    return "Record<string, unknown>";
  }

  const required = schema.required ?? [];
  const entries = Object.entries(schema.properties);
  const parts: string[] = [];

  for (let i = 0; i < entries.length && i < opts.maxProps; i++) {
    const [key, value] = entries[i];
    const opt = required.includes(key) ? "" : "?";
    const type = walk(value, opts, depth + 1);
    parts.push(`${key}${opt}: ${type}`);
  }

  if (entries.length > opts.maxProps) {
    parts.push(`...${entries.length - opts.maxProps} more`);
  }

  return `{${parts.join(", ")}}`;
}

function formatLiteral(value: unknown): string {
  if (typeof value === "string") return `'${value}'`;
  if (value === null) return "null";
  return String(value);
}
