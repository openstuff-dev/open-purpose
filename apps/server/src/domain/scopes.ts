import picomatch from 'picomatch';
import { normalizeTags } from './stacks.js';

export interface ScopeRule {
  id: string;
  slug: string;
  name: string;
  project_id: string | null;
  path_globs: string[];
  stacks: string[];
  /** Repositories the scope is bound to. Empty = any repository of the project. */
  repository_ids?: string[];
  /** Old slugs, still accepted when a scope is requested explicitly. */
  aliases?: string[];
}

export interface ScopeMatch<T extends ScopeRule = ScopeRule> {
  scope: T;
  /** Human-readable reason, e.g. 'path "frontend/**"' or 'stack "angular"'. */
  reason: string;
}

/** Normalise a repo-relative path from any OS: backslashes, leading "./" or "/", trailing "/". */
export function normalizePath(p: string | undefined | null): string {
  if (!p) return '';
  return p
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '');
}

function globMatches(glob: string, path: string): boolean {
  const g = normalizePath(glob);
  if (!g || !path) return false;
  const opts = { dot: true, nocase: true };
  if (picomatch.isMatch(path, g, opts)) return true;
  // "frontend/**" should also match the folder "frontend" itself.
  if (g.endsWith('/**') && picomatch.isMatch(path, g.slice(0, -3), opts)) return true;
  return false;
}

/**
 * A scope applies when ANY of its path globs matches the path, or ANY of its
 * stack tags is among the caller's stacks. A scope bound to repositories only
 * applies inside one of them, and covers the whole repository when it has no
 * paths or stacks. A scope with none of these never matches implicitly (it can
 * still be requested by slug).
 */
export function matchScopes<T extends ScopeRule>(
  scopes: T[],
  input: {
    path?: string | null;
    stacks?: string[];
    explicit?: string[];
    repository?: { id: string; key: string } | null;
  },
): ScopeMatch<T>[] {
  const path = normalizePath(input.path);
  const stacks = new Set(normalizeTags(input.stacks ?? []));
  const explicit = new Set((input.explicit ?? []).map((s) => s.toLowerCase()));
  const out: ScopeMatch<T>[] = [];
  for (const scope of scopes) {
    if (explicit.has(scope.slug)) {
      out.push({ scope, reason: 'requested explicitly' });
      continue;
    }
    const old = scope.aliases?.find((s) => explicit.has(s));
    if (old) {
      out.push({
        scope,
        reason: `requested explicitly by its old slug "${old}"; use "${scope.slug}"`,
      });
      continue;
    }
    const repos = scope.repository_ids ?? [];
    let where = '';
    if (repos.length) {
      if (!input.repository || !repos.includes(input.repository.id)) continue;
      if (!scope.path_globs.length && !scope.stacks.length) {
        out.push({ scope, reason: `repository "${input.repository.key}"` });
        continue;
      }
      where = ` in repository "${input.repository.key}"`;
    }
    const glob = scope.path_globs.find((g) => globMatches(g, path));
    if (glob) {
      out.push({ scope, reason: `path "${glob}"${where}` });
      continue;
    }
    const tag = scope.stacks.map((s) => s.toLowerCase()).find((s) => stacks.has(s));
    if (tag) out.push({ scope, reason: `stack "${tag}"${where}` });
  }
  return out;
}

/**
 * Pick the single most specific scope for filing a new learning:
 * project scopes beat org scopes, scopes bound to the repository beat unbound
 * ones, path matches beat stack matches, and longer (more specific) globs beat
 * shorter ones.
 */
export function mostSpecific<T extends ScopeRule>(matches: ScopeMatch<T>[]): T | null {
  let best: { scope: T; score: number } | null = null;
  for (const m of matches) {
    let score = 0;
    if (m.scope.project_id) score += 1000;
    if (m.reason.startsWith('requested')) score += 500;
    if (m.scope.repository_ids?.length) score += 200;
    if (m.reason.startsWith('path')) score += 100 + m.reason.length;
    if (m.reason.startsWith('stack')) score += 50;
    if (!best || score > best.score) best = { scope: m.scope, score };
  }
  return best?.scope ?? null;
}
