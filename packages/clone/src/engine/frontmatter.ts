/**
 * Frontmatter injection and stripping for markdown files.
 *
 * Adds YAML frontmatter with provider metadata to local markdown files,
 * and strips it before pushing content back to the remote.
 */

/** Inject YAML frontmatter into markdown content. */
export function injectFrontmatter(content: string, fields: Record<string, unknown>): string {
  const yaml = toYaml(fields);
  // Strip existing frontmatter if present, then prepend new
  const stripped = stripFrontmatter(content);
  return `---\n${yaml}---\n\n${stripped.content}`;
}

/** Check if a file has VFS frontmatter (contains an `id` field). */
export function hasFrontmatter(content: string): boolean {
  const { fields } = stripFrontmatter(content);
  return fields != null && "id" in fields;
}

/** Strip YAML frontmatter from markdown content. */
export function stripFrontmatter(content: string): { content: string; fields: Record<string, unknown> | null } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/);
  if (!match) return { content, fields: null };

  const yamlBlock = match[1];
  const body = match[2];
  const fields = fromYaml(yamlBlock);
  return { content: body, fields };
}

/** Simple YAML serializer for flat/shallow objects. No dependency needed. */
function toYaml(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.map((v) => formatYamlValue(v)).join(", ")}]`);
    } else {
      lines.push(`${key}: ${formatYamlValue(value)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function formatYamlValue(value: unknown): string {
  if (typeof value === "string") {
    // Quote strings that contain special YAML characters or look like numbers/booleans
    if (
      /[:#\[\]{},&*!|>'"%@`]/.test(value) ||
      value.includes("\n") ||
      value.trim() !== value ||
      /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(value) ||
      value === "true" ||
      value === "false"
    ) {
      return JSON.stringify(value);
    }
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** Simple YAML parser for the subset we generate. */
function fromYaml(yaml: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      result[key] = "";
      continue;
    }

    // Inline array: [a, b, c]
    if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
      const inner = rawValue.slice(1, -1);
      result[key] = inner ? inner.split(",").map((v) => parseYamlScalar(v.trim())) : [];
      continue;
    }

    result[key] = parseYamlScalar(rawValue);
  }
  return result;
}

function parseYamlScalar(value: string): string | number | boolean {
  // Quoted string
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  // Boolean
  if (value === "true") return true;
  if (value === "false") return false;
  // Number
  const num = Number(value);
  if (!Number.isNaN(num) && value !== "") return num;
  // Plain string
  return value;
}
