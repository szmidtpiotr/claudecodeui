import matter from 'gray-matter';

const disabledFrontmatterEngine = () => ({});

const frontmatterOptions = {
  language: 'yaml',
  // Disable JS/JSON frontmatter parsing to avoid executable project content.
  // Mirrors Gatsby's mitigation for gray-matter.
  engines: {
    js: disabledFrontmatterEngine,
    javascript: disabledFrontmatterEngine,
    json: disabledFrontmatterEngine,
  },
};

export function parseFrontMatter(content: string) {
  return matter(content, frontmatterOptions);
}

const FRONT_MATTER_BLOCK_PATTERN = /^﻿?---\r?\n([\s\S]*?)\r?\n---\s*(?:\r?\n|$)/;
const FRONT_MATTER_SCALAR_PATTERN = /^([A-Za-z0-9_-]+):[ \t]+(\S.*)$/;

const stripScalarQuotes = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }

  return trimmed;
};

/**
 * Recovers top-level scalar fields from front matter that YAML refuses to parse.
 *
 * Hand-written skill and command files routinely put prose in `description`, and
 * an unquoted `word: word` inside that prose makes the whole document invalid
 * YAML. Strict parsing would hide the entire skill, so this fallback scans the
 * raw front matter block for simple `key: value` lines instead.
 */
export function parseFrontMatterLenient(content: string): Record<string, unknown> {
  try {
    const parsed = matter(content, frontmatterOptions);
    if (parsed.data && typeof parsed.data === 'object') {
      return parsed.data as Record<string, unknown>;
    }
  } catch {
    // Fall through to the line scan below; malformed YAML should not hide the file.
  }

  const blockMatch = content.match(FRONT_MATTER_BLOCK_PATTERN);
  if (!blockMatch) {
    return {};
  }

  const fields: Record<string, unknown> = {};
  for (const line of blockMatch[1].split(/\r?\n/)) {
    // Only top-level scalars are recovered; nested blocks and lists are skipped.
    if (/^\s/.test(line)) {
      continue;
    }

    const fieldMatch = line.match(FRONT_MATTER_SCALAR_PATTERN);
    if (!fieldMatch) {
      continue;
    }

    const value = stripScalarQuotes(fieldMatch[2]);
    if (value) {
      fields[fieldMatch[1]] = value;
    }
  }

  return fields;
}
