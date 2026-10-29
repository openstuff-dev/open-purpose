/**
 * An export as a folder of Markdown files, zipped with the export itself as
 * manifest.json. Imports read only manifest.json; the Markdown is for people.
 */
import { readZip, writeZip } from '../../domain/zip.js';
import { AppError } from '../../errors.js';
import type { ExportDocument, ExportFile } from '@openpurpose/contracts';

const MANIFEST = 'manifest.json';

const README = `# OpenPurpose export

Every document is a Markdown file, in a folder per organization, project and scope.
\`workspace/\` holds workspace-wide content.

To import this into OpenPurpose, use Settings › Export and import. The import reads
only \`manifest.json\`; changes to the Markdown files are not imported.
`;

function documentMarkdown(d: ExportDocument): string {
  const sections = d.sections.map((s) => `## ${s.heading}\n\n${s.body.trim()}\n`);
  return [`# ${d.title}\n`, ...sections].join('\n');
}

/** Path of each document's file, e.g. `payments/billing/backend/guidelines.md`. */
function markdownFiles(file: ExportFile): Map<string, string> {
  const org = new Map(file.organizations.map((o) => [o.key, o.slug]));
  const project = new Map(file.projects.map((p) => [p.key, p.slug]));
  const scope = new Map(file.scopes.map((s) => [s.key, s]));
  const out = new Map<string, string>();
  for (const d of file.documents) {
    // Documents point at keys that format.ts has checked are in the file.
    const parts = [d.organization ? (org.get(d.organization) ?? d.organization) : 'workspace'];
    if (d.project) parts.push(project.get(d.project) ?? d.project);
    const s = d.scope ? scope.get(d.scope) : undefined;
    if (s) {
      if (!s.project) parts.push('scopes');
      parts.push(s.slug);
    }
    let path = `${parts.join('/')}/${d.slug}.md`;
    for (let i = 2; out.has(path); i++) path = `${parts.join('/')}/${d.slug}-${i}.md`;
    out.set(path, documentMarkdown(d));
  }
  return out;
}

export function exportZip(file: ExportFile): Buffer {
  const entries = [
    { name: 'README.md', data: Buffer.from(README) },
    { name: MANIFEST, data: Buffer.from(JSON.stringify(file, null, 2)) },
    ...[...markdownFiles(file)].map(([name, text]) => ({ name, data: Buffer.from(text) })),
  ];
  return writeZip(entries, new Date(file.exported_at));
}

/** The manifest of an exported zip, and whether its Markdown files were edited after the export. */
export function readExportZip(
  zip: Buffer,
  maxBytes: number,
): { file: unknown; markdownEdited: boolean } {
  let entries;
  try {
    entries = readZip(zip, (name) => name === MANIFEST || name.endsWith('.md'), maxBytes);
  } catch (err) {
    throw new AppError('bad_request', `This file can't be imported: ${(err as Error).message}.`);
  }
  const manifest = entries.find((e) => e.name === MANIFEST);
  if (!manifest)
    throw new AppError('bad_request', "This file can't be imported: the zip has no manifest.json.");
  let file: unknown;
  try {
    file = JSON.parse(manifest.data.toString('utf8'));
  } catch {
    throw new AppError(
      'bad_request',
      "This file can't be imported: manifest.json isn't valid JSON.",
    );
  }
  let markdownEdited = false;
  try {
    const expected = markdownFiles(file as ExportFile);
    const markdown = entries.filter((e) => e.name !== MANIFEST && e.name !== 'README.md');
    markdownEdited =
      markdown.length !== expected.size ||
      markdown.some((e) => expected.get(e.name) !== e.data.toString('utf8'));
  } catch {
    // A malformed manifest is reported by the import itself.
  }
  return { file, markdownEdited };
}
