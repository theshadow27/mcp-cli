/**
 * MCP tool definitions for the `_site` virtual server.
 *
 * Single source of truth — both the worker (registers these) and the daemon
 * (pre-populates the ServerPool tool cache so `mcx ls` works before the
 * worker has booted) import this list.
 */

export interface SiteToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<
      string,
      { type: string; description?: string; items?: unknown; properties?: unknown; enum?: string[] }
    >;
    required?: string[];
  };
}

export const SITE_TOOLS: SiteToolDef[] = [
  {
    name: "site_list",
    description: "List all configured sites, including built-in seeds and user-configured sites.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "site_show",
    description: "Show the merged config for a single site.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", description: "Site name" } },
      required: ["name"],
    },
  },
  {
    name: "site_add",
    description:
      "Create or update a site. Only the supplied fields are written; existing fields are preserved. " +
      "Required on first creation: url and domains.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Site name (filesystem-safe identifier)" },
        url: { type: "string", description: "Landing URL the browser should open" },
        domains: {
          type: "array",
          items: { type: "string" },
          description: "Hostname glob patterns for credential routing",
        },
        enabled: { type: "boolean", description: "Defaults to true" },
        captureMode: { type: "string", enum: ["off", "filtered", "firehose"] },
        blockProtocols: {
          type: "array",
          items: { type: "string" },
          description: "Custom protocols to block (e.g. msteams://)",
        },
        browserEngine: {
          type: "string",
          enum: ["playwright", "webview"],
          description: "Browser engine. Defaults to playwright.",
        },
        chromeProfile: { type: "string", description: "Profile directory name. Defaults to 'default'." },
        wiggle: { type: "string", description: "Path (relative to site dir) to a wiggle.js keep-alive module" },
        seed: { type: "string", description: "Built-in seed name to inherit from" },
      },
      required: ["name"],
    },
  },
  {
    name: "site_remove",
    description: "Remove a user-configured site (does not delete built-in seeds).",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "site_calls",
    description: "List named HTTP calls configured for a site's catalog.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
      required: ["site"],
    },
  },
  {
    name: "site_describe",
    description: "Show the full definition of a single named call.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" }, call: { type: "string" } },
      required: ["site", "call"],
    },
  },
  {
    name: "site_call",
    description:
      "Invoke a named HTTP call through the credential proxy. The browser must be running " +
      "and have authenticated at least once for this site's origin. Returns the response body and metadata.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        call: { type: "string" },
        params: {
          type: "object",
          description:
            "URL/query/body parameters; :foo in the URL is substituted first, residuals go to query or JSON body",
        },
        body: { type: "string", description: "Raw body string (overrides residual body construction)" },
      },
      required: ["site", "call"],
    },
  },
  {
    name: "site_add_call",
    description: "Add or update a named call in a site's catalog.",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        name: { type: "string" },
        url: { type: "string", description: "Template URL, e.g. https://api.x.com/v1/things/:id" },
        method: { type: "string", description: "HTTP method; defaults to GET" },
        description: { type: "string" },
        headers: { type: "object" },
        audHints: {
          type: "array",
          items: { type: "string" },
          description: "Substrings to prefer when selecting a credential by aud",
        },
      },
      required: ["site", "name", "url"],
    },
  },
  {
    name: "site_remove_call",
    description: "Remove a named call from a site's catalog.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" }, call: { type: "string" } },
      required: ["site", "call"],
    },
  },
  {
    name: "site_browser_start",
    description:
      "Launch the browser and open a tab per configured site so the user can complete login. " +
      "Idempotent — subsequent calls return the running state. Lazily loads Playwright.",
    inputSchema: {
      type: "object",
      properties: {
        sites: {
          type: "array",
          items: { type: "string" },
          description: "Site names to open; defaults to all enabled sites",
        },
      },
    },
  },
  {
    name: "site_disconnect",
    description: "Stop the running browser and release its resources.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "site_sniff",
    description:
      "Control and inspect API capture. Without mode, returns recent requests/responses for the given site. " +
      "With mode, updates the capture mode (off | filtered | firehose).",
    inputSchema: {
      type: "object",
      properties: {
        site: { type: "string" },
        mode: { type: "string", enum: ["off", "filtered", "firehose"] },
        filter: { type: "string", description: "Regex to filter recent records by URL" },
        limit: { type: "number", description: "Max records to return per kind (default 50)" },
      },
      required: ["site"],
    },
  },
  {
    name: "site_wiggle",
    description: "Run the site's wiggle.js keep-alive script in the browser page.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
  {
    name: "site_eval",
    description: "Evaluate a JavaScript expression in the site's page context.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" }, code: { type: "string" } },
      required: ["code"],
    },
  },
  {
    name: "site_cold_start",
    description: "Clear non-cookie storage for a site's origin and reload the page.",
    inputSchema: {
      type: "object",
      properties: { site: { type: "string" } },
    },
  },
];

/** Set of valid tool names — used by the worker to reject unknown tool calls fast. */
export const SITE_TOOL_NAMES: ReadonlySet<string> = new Set(SITE_TOOLS.map((t) => t.name));
