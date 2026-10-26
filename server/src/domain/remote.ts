/**
 * Turn any git remote URL into a stable key, so that every clone of the same
 * repository resolves to the same project regardless of protocol or user.
 *
 * Azure DevOps has four URL shapes for the same repo; they all map to
 * `azure:{org}/{project}/{repo}`:
 *   https://dev.azure.com/{org}/{project}/_git/{repo}
 *   https://{user}@dev.azure.com/{org}/{project}/_git/{repo}
 *   git@ssh.dev.azure.com:v3/{org}/{project}/{repo}
 *   https://{org}.visualstudio.com[/DefaultCollection]/{project}/_git/{repo}
 *   {org}@vs-ssh.visualstudio.com:v3/{org}/{project}/{repo}
 *
 * Everything else (GitHub, GitLab, Azure DevOps Server on-prem, ...) maps to
 * `{host}/{path}` with credentials, port, `.git` and `_git/` removed.
 * Keys are lower-case because Azure DevOps and GitHub names are case-insensitive.
 */
export interface RemoteInfo {
  key: string;
  host: string;
  org?: string;
  project?: string;
  repo: string;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function clean(segments: string[]): string[] {
  return segments
    .map((s) => decode(s).trim())
    .filter((s) => s.length > 0)
    .map((s) => s.replace(/\.git$/i, ''));
}

function azure(org: string, project: string, repo: string): RemoteInfo {
  const [o, p, r] = clean([org, project, repo]);
  if (!o || !p || !r) throw new Error('Incomplete Azure DevOps remote');
  return {
    key: `azure:${o}/${p}/${r}`.toLowerCase(),
    host: 'dev.azure.com',
    org: o,
    project: p,
    repo: r,
  };
}

/** Split an scp-like (`user@host:path`) or URL remote into host + path segments. */
function splitRemote(raw: string): { host: string; segments: string[] } {
  const input = raw.trim();
  const scp = /^(?:[^@\/\s]+@)?([^:\/\s]+):(?!\/\/)(.+)$/.exec(input);
  if (scp && !/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) {
    return { host: scp[1].toLowerCase(), segments: scp[2].split('/') };
  }
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Not a git remote URL: ${raw}`);
  }
  return { host: url.hostname.toLowerCase(), segments: url.pathname.split('/') };
}

export function parseRemote(raw: string): RemoteInfo {
  if (!raw || !raw.trim()) throw new Error('Empty remote URL');
  const { host, segments: rawSegments } = splitRemote(raw);
  const segments = rawSegments.filter((s) => s.length > 0);

  if (host === 'dev.azure.com') {
    // /{org}/{project}/_git/{repo}
    const i = segments.indexOf('_git');
    if (i >= 2 && segments[i + 1]) return azure(segments[i - 2], segments[i - 1], segments[i + 1]);
  }
  if (host === 'ssh.dev.azure.com' || host === 'vs-ssh.visualstudio.com') {
    // v3/{org}/{project}/{repo}
    if (segments[0] === 'v3' && segments.length >= 4) return azure(segments[1], segments[2], segments[3]);
  }
  const vs = /^([^.]+)\.visualstudio\.com$/.exec(host);
  if (vs) {
    // [/DefaultCollection]/{project}/_git/{repo}
    const i = segments.indexOf('_git');
    if (i >= 1 && segments[i + 1]) return azure(vs[1], segments[i - 1], segments[i + 1]);
  }

  const path = clean(segments.filter((s) => s !== '_git'));
  if (path.length === 0) throw new Error(`Remote has no repository path: ${raw}`);
  return {
    key: `${host}/${path.join('/')}`.toLowerCase(),
    host,
    repo: path[path.length - 1],
  };
}

/** Like parseRemote, but returns null instead of throwing. */
export function tryParseRemote(raw: string | undefined | null): RemoteInfo | null {
  if (!raw) return null;
  try {
    return parseRemote(raw);
  } catch {
    return null;
  }
}

/** Suggest a project slug from a repo name, e.g. "Portal.Frontend" -> "portal-frontend". */
export function slugify(input: string): string {
  return input
    .replace(/æ/gi, 'ae').replace(/ø/gi, 'oe').replace(/å/gi, 'aa').replace(/ß/g, 'ss')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'project';
}
