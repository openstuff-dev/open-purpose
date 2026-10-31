/**
 * The export file: one JSON document per group or organization. Rows refer to each
 * other by `key`, the row's id on the server it was exported from.
 */
import { z } from 'zod';
import { AppError } from '../../errors.js';
import { DOC_KINDS, EDIT_MODES } from '../types.js';
import { websites } from '../../domain/websites.js';
import type { ExportDocument, ExportFile } from '@openpurpose/contracts';

export const FORMAT = 'openpurpose-export';
export const FORMAT_VERSION = 1;
export const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

const key = z.string().min(1).max(200);
const ref = key.nullable();
const slug = z.string().regex(SLUG, 'must be lowercase letters, digits and dashes');
const time = z.iso.datetime({ offset: true });
const mode = z.enum(EDIT_MODES as ['locked', 'propose', 'open']);
const role = z.enum(['admin', 'editor', 'viewer', 'agent']);

const fileSchema = z.object({
  format: z.literal(FORMAT),
  version: z.literal(FORMAT_VERSION),
  exported_at: time,
  server_version: z.string(),
  source: z.object({
    kind: z.enum(['group', 'organization']),
    group: z.object({
      slug: z.string(),
      name: z.string(),
      context_max_tokens: z.number().int().min(1000).nullable().optional(),
    }),
    organization: ref,
  }),
  includes: z.object({
    history: z.boolean(),
    proposals: z.boolean(),
    people: z.boolean(),
    api_specs: z.boolean(),
    findings: z.boolean().default(false),
  }),
  people: z.array(
    z.object({
      key,
      name: z.string().min(1).max(200),
      kind: z.enum(['human', 'agent']),
      memberships: z.array(z.object({ organization: ref, role })),
      permissions: z
        .object({
          review: z.enum(['edit_modes', 'always_propose', 'auto_approve']),
          accept_findings: z.boolean(),
        })
        .optional(),
    }),
  ),
  organizations: z.array(
    z.object({
      key,
      slug,
      name: z.string().min(1),
      summary: z.string(),
      created_at: time,
      archived_at: time.nullable(),
      aliases: z.array(slug),
      context_max_tokens: z.number().int().min(1000).nullable().optional(),
      websites: websites.optional(),
    }),
  ),
  read_grants: z.array(z.object({ reader: key, target: key })),
  projects: z.array(
    z.object({
      key,
      organization: key,
      slug,
      name: z.string().min(1),
      summary: z.string(),
      reviewed: z.boolean(),
      created_by: ref,
      created_at: time,
      updated_at: time,
      archived_at: time.nullable(),
      aliases: z.array(slug),
      websites: websites.optional(),
      repositories: z.array(
        z.object({
          key,
          remote_key: z.string().min(1),
          remote_url: z.string().min(1),
          created_by: ref,
          created_at: time,
        }),
      ),
    }),
  ),
  api_specs: z.array(
    z.object({
      key,
      project: key,
      name: z.string(),
      source_url: z.string().nullable(),
      filename: z.string().nullable(),
      spec: z.unknown(),
      source_format: z.enum(['json', 'yaml']),
      spec_version: z.string(),
      title: z.string(),
      version: z.string(),
      endpoint_count: z.number().int(),
      schema_count: z.number().int(),
      content_hash: z.string(),
      fetched_at: time.nullable(),
      fetch_error: z.string().nullable(),
      created_by: ref,
      updated_by: ref,
      created_at: time,
      updated_at: time,
    }),
  ),
  scopes: z.array(
    z.object({
      key,
      organization: ref,
      project: ref,
      slug,
      name: z.string().min(1),
      description: z.string(),
      path_globs: z.array(z.string()),
      stacks: z.array(z.string()),
      position: z.number().int(),
      created_at: time,
      updated_at: time,
      aliases: z.array(slug),
      repositories: z.array(key),
    }),
  ),
  documents: z.array(
    z.object({
      key,
      organization: ref,
      project: ref,
      scope: ref,
      kind: z.enum(DOC_KINDS as [ExportDocument['kind'], ...ExportDocument['kind'][]]),
      slug,
      title: z.string().min(1),
      mode,
      position: z.number().int(),
      created_at: time,
      updated_at: time,
      disabled_at: time.nullable().optional(),
      sections: z.array(
        z.object({
          key,
          heading: z.string().min(1),
          body: z.string(),
          mode,
          position: z.number().int(),
          version: z.number().int().min(1),
          created_at: time,
          updated_at: time,
          updated_by: ref,
          versions: z.array(
            z.object({
              version: z.number().int().min(1),
              heading: z.string(),
              body: z.string(),
              mode,
              actor: ref,
              note: z.string(),
              created_at: time,
            }),
          ),
        }),
      ),
    }),
  ),
  proposals: z.array(
    z.object({
      key,
      kind: z.enum(['edit_section', 'new_section', 'learning', 'new_scope']),
      status: z.enum(['pending', 'changes_requested', 'approved', 'rejected']),
      organization: ref,
      project: ref,
      scope: ref,
      document: ref,
      section: ref,
      result_section: ref,
      // Files from before scope proposals don't have these.
      result_scope: ref.optional(),
      scope_spec: z
        .object({
          slug: z.string(),
          path_globs: z.array(z.string()),
          stacks: z.array(z.string()),
          repository_ids: z.array(z.string()),
        })
        .nullable()
        .optional(),
      base_version: z.number().int().nullable(),
      heading: z.string(),
      body: z.string(),
      rationale: z.string(),
      context: z.record(z.string(), z.unknown()),
      revision: z.number().int().min(1),
      created_by: ref,
      created_at: time,
      updated_at: time,
      reviewed_by: ref,
      reviewed_at: time.nullable(),
      review_note: z.string(),
      auto_approved: z.boolean().optional(),
      revisions: z.array(
        z.object({
          revision: z.number().int().min(1),
          heading: z.string(),
          body: z.string(),
          note: z.string(),
          actor: ref,
          created_at: time,
        }),
      ),
      events: z.array(
        z.object({
          kind: z.enum([
            'proposed',
            'revised',
            'changes_requested',
            'approved',
            'rejected',
            'commented',
          ]),
          revision: z.number().int(),
          note: z.string(),
          actor: ref,
          created_at: time,
        }),
      ),
      threads: z.array(
        z.object({
          revision: z.number().int(),
          line_start: z.number().int().min(1).nullable(),
          line_end: z.number().int().min(1).nullable(),
          anchor: z.string(),
          resolved_at: time.nullable(),
          resolved_by: ref,
          created_by: ref,
          created_at: time,
          comments: z.array(
            z.object({
              actor: ref,
              body: z.string(),
              suggestion: z.string().nullable(),
              applied_at: time.nullable(),
              applied_by: ref,
              created_at: time,
            }),
          ),
        }),
      ),
    }),
  ),
  findings: z
    .array(
      z.object({
        key,
        organization: key,
        project: key,
        scope: ref,
        status: z.enum(['new', 'todo', 'ask_later', 'dismissed', 'solved']),
        file: z.string().min(1),
        line_start: z.number().int().min(1).nullable(),
        line_end: z.number().int().min(1).nullable(),
        title: z.string().min(1),
        problem: z.string(),
        proposed_fix: z.string(),
        commit_sha: z.string().nullable(),
        remote: z.string().nullable(),
        context: z.record(z.string(), z.unknown()),
        remind_after: z.iso.date().nullable(),
        solved_ref: z.string().nullable(),
        created_by: ref,
        created_at: time,
        status_by: ref,
        status_at: time.nullable(),
        status_note: z.string(),
        updated_at: time,
      }),
    )
    .default([]),
});

