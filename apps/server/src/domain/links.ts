/**
 * Obsidian-style wikilinks.
 *
 *   [[customer-portal]]              → a project (by slug or name) or, failing that, a term
 *   [[project:customer-portal]]      → only a project
 *   [[term:Order]] / [[Order]]       → a glossary term (a section heading in a Glossary document)
 *   [[customer-portal|the portal]]   → custom label
 *   [[customer-portal#Auth]]         → the "#Auth" part is kept for display but ignored for linking
 *
 * Links inside fenced code blocks and inline code are ignored.
 */
export type LinkKind = 'project' | 'term' | 'any';

export interface WikiLink {
  kind: LinkKind;
  /** Normalised target: lower-case, single spaces. */
  target: string;
  label: string;
  raw: string;
}

const LINK_RE = /\[\[([^\[\]\n|]+?)(?:\|([^\[\]\n]+?))?\]\]/g;

export function normalizeTarget(t: string): string {
  return t.trim().replace(/\s+/g, ' ').toLowerCase();
}

function stripCode(markdown: string): string {
  return markdown
    .replace(/```[\s\S]*?(```|$)/g, (m) => ' '.repeat(m.length))
    .replace(/~~~[\s\S]*?(~~~|$)/g, (m) => ' '.repeat(m.length))
    .replace(/`[^`\n]*`/g, (m) => ' '.repeat(m.length));
}

export function parseLink(inner: string, label?: string): WikiLink | null {
  let text = inner.split('#')[0].trim();
  let kind: LinkKind = 'any';
  const prefixed = /^(project|term)\s*:\s*(.+)$/i.exec(text);
  if (prefixed) {
    kind = prefixed[1].toLowerCase() as LinkKind;
    text = prefixed[2];
  }
  const target = normalizeTarget(text);
  if (!target) return null;
  return { kind, target, label: (label ?? '').trim(), raw: `[[${inner}${label ? '|' + label : ''}]]` };
}

export function extractLinks(markdown: string): WikiLink[] {
  const seen = new Map<string, WikiLink>();
  for (const m of stripCode(markdown).matchAll(LINK_RE)) {
    const link = parseLink(m[1], m[2]);
    if (!link) continue;
    const key = `${link.kind}:${link.target}`;
    if (!seen.has(key)) seen.set(key, link);
  }
  return [...seen.values()];
}

/**
 * Rewrite the targets of [[wikilinks]] outside code. `fn` gets each parsed link
 * and its target as written, and returns the new target, or null to leave it
 * alone. The `project:`/`term:` prefix, `#anchor` and `|label` are kept as written.
 */
export function rewriteLinks(markdown: string, fn: (link: WikiLink, written: string) => string | null): string {
  const masked = stripCode(markdown);
  let out = '';
  let last = 0;
  for (const m of masked.matchAll(LINK_RE)) {
    const link = parseLink(m[1], m[2]);
    if (!link) continue;
    const inner = m[1];
    const hash = inner.indexOf('#');
    const head = hash >= 0 ? inner.slice(0, hash) : inner;
    const prefix = /^\s*(?:project|term)\s*:\s*/i.exec(head)?.[0] ?? '';
    const next = fn(link, head.slice(prefix.length).trim());
    if (!next) continue;
    const rebuilt = prefix + next + (hash >= 0 ? inner.slice(hash) : '');
    const start = m.index!;
    out += markdown.slice(last, start) + `[[${rebuilt}${m[2] !== undefined ? '|' + m[2] : ''}]]`;
    last = start + m[0].length;
  }
  return out + markdown.slice(last);
}
