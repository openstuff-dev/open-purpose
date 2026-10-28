import { describe, expect, it } from 'vitest';
import { excerpt } from '../src/service/context.js';
import { parseRemote, slugify } from '../src/domain/remote.js';
import { detectStacks } from '../src/domain/stacks.js';
import { matchScopes, mostSpecific, normalizePath } from '../src/domain/scopes.js';
import { extractLinks, rewriteLinks } from '../src/domain/links.js';

describe('parseRemote', () => {
  const key = 'azure:acme/big project/portal-frontend';
  it.each([
    'https://dev.azure.com/acme/Big%20Project/_git/portal-frontend',
    'https://jonas@dev.azure.com/acme/Big%20Project/_git/portal-frontend',
    'https://dev.azure.com/acme/Big%20Project/_git/portal-frontend/',
    'git@ssh.dev.azure.com:v3/acme/Big%20Project/portal-frontend',
    'https://acme.visualstudio.com/Big%20Project/_git/portal-frontend',
    'https://acme.visualstudio.com/DefaultCollection/Big%20Project/_git/portal-frontend',
    'acme@vs-ssh.visualstudio.com:v3/acme/Big%20Project/portal-frontend',
    'https://dev.azure.com/ACME/Big%20Project/_git/Portal-Frontend',
  ])('maps %s to the same key', (url) => {
    expect(parseRemote(url).key).toBe(key);
  });

  it('keeps org, project and repo', () => {
    expect(parseRemote('git@ssh.dev.azure.com:v3/acme/Big%20Project/portal-frontend')).toMatchObject({
      org: 'acme', project: 'Big Project', repo: 'portal-frontend',
    });
  });

  it.each([
    ['https://github.com/acme/api.git', 'github.com/acme/api'],
    ['git@github.com:acme/api.git', 'github.com/acme/api'],
    ['ssh://git@gitlab.corp:2222/team/sub/api.git', 'gitlab.corp/team/sub/api'],
    ['https://tfs.corp/tfs/DefaultCollection/Proj/_git/Api', 'tfs.corp/tfs/defaultcollection/proj/api'],
  ])('generic remote %s', (url, expected) => {
    expect(parseRemote(url).key).toBe(expected);
  });

  it('rejects garbage', () => {
    expect(() => parseRemote('not a url')).toThrow();
    expect(() => parseRemote('')).toThrow();
  });

  it('slugifies', () => {
    expect(slugify('Portal.Frontend (v2)')).toBe('portal-frontend-v2');
    expect(slugify('Kundeportal Østjylland')).toBe('kundeportal-oestjylland');
    expect(slugify('Café Gåsetårn')).toBe('cafe-gaasetaarn');
  });
});

describe('detectStacks', () => {
  it('detects an Angular frontend', () => {
    const tags = detectStacks([{ path: 'frontend/package.json', content: JSON.stringify({
      dependencies: { '@angular/core': '^20.0.0', rxjs: '^7' }, devDependencies: { typescript: '^5' },
    }) }]);
    expect(tags).toEqual(['angular', 'frontend', 'node', 'rxjs', 'typescript']);
  });

  it('detects an ASP.NET Core backend with EF Core', () => {
    const tags = detectStacks([{ path: 'src/Api/Api.csproj', content: `<Project Sdk="Microsoft.NET.Sdk.Web">
      <ItemGroup><PackageReference Include="Microsoft.EntityFrameworkCore.SqlServer" Version="9.0.0" /></ItemGroup>
    </Project>` }]);
    expect(tags).toEqual(['aspnetcore', 'backend', 'csharp', 'dotnet', 'efcore']);
  });

  it('handles Windows paths and broken JSON', () => {
    expect(detectStacks([{ path: 'web\\package.json', content: '{oops' }])).toEqual(['node']);
  });
});

