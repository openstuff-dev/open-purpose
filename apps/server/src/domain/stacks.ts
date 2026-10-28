/**
 * Stack detection from manifest files, so that every agent tags code the same
 * way ("angular", not "Angular 18" or "ng"). Agents send the manifest nearest to
 * the code they are touching (package.json, *.csproj, ...) and get tags back.
 */
export interface Manifest {
  /** Path of the manifest relative to the repo root, e.g. "frontend/package.json". */
  path: string;
  content: string;
}

const NPM_TAGS: [pkg: string | RegExp, tags: string[]][] = [
  ['@angular/core', ['angular', 'frontend']],
  ['react', ['react', 'frontend']],
  ['next', ['nextjs', 'react', 'frontend']],
  ['vue', ['vue', 'frontend']],
  ['nuxt', ['nuxt', 'vue', 'frontend']],
  ['svelte', ['svelte', 'frontend']],
  ['@nestjs/core', ['nestjs', 'backend']],
  ['express', ['express', 'backend']],
  ['fastify', ['fastify', 'backend']],
  ['typescript', ['typescript']],
  ['@ngrx/store', ['ngrx']],
  ['rxjs', ['rxjs']],
  ['tailwindcss', ['tailwind']],
  ['jest', ['jest']],
  ['vitest', ['vitest']],
  ['@playwright/test', ['playwright']],
];

const NUGET_TAGS: [pkg: RegExp, tags: string[]][] = [
  [/^Microsoft\.EntityFrameworkCore/i, ['efcore']],
  [/^Microsoft\.AspNetCore\.Components/i, ['blazor', 'frontend']],
  [/^MediatR$/i, ['mediatr']],
  [/^xunit/i, ['xunit', 'tests']],
  [/^NUnit/i, ['nunit', 'tests']],
  [/^MSTest/i, ['mstest', 'tests']],
  [/^Azure\.Functions|^Microsoft\.Azure\.Functions/i, ['azure-functions', 'backend']],
  [/^Microsoft\.Azure\.WebJobs/i, ['azure-functions', 'backend']],
];

export function normalizeTag(tag: string): string {
  return tag
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9+#.]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function normalizeTags(tags: Iterable<string>): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const n = normalizeTag(t);
    if (n) out.add(n);
  }
  return [...out].sort();
}

function fromPackageJson(content: string): string[] {
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return ['node'];
  }
  const deps = {
    ...(pkg.dependencies as Record<string, string> | undefined),
    ...(pkg.devDependencies as Record<string, string> | undefined),
    ...(pkg.peerDependencies as Record<string, string> | undefined),
  };
  const names = Object.keys(deps);
  const tags = ['node'];
  for (const [match, add] of NPM_TAGS) {
    if (names.some((n) => (typeof match === 'string' ? n === match : match.test(n))))
      tags.push(...add);
  }
  return tags;
}

function fromCsproj(content: string): string[] {
  const tags = ['dotnet', 'csharp'];
  const sdk = /<Project[^>]*\sSdk="([^"]+)"/i.exec(content)?.[1] ?? '';
  if (/Microsoft\.NET\.Sdk\.Web/i.test(sdk)) tags.push('aspnetcore', 'backend');
  if (/Microsoft\.NET\.Sdk\.BlazorWebAssembly/i.test(sdk)) tags.push('blazor', 'frontend');
  if (/Microsoft\.NET\.Sdk\.Worker/i.test(sdk)) tags.push('worker', 'backend');
  if (/Microsoft\.NET\.Sdk\.Razor/i.test(sdk)) tags.push('razor');
  const refs = [...content.matchAll(/<PackageReference[^>]*Include="([^"]+)"/gi)].map((m) => m[1]);
  for (const [match, add] of NUGET_TAGS) {
    if (refs.some((r) => match.test(r))) tags.push(...add);
  }
  if (/<IsTestProject>\s*true/i.test(content)) tags.push('tests');
  return tags;
}

export function detectStacks(manifests: Manifest[]): string[] {
  const tags: string[] = [];
  for (const m of manifests) {
    const file = m.path.replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
    if (file === 'package.json') tags.push(...fromPackageJson(m.content));
    else if (file.endsWith('.csproj')) tags.push(...fromCsproj(m.content));
    else if (file.endsWith('.fsproj')) tags.push('dotnet', 'fsharp');
    else if (file.endsWith('.sln') || file === 'directory.build.props' || file === 'global.json')
      tags.push('dotnet');
    else if (file === 'go.mod') tags.push('go');
    else if (file === 'pyproject.toml' || file === 'requirements.txt') tags.push('python');
    else if (file === 'pom.xml' || file === 'build.gradle' || file === 'build.gradle.kts')
      tags.push('java');
    else if (file === 'cargo.toml') tags.push('rust');
    else if (file === 'angular.json') tags.push('angular', 'frontend');
    else if (file === 'dockerfile') tags.push('docker');
    else if (file.endsWith('.bicep')) tags.push('bicep', 'infrastructure');
    else if (file.endsWith('.tf')) tags.push('terraform', 'infrastructure');
  }
  return normalizeTags(tags);
}
