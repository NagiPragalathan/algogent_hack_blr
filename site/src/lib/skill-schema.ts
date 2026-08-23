/**
 * SKILL.md schema parser and validator.
 *
 * A SKILL.md is a markdown file with YAML frontmatter describing a skill
 * capability. This module:
 *   1. Parses the YAML frontmatter (name, description, trigger, version)
 *   2. Extracts required body sections (## Inputs, ## Outputs)
 *   3. Returns a validated SkillDefinition or a list of field-specific errors
 *
 * Every error is field-specific and actionable — never "invalid file".
 *
 * Required structure:
 * ---
 * name: "My Agent"
 * description: "One sentence."
 * trigger: "When to call this agent."
 * ---
 * ## Inputs
 * - `param` (string, required): description
 * ## Outputs
 * - `result` (string): description
 */

export interface SkillInput {
  name: string;
  type: string;
  required: boolean;
  description: string;
}

export interface SkillOutput {
  name: string;
  type: string;
  description: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  trigger: string;
  version: string;
  inputs: SkillInput[];
  outputs: SkillOutput[];
  dependencies: string[];
  examples: string[];
  /** Suggested agent ID derived from the name */
  suggestedId: string;
}

export interface SkillFieldError {
  field: string;
  message: string;
}

export type SkillParseResult =
  | { valid: true; parsed: SkillDefinition; warnings: string[] }
  | { valid: false; errors: SkillFieldError[]; warnings: string[] };

/** Extract the YAML frontmatter block from a markdown string */
function extractFrontmatter(content: string): {
  frontmatter: string;
  body: string;
} | null {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith("---")) return null;
  const end = trimmed.indexOf("---", 3);
  if (end === -1) return null;
  return {
    frontmatter: trimmed.slice(3, end).trim(),
    body: trimmed.slice(end + 3).trim(),
  };
}

/** Minimal YAML parser for simple key: "value" pairs */
function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const raw = line.slice(colonIdx + 1).trim();
    // Strip surrounding quotes
    const value = raw.replace(/^["']|["']$/g, "");
    if (key && value) result[key] = value;
  }
  return result;
}

/** Extract the content of a specific section (## Heading) from markdown body */
function extractSection(body: string, heading: string): string | null {
  const pattern = new RegExp(
    `^##\\s+${heading}\\s*$`,
    "im"
  );
  const match = pattern.exec(body);
  if (!match) return null;
  const start = match.index + match[0].length;
  // Find next ## heading or end of string
  const nextHeading = body.slice(start).search(/^##\s+/m);
  const end = nextHeading === -1 ? body.length : start + nextHeading;
  return body.slice(start, end).trim();
}

/** Parse a bullet list of inputs/outputs: `- \`name\` (type, required): description */
function parseBulletParams(section: string): { name: string; type: string; required: boolean; description: string }[] {
  const results: { name: string; type: string; required: boolean; description: string }[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("-")) continue;
    // Match: - `name` (type[, required]): description
    const m = trimmed.match(/^-\s+`([^`]+)`\s+\(([^)]+)\)\s*:\s*(.+)$/);
    if (m) {
      const [, name, typeRaw, description] = m;
      const parts = typeRaw.split(",").map((s) => s.trim().toLowerCase());
      const type = parts[0] ?? "string";
      const required = parts.includes("required");
      results.push({ name, type, required, description });
    } else {
      // Loose match: - name: description
      const loose = trimmed.match(/^-\s+([^:]+):\s*(.+)$/);
      if (loose) {
        results.push({
          name: loose[1].replace(/`/g, "").trim(),
          type: "string",
          required: false,
          description: loose[2].trim(),
        });
      }
    }
  }
  return results;
}

/** Convert a name to a kebab-case agent ID */
function toAgentId(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * Parse and validate a SKILL.md file content string.
 * Returns either a valid SkillDefinition or a list of field-specific errors.
 */
export function parseSkillMd(content: string): SkillParseResult {
  const errors: SkillFieldError[] = [];
  const warnings: string[] = [];

  if (!content.trim()) {
    return {
      valid: false,
      errors: [{ field: "file", message: "The file is empty." }],
      warnings,
    };
  }

  const parts = extractFrontmatter(content);
  if (!parts) {
    return {
      valid: false,
      errors: [
        {
          field: "frontmatter",
          message:
            "No YAML frontmatter found. The file must start with --- followed by name, description, and trigger fields.",
        },
      ],
      warnings,
    };
  }

  const { frontmatter, body } = parts;
  const meta = parseSimpleYaml(frontmatter);

  // --- Required frontmatter fields ---
  if (!meta.name?.trim()) {
    errors.push({
      field: "name",
      message: 'Missing required frontmatter field: name: "Your Agent Name"',
    });
  }
  if (!meta.description?.trim()) {
    errors.push({
      field: "description",
      message: 'Missing required frontmatter field: description: "One sentence about what it does."',
    });
  }
  if (!meta.trigger?.trim()) {
    errors.push({
      field: "trigger",
      message: 'Missing required frontmatter field: trigger: "When this agent should be called."',
    });
  }

  // --- Required body sections ---
  const inputsSection = extractSection(body, "Inputs");
  const outputsSection = extractSection(body, "Outputs");

  if (inputsSection === null) {
    errors.push({
      field: "inputs",
      message:
        "Missing required ## Inputs section. Add a section like:\n## Inputs\n- `param` (string, required): description",
    });
  }
  if (outputsSection === null) {
    errors.push({
      field: "outputs",
      message:
        "Missing required ## Outputs section. Add a section like:\n## Outputs\n- `result` (string): description",
    });
  }

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // --- Parse optional sections ---
  const dependenciesSection = extractSection(body, "Dependencies");
  const examplesSection = extractSection(body, "Examples");

  const inputs = parseBulletParams(inputsSection!);
  const outputs = parseBulletParams(outputsSection!);

  if (inputs.length === 0) {
    warnings.push(
      "## Inputs section found but no parameters parsed. Add bullet items like: - `param` (string, required): description"
    );
  }
  if (outputs.length === 0) {
    warnings.push(
      "## Outputs section found but no outputs parsed. Add bullet items like: - `result` (string): description"
    );
  }

  const dependencies: string[] = [];
  if (dependenciesSection) {
    for (const line of dependenciesSection.split("\n")) {
      const dep = line.replace(/^[-*]\s*/, "").trim();
      if (dep) dependencies.push(dep);
    }
  }

  const examples: string[] = [];
  if (examplesSection) {
    for (const line of examplesSection.split("\n")) {
      const ex = line.replace(/^[-*]\s*/, "").trim();
      if (ex) examples.push(ex);
    }
  }

  if (!meta.version) {
    warnings.push('No version specified in frontmatter. Add version: "1.0.0" for versioning support.');
  }

  const parsed: SkillDefinition = {
    name: meta.name.trim(),
    description: meta.description.trim(),
    trigger: meta.trigger.trim(),
    version: meta.version?.trim() ?? "1.0.0",
    inputs,
    outputs,
    dependencies,
    examples,
    suggestedId: toAgentId(meta.name),
  };

  return { valid: true, parsed, warnings };
}
