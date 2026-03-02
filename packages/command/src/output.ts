/**
 * Output formatting for CLI results.
 *
 * JSON to stdout (pipeable), errors/status to stderr.
 */

const isTTY = process.stdout.isTTY && !process.env.NO_COLOR;

const c = {
  reset: isTTY ? "\x1b[0m" : "",
  bold: isTTY ? "\x1b[1m" : "",
  dim: isTTY ? "\x1b[2m" : "",
  red: isTTY ? "\x1b[31m" : "",
  green: isTTY ? "\x1b[32m" : "",
  yellow: isTTY ? "\x1b[33m" : "",
  cyan: isTTY ? "\x1b[36m" : "",
};

/** Format and print a tool call result to stdout */
export function printToolResult(result: unknown): void {
  if (result === null || result === undefined) return;

  // MCP tool results have a content[] array
  if (typeof result === "object" && "content" in (result as Record<string, unknown>)) {
    const { content } = result as { content: Array<{ type: string; text?: string }> };
    if (Array.isArray(content)) {
      for (const item of content) {
        if (item.type === "text" && item.text) {
          printJson(item.text);
        } else {
          console.log(JSON.stringify(item, null, 2));
        }
      }
      return;
    }
  }

  // Fallback: print as JSON
  console.log(JSON.stringify(result, null, 2));
}

/** Try to pretty-print as JSON, fallback to raw text */
function printJson(text: string): void {
  try {
    console.log(JSON.stringify(JSON.parse(text), null, 2));
  } catch {
    console.log(text);
  }
}

/** Print a server list in compact format */
export function printServerList(
  servers: Array<{
    name: string;
    transport: string;
    state: string;
    toolCount: number;
    source: string;
  }>,
): void {
  if (servers.length === 0) {
    console.error("No MCP servers configured.");
    return;
  }

  const maxName = Math.max(...servers.map((s) => s.name.length));

  for (const s of servers) {
    const stateColor = s.state === "connected" ? c.green : s.state === "error" ? c.red : c.dim;
    console.log(
      `  ${c.cyan}${s.name.padEnd(maxName)}${c.reset}  ${stateColor}${s.state.padEnd(12)}${c.reset}  ${c.dim}${s.transport}${c.reset}  ${s.toolCount > 0 ? `${s.toolCount} tools` : ""}`,
    );
  }
  console.log(`\n${servers.length} server(s)`);
}

/** Print a tool list in compact format */
export function printToolList(
  tools: Array<{
    name: string;
    server: string;
    description: string;
  }>,
): void {
  if (tools.length === 0) {
    console.error("No tools found.");
    return;
  }

  const maxName = Math.max(...tools.map((t) => t.name.length));
  const maxServer = Math.max(...tools.map((t) => t.server.length));

  for (const t of tools) {
    const desc = t.description.length > 80 ? `${t.description.slice(0, 77)}...` : t.description;
    console.log(
      `  ${c.green}${t.name.padEnd(maxName)}${c.reset}  ${c.dim}${t.server.padEnd(maxServer)}${c.reset}  ${desc}`,
    );
  }
  console.log(`\n${tools.length} tool(s)`);
}

/** Print a single tool's schema info */
export function printToolInfo(tool: {
  name: string;
  server: string;
  description: string;
  inputSchema: Record<string, unknown>;
  signature?: string;
}): void {
  console.log(`${c.bold}${tool.server}/${tool.name}${c.reset}`);
  if (tool.description) {
    console.log(`${c.dim}${tool.description}${c.reset}\n`);
  }

  if (tool.signature) {
    console.log(`${c.cyan}${tool.signature}${c.reset}\n`);
  }

  // Print input schema as compact TS-like notation
  const props = (tool.inputSchema as { properties?: Record<string, SchemaProperty> }).properties;
  const required = (tool.inputSchema as { required?: string[] }).required ?? [];

  if (props) {
    console.log("Parameters:");
    for (const [name, schema] of Object.entries(props)) {
      const isRequired = required.includes(name);
      const typeStr = schemaToTypeString(schema);
      const optMark = isRequired ? "" : "?";
      const desc = schema.description ? `  ${c.dim}// ${schema.description}${c.reset}` : "";
      console.log(`  ${c.yellow}${name}${optMark}${c.reset}: ${typeStr}${desc}`);
    }
  }
}

interface SchemaProperty {
  type?: string;
  enum?: unknown[];
  description?: string;
  items?: SchemaProperty;
  properties?: Record<string, SchemaProperty>;
  default?: unknown;
}

/** Convert a JSON Schema property to a compact TypeScript type string */
function schemaToTypeString(schema: SchemaProperty): string {
  if (schema.enum) {
    return schema.enum.map((v) => JSON.stringify(v)).join(" | ");
  }
  switch (schema.type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return schema.items ? `${schemaToTypeString(schema.items)}[]` : "unknown[]";
    case "object":
      if (schema.properties) {
        const entries = Object.entries(schema.properties)
          .map(([k, v]) => `${k}: ${schemaToTypeString(v)}`)
          .join("; ");
        return `{ ${entries} }`;
      }
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
}

/** Print an error to stderr */
export function printError(message: string): void {
  console.error(`${c.red}Error${c.reset}: ${message}`);
}