const invalid = (msg: string) => new AppError('bad_request', `This file can't be imported: ${msg}`);

/** Check the shape of a file and that its rows point at each other consistently. */
export function parseExportFile(input: unknown): ExportFile {
  const head = (input ?? {}) as { format?: unknown; version?: unknown };
  if (head.format !== FORMAT) throw invalid('it is not an OpenPurpose export.');
  if (typeof head.version === 'number' && head.version > FORMAT_VERSION) {
    throw invalid(
      `it was exported by a newer OpenPurpose (format version ${head.version}). Upgrade this server first.`,
    );
  }
  const file = fileSchema.parse(input);

  const orgs = new Set(file.organizations.map((o) => o.key));
  const projects = new Map(file.projects.map((p) => [p.key, p]));
  const scopes = new Map(file.scopes.map((s) => [s.key, s]));
  const fail: (msg: string) => never = (msg) => {
    throw invalid(msg);
  };
  const unique = (what: string, keys: string[]) => {
    if (new Set(keys).size !== keys.length) fail(`two ${what} have the same key.`);
  };
  unique(
    'organizations',
    file.organizations.map((o) => o.key),
  );
  unique(
    'projects',
    file.projects.map((p) => p.key),
  );
  unique(
    'scopes',
    file.scopes.map((s) => s.key),
  );
  unique(
    'documents',
    file.documents.map((d) => d.key),
  );
  unique(
    'sections',
    file.documents.flatMap((d) => d.sections.map((s) => s.key)),
  );

  for (const p of file.projects) {
    if (!orgs.has(p.organization))
      fail(`project "${p.slug}" belongs to an organization that isn't in the file.`);
  }
  for (const s of file.api_specs)
    if (!projects.has(s.project))
      fail(`API spec "${s.name}" belongs to a project that isn't in the file.`);
  for (const s of file.scopes) {
    const p = s.project ? projects.get(s.project) : null;
    if (s.project && !p) fail(`scope "${s.slug}" belongs to a project that isn't in the file.`);
    if (s.organization && !orgs.has(s.organization))
      fail(`scope "${s.slug}" belongs to an organization that isn't in the file.`);
    if (p && p.organization !== s.organization)
      fail(`scope "${s.slug}" and its project are in different organizations.`);
    const repos = new Set(p?.repositories.map((r) => r.key) ?? []);
    if (s.repositories.some((r) => !repos.has(r)))
      fail(`scope "${s.slug}" is bound to a repository of another project.`);
  }
  for (const d of file.documents) {
    const level = d.scope ? scopes.get(d.scope) : d.project ? projects.get(d.project) : null;
    if ((d.scope || d.project) && !level)
      fail(`document "${d.slug}" belongs to a project or scope that isn't in the file.`);
    if (d.organization && !orgs.has(d.organization))
      fail(`document "${d.slug}" belongs to an organization that isn't in the file.`);
    const s = d.scope ? scopes.get(d.scope) : undefined;
    if (s && (s.organization !== d.organization || s.project !== d.project))
      fail(`document "${d.slug}" and its scope are at different levels.`);
    if (!s && d.project && projects.get(d.project)?.organization !== d.organization) {
      fail(`document "${d.slug}" and its project are in different organizations.`);
    }
  }
  for (const f of file.findings) {
    const p = projects.get(f.project);
    if (!p) fail(`finding "${f.title}" belongs to a project that isn't in the file.`);
    if (p.organization !== f.organization)
      fail(`finding "${f.title}" and its project are in different organizations.`);
    if (f.scope && scopes.get(f.scope)?.project !== f.project)
      fail(`finding "${f.title}" is filed under a scope of another project.`);
  }
  for (const g of file.read_grants) {
    if (!orgs.has(g.reader) || !orgs.has(g.target))
      fail("a read grant names an organization that isn't in the file.");
  }
  return file;
}