describe('matchScopes', () => {
  const scopes = [
    { id: '1', slug: 'frontend', name: 'Frontend', project_id: 'p', path_globs: ['frontend/**'], stacks: [] },
    { id: '2', slug: 'backend', name: 'Backend', project_id: 'p', path_globs: ['backend/**', 'src/Api/**'], stacks: [] },
    { id: '3', slug: 'angular', name: 'Angular', project_id: null, path_globs: [], stacks: ['angular'] },
    { id: '4', slug: 'dotnet', name: '.NET', project_id: null, path_globs: [], stacks: ['dotnet'] },
  ];

  it('matches by path and by stack', () => {
    const m = matchScopes(scopes, { path: 'frontend/src/app/editor.ts', stacks: ['Angular', 'frontend'] });
    expect(m.map((x) => x.scope.slug)).toEqual(['frontend', 'angular']);
  });

  it('keeps frontend rules away from backend code', () => {
    const m = matchScopes(scopes, { path: 'src\\Api\\Controllers\\Orders.cs', stacks: ['dotnet'] });
    expect(m.map((x) => x.scope.slug)).toEqual(['backend', 'dotnet']);
  });

  it('matches the folder itself', () => {
    expect(matchScopes(scopes, { path: './frontend/' }).map((x) => x.scope.slug)).toEqual(['frontend']);
  });

  it('picks the most specific scope for learnings', () => {
    const m = matchScopes(scopes, { path: 'frontend/x.ts', stacks: ['angular'] });
    expect(mostSpecific(m)?.slug).toBe('frontend');
    expect(mostSpecific(matchScopes(scopes, { stacks: ['angular'] }))?.slug).toBe('angular');
    expect(mostSpecific([])).toBeNull();
  });

  describe('bound to repositories', () => {
    const web = { id: 'r-web', key: 'github.com/acme/portal-web' };
    const api = { id: 'r-api', key: 'github.com/acme/portal-api' };
    const bound = [
      { id: '5', slug: 'angular-app', name: 'Angular app', project_id: 'p', path_globs: [], stacks: [], repository_ids: [web.id] },
      { id: '6', slug: 'dotnet-api', name: '.NET API', project_id: 'p', path_globs: [], stacks: [], repository_ids: [api.id] },
      { id: '7', slug: 'api-tests', name: 'API tests', project_id: 'p', path_globs: ['tests/**'], stacks: [], repository_ids: [api.id] },
      ...scopes,
    ];

    it('covers the whole repository when it has no paths or stacks', () => {
      const m = matchScopes(bound, { path: 'src/app/app.ts', repository: web });
      expect(m.map((x) => x.scope.slug)).toEqual(['angular-app']);
      expect(m[0].reason).toBe('repository "github.com/acme/portal-web"');
    });

    it('narrows to its paths inside the repository', () => {
      expect(matchScopes(bound, { path: 'src/Program.cs', repository: api }).map((x) => x.scope.slug)).toEqual(['dotnet-api']);
      expect(matchScopes(bound, { path: 'tests/OrderTests.cs', repository: api }).map((x) => x.scope.slug)).toEqual(['dotnet-api', 'api-tests']);
      expect(matchScopes(bound, { path: 'tests/app.spec.ts', repository: web }).map((x) => x.scope.slug)).toEqual(['angular-app']);
    });

    it('never matches without a known repository, but folder scopes still do', () => {
      expect(matchScopes(bound, { path: 'frontend/x.ts' }).map((x) => x.scope.slug)).toEqual(['frontend']);
      expect(matchScopes(bound, { explicit: ['dotnet-api'] }).map((x) => x.scope.slug)).toEqual(['dotnet-api']);
    });

    it('beats unbound scopes for learnings', () => {
      expect(mostSpecific(matchScopes(bound, { path: 'frontend/x.ts', repository: web }))?.slug).toBe('angular-app');
    });
  });

  it('normalises paths', () => {
    expect(normalizePath('.\\frontend\\src\\')).toBe('frontend/src');
    expect(normalizePath('/a/b')).toBe('a/b');
  });
});

describe('extractLinks', () => {
  it('finds wikilinks with prefixes, labels and anchors', () => {
    const links = extractLinks('Uses [[billing-service]] and [[term:Order]], see [[Customer Portal|the portal]] and [[billing-service#Auth]].');
    expect(links).toEqual([
      { kind: 'any', target: 'billing-service', label: '', raw: '[[billing-service]]' },
      { kind: 'term', target: 'order', label: '', raw: '[[term:Order]]' },
      { kind: 'any', target: 'customer portal', label: 'the portal', raw: '[[Customer Portal|the portal]]' },
    ]);
  });

  it('ignores code', () => {
    expect(extractLinks('`[[a]]`\n```\n[[b]]\n```\n[[c]]').map((l) => l.target)).toEqual(['c']);
  });
});

describe('rewriteLinks', () => {
  const rename = (from: string, to: string) => (l: { target: string }) => (l.target === from ? to : null);

  it('keeps prefixes, anchors and labels', () => {
    expect(rewriteLinks('[[billing]], [[Project: Billing#Auth|the bill]] and [[billing-v2]]', rename('billing', 'payments')))
      .toBe('[[payments]], [[Project: payments#Auth|the bill]] and [[billing-v2]]');
  });

  it('ignores code', () => {
    expect(rewriteLinks('`[[a]]`\n```\n[[a]]\n```\n[[a]]', rename('a', 'b'))).toBe('`[[a]]`\n```\n[[a]]\n```\n[[b]]');
  });

  it('leaves text untouched when nothing matches', () => {
    const md = 'See [[Customer Portal]].';
    expect(rewriteLinks(md, rename('customer-portal', 'portal'))).toBe(md);
  });
});

describe('zip', () => {
  it('reads back what it writes, unpacking only the files asked for', async () => {
    const { readZip, writeZip } = await import('../src/domain/zip.js');
    const zip = writeZip([
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      { name: 'æøå/doc.md', data: Buffer.from('# Ærlig\n'.repeat(1000)) },
      { name: 'skip.txt', data: Buffer.from('no') },
    ]);
    const files = readZip(zip, (n) => n !== 'skip.txt', 1024 * 1024);
    expect(files.map((f) => [f.name, f.data.length])).toEqual([['manifest.json', 7], ['æøå/doc.md', 9000]]);
    expect(files[1].data.toString('utf8').startsWith('# Ærlig')).toBe(true);
    expect(() => readZip(zip, () => true, 100)).toThrow();
    expect(() => readZip(Buffer.from('not a zip at all, really'), () => true, 100)).toThrow('not a readable zip file');
  });
});

describe('excerpt', () => {
  const id = '0123456789abcdef';
  it('keeps the first sentence and points to the rest', () => {
    expect(excerpt({ id, body: 'Amounts are integer øre, e.g. 100 for 1 kr. Never floats.\n\nMore here.' }))
      .toBe('Amounts are integer øre, e.g. 100 for 1 kr. … _(4 more words: `read_section s:01234567`)_');
  });
  it('skips headings, fences and list markers', () => {
    expect(excerpt({ id, body: '## Why\n\n```ts\nconst x = 1;\n```\n\n- Use signals. Not zones.' }))
      .toMatch(/^Use signals\. … /);
  });
  it('cuts a long sentence at a word', () => {
    const lead = excerpt({ id, body: 'word '.repeat(100) }).split(' … ')[0];
    expect(lead.length).toBeLessThanOrEqual(200);
    expect(lead.endsWith('word')).toBe(true);
  });
  it('handles an empty body', () => {
    expect(excerpt({ id, body: '' })).toBe('_(0 more words: `read_section s:01234567`)_');
  });
});
