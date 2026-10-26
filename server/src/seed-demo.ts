/**
 * Fill an empty Charter database with a realistic example: one group with two
 * organizations, linked services, glossary terms, learnings and open proposals.
 *
 *   Acme Group                 group-wide: privacy and security rules, the word "Customer", all .NET code
 *   ├─ Acme Logistics          a customer portal on six microservices
 *   └─ Acme Payments           card payments; may read Logistics, but not the other way round
 *
 *   node dist/seed-demo.js            (refuses if projects exist)
 *   node dist/seed-demo.js --reset    (wipes everything first)
 */
import pg from 'pg';
import { loadConfig } from './config.js';
import { createPool, migrate, withScope, type Queryable } from './db.js';
import { resolveAccess, type Access, type Actor } from './auth.js';
import * as admin from './service/admin.js';
import { createDocument, createScope, documentsAt, listSections } from './service/content.js';
import { createProject } from './service/projects.js';
import { addApi } from './service/apis.js';
import { BILLING_SWAGGER_YAML, ORDER_API } from './demo-specs.js';
import { addSection, approveProposal, editSection, proposeLearning } from './service/proposals.js';
import { addComment, applySuggestion, requestChanges, reviseProposal, setResolved } from './service/review.js';

const config = loadConfig();
const specs = config.apiSpecs;
const pool = createPool(config.databaseUrl);

async function main() {
  if (process.argv.includes('--reset')) {
    const owner = new pg.Client({ connectionString: config.databaseUrl });
    await owner.connect();
    await owner.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await owner.end();
  }
  await migrate(config.databaseUrl, config.migrationsDir);
  const boot = await admin.bootstrap(pool, { groupName: 'Acme Group', orgName: 'Acme Logistics', token: config.bootstrapToken });
  const existing = await withScope(pool, { groupId: null, bypass: true }, (c) => c.query('SELECT 1 FROM projects LIMIT 1'));
  if (existing.rowCount) throw new Error('Database already has projects; run with --reset to start over.');

  const { rows: admins } = await pool.query<Actor>(`SELECT id, name, kind, is_superadmin FROM actors WHERE is_superadmin ORDER BY created_at LIMIT 1`);
  const root = admins[0];
  if (process.argv.includes('--reset')) await pool.query(`UPDATE actors SET name = 'Mette Larsen' WHERE id = $1`, [root.id]);
  root.name = 'Mette Larsen';

  const as = async (actor: Actor, org?: string) => resolveAccess(pool, actor, null, org ?? null);
  const run = async <T>(a: Access, fn: (db: Queryable) => Promise<T>) => withScope(pool, { groupId: a.group.id }, fn);

  // ── Structure: organizations, people, agents, read access ──
  let a = await as(root);
  const logistics = a.orgs[0];
  const payments = await run(a, (db) => admin.createOrganization(db, a, { name: 'Acme Payments', slug: 'payments', summary: 'Card payments and fraud checks for every Acme company.' }));
  await run(a, (db) => db.query(`UPDATE organizations SET slug = 'logistics', summary = 'Moves pallets for 4,000 small businesses.' WHERE id = $1`, [logistics.id]));
  a = await as(root);
  const ids = await run(a, async (db) => ({
    jonas: (await admin.createMember(db, a, { name: 'Claude Code, Jonas', kind: 'agent', organization_id: logistics.id })).actor.id,
    sofie: (await admin.createMember(db, a, { name: 'Claude Code, Sofie', kind: 'agent', organization_id: logistics.id })).actor.id,
    lars: (await admin.createMember(db, a, { name: 'Claude Code, Lars', kind: 'agent', organization_id: payments.id })).actor.id,
    anders: (await admin.createMember(db, a, { name: 'Anders Holm', kind: 'human', organization_id: logistics.id, role: 'viewer' })).actor.id,
    ida: (await admin.createMember(db, a, { name: 'Ida Berg', kind: 'human', organization_id: payments.id, role: 'admin' })).actor.id,
  }));
  await run(a, (db) => admin.setReadGrant(db, a, payments.id, logistics.id, true));
  a = await as(root, 'logistics');
  const agent = (id: string, name: string): Actor => ({ id, name, kind: 'agent', is_superadmin: false });
  const jonas = await as(agent(ids.jonas, 'Claude Code, Jonas'));
  const sofie = await as(agent(ids.sofie, 'Claude Code, Sofie'));
  const lars = await as(agent(ids.lars, 'Claude Code, Lars'));

  const firstSection = async (db: Queryable, level: { organization_id: string | null }, kind: string) => {
    const doc = (await documentsAt(db, { organization_id: level.organization_id, project_id: null, scope_id: null })).find((d) => d.kind === kind)!;
    return { doc, section: (await listSections(db, [doc.id]))[0] };
  };

  // ── Group-wide ──
  await run(a, async (db) => {
    const group = { organization_id: null };
    const { section } = await firstSection(db, group, 'purpose');
    await editSection(db, a, section.id, {
      heading: 'What holds for every Acme company',
      body: `Acme Group owns several companies that share customers, infrastructure and a reputation.

Every piece of software in every company follows the rules on this page, before any company or project rules.`,
    });
    const { doc: guidelines } = await firstSection(db, group, 'guidelines');
    await addSection(db, a, guidelines.id, {
      heading: 'Personal data',
      body: 'Personal data is stored only where a [[term:Customer]] signed up. Other services keep the customer id and look details up when needed (GDPR).',
      mode: 'locked',
    });
    await addSection(db, a, guidelines.id, {
      heading: 'Logging',
      body: 'Structured logs only. Never log tokens, personal data or full request bodies. Include the correlation id from the `X-Correlation-Id` header.',
      mode: 'locked',
    });
    const glossary = await createDocument(db, a, {}, { kind: 'glossary', title: 'Group glossary', mode: 'propose' });
    await addSection(db, a, glossary.id, { heading: 'Customer', body: 'A company with a signed agreement with any Acme company. One customer can use several companies.', mode: 'locked' });
    const dotnet = await createScope(db, a, {}, { name: '.NET services', slug: 'dotnet', stacks: ['dotnet'], description: 'Every C# service in every Acme company.' });
    const dotnetDoc = await createDocument(db, a, { scope_id: dotnet.id }, { kind: 'guidelines', title: '.NET conventions', mode: 'propose' });
    await addSection(db, a, dotnetDoc.id, { heading: 'Target framework', body: 'All services target .NET 10 LTS with nullable reference types enabled and warnings as errors.', mode: 'locked' });
    await addSection(db, a, dotnetDoc.id, { heading: 'Data access', body: 'EF Core with explicit migrations checked into the repo. No lazy loading. Use `AsNoTracking()` for reads.', mode: 'propose' });
  });

  // ── Acme Logistics ──
  const portal = await run(a, async (db) => {
    const org = { organization_id: logistics.id };
    const { section: purpose } = await firstSection(db, org, 'purpose');
    await editSection(db, a, purpose.id, {
      heading: 'Who we are and what we build',
      body: `Acme Logistics moves pallets for 4,000 small businesses across Scandinavia. Our software lets customers book, track and pay for shipments without calling us.

The quality bar: a warehouse worker on a cheap Android phone with bad signal must be able to finish every task.`,
    });
    const { section: vocab } = await firstSection(db, org, 'business_logic');
    await editSection(db, a, vocab.id, {
      heading: 'Money and VAT',
      body: `- All amounts are stored as integer øre (DKK × 100), never as floating point.
- Prices shown to customers include VAT; invoices from [[billing-service]] list VAT separately.
- An [[term:Order]] is never deleted. Cancelling creates a credit note.`,
    });
    const { doc: guidelines } = await firstSection(db, org, 'guidelines');
    await addSection(db, a, guidelines.id, {
      heading: 'Every change ships behind a feature flag',
      body: 'New behaviour is off by default and enabled per customer group. Remove the flag within two sprints of full rollout.',
      mode: 'propose',
    });
    const glossary = await createDocument(db, a, org, { kind: 'glossary', title: 'Glossary', mode: 'propose' });
    await addSection(db, a, glossary.id, { heading: 'Order', body: 'A confirmed booking of one or more shipments. Owned by [[order-service]].', mode: 'locked' });
    await addSection(db, a, glossary.id, { heading: 'Shipment', body: 'One pallet or parcel moving from A to B. Belongs to an [[term:Order]]; tracked by [[tracking-service]].', mode: 'locked' });
    await addSection(db, a, glossary.id, { heading: 'Customer group', body: 'A set of customers that share prices and feature flags, for example "Pilot" or "Enterprise".', mode: 'propose' });
    const angular = await createScope(db, a, org, { name: 'Angular apps', slug: 'angular', stacks: ['angular'], description: 'Every Angular frontend in Logistics.' });
    const ngDoc = await createDocument(db, a, { scope_id: angular.id }, { kind: 'guidelines', title: 'Angular conventions', mode: 'propose' });
    await addSection(db, a, ngDoc.id, { heading: 'Components', body: 'Standalone components, signals for state, OnPush everywhere. No NgModules in new code.', mode: 'open' });

    const mk = (input: Parameters<typeof createProject>[2]) => createProject(db, a, { organization_id: logistics.id, ...input });
    const portal = await mk({
      name: 'Customer Portal', slug: 'customer-portal', summary: 'Where customers book, track and pay for shipments.',
      purpose: `The self-service portal for business customers. They book shipments, follow them on a map and pay invoices.

It owns no business data of its own: orders come from [[order-service]], invoices from [[billing-service]], live positions from [[tracking-service]] and logins from [[identity-service]].`,
      remote_url: 'https://acme@dev.azure.com/acme/Platform/_git/customer-portal',
    });
    const orderService = await mk({ name: 'Order Service', slug: 'order-service', summary: 'Source of truth for orders and shipments.',
      purpose: 'Creates and changes [[term:Order]]s and their [[term:Shipment]]s. Publishes OrderConfirmed and OrderCancelled events that [[billing-service]] and [[notification-hub]] consume.',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/order-service' });
    const billingService = await mk({ name: 'Billing Service', slug: 'billing-service', summary: 'Prices and invoices.',
      purpose: 'Turns confirmed orders from [[order-service]] into invoices, charges cards through [[payments/payment-gateway]] and sends dunning letters through [[notification-hub]].',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/billing-service' });
    await mk({ name: 'Tracking Service', slug: 'tracking-service', summary: 'Live positions of every shipment.',
      purpose: 'Ingests GPS pings from trucks and scanner events from warehouses, and matches them to [[term:Shipment]]s from [[order-service]].',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/tracking-service' });
    await mk({ name: 'Identity Service', slug: 'identity-service', summary: 'Logins, users and customer accounts.',
      purpose: 'Single sign-on for customers and staff, built on Entra ID. The only place personal data about a [[term:Customer]] is stored.',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/identity-service' });
    await mk({ name: 'Notification Hub', slug: 'notification-hub', summary: 'E-mail, SMS and push for every service.',
      purpose: 'Sends messages on behalf of other services. Looks up contact details in [[identity-service]] at send time.',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/notification-hub' });

    const fe = await createScope(db, a, { project_id: portal.id }, { name: 'Frontend', path_globs: ['frontend/**'], description: 'The Angular app customers use.' });
    const be = await createScope(db, a, { project_id: portal.id }, { name: 'Backend for frontend', slug: 'bff', path_globs: ['backend/**'], description: 'ASP.NET Core API that the frontend talks to.' });
    const feDoc = await createDocument(db, a, { scope_id: fe.id }, { kind: 'guidelines', title: 'Frontend guidelines', mode: 'propose' });
    await addSection(db, a, feDoc.id, { heading: 'Maps', body: 'Use the shared `<acme-map>` component for anything on a map. It handles offline tiles for bad signal.', mode: 'propose' });
    const beDoc = await createDocument(db, a, { scope_id: be.id }, { kind: 'guidelines', title: 'API guidelines', mode: 'propose' });
    await addSection(db, a, beDoc.id, { heading: 'No business logic here', body: 'The BFF only aggregates and reshapes. Rules belong in [[order-service]] or [[billing-service]].', mode: 'locked' });
    // API specs, so agents get exact endpoints and DTOs.
    await addApi(db, a, orderService.id, { content: JSON.stringify(ORDER_API, null, 2), filename: 'order-service.openapi.json' }, specs);
    await addApi(db, a, billingService.id, { content: BILLING_SWAGGER_YAML, filename: 'billing.swagger.yaml' }, specs);
    return { ...portal, fe: fe.id };
  });
  await run(sofie, (db) => createProject(db, sofie, {
    name: 'Warehouse Scanner App', slug: 'warehouse-scanner',
    purpose: 'Android app warehouse staff use to scan pallets in and out. Sends scans to [[tracking-service]].',
    remote_url: 'git@ssh.dev.azure.com:v3/acme/Platform/warehouse-scanner',
  }));

  // ── Acme Payments ──
  const ida = await as({ id: ids.ida, name: 'Ida Berg', kind: 'human', is_superadmin: false }, 'payments');
  await run(ida, async (db) => {
    const org = { organization_id: payments.id };
    const { section: purpose } = await firstSection(db, org, 'purpose');
    await editSection(db, ida, purpose.id, {
      heading: 'Who we are and what we build',
      body: 'Acme Payments takes card and invoice payments for every Acme company. We are PCI DSS certified; the card data environment is ours alone.',
    });
    const glossary = await createDocument(db, ida, org, { kind: 'glossary', title: 'Glossary', mode: 'propose' });
    await addSection(db, ida, glossary.id, { heading: 'Customer', body: 'In Payments, the cardholder paying, not the company that has an agreement with Acme. See the group definition of [[term:Customer]] for the latter.', mode: 'locked' });
    await createProject(db, ida, { organization_id: payments.id, name: 'Payment Gateway', slug: 'payment-gateway', summary: 'One API for cards, MobilePay and invoices.',
      purpose: 'Charges cards and MobilePay for [[logistics/billing-service]] and other Acme services. Every charge is screened by [[fraud-check]] first.',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Payments/payment-gateway' });
    await createProject(db, ida, { organization_id: payments.id, name: 'Fraud Check', slug: 'fraud-check', summary: 'Scores every payment before it is charged.',
      purpose: 'Scores each payment from [[payment-gateway]] in under 50 ms and blocks the riskiest.',
      remote_url: 'git@ssh.dev.azure.com:v3/acme/Payments/fraud-check' });
  });

  // ── Learnings and proposals from agents ──
  const undo = await run(jonas, (db) => proposeLearning(db, jonas, {
    heading: 'Every user action in the booking flow must be undoable',
    body: 'Route state changes through the `CommandStack` service so Ctrl+Z / Ctrl+Shift+Z work. Never mutate the booking store directly from a component.',
    rationale: 'Jonas corrected me after I set the pallet count directly in the component; he said customers rely on undo when editing a booking.',
    project_id: portal.id, scope_id: portal.fe,
    context: { remote: 'azure:acme/platform/customer-portal', path: 'frontend/src/app/booking/pallet-editor.ts', stacks: ['angular', 'frontend', 'node', 'typescript'], manifests: ['frontend/package.json'] },
  }));
  await run(a, (db) => approveProposal(db, a, undo.id, { note: 'Yes, and only for the frontend.' }));
  // A review that went back and forth: line comment with a suggestion, the agent applied it and revised.
  const vatBody = [
    'The BFF returns `priceInclVatOre` for every line and every total.',
    '',
    '- Format it with `formatDkk()` from `@acme/money`.',
    '- Do not multiply, divide or round amounts in the frontend.',
    '- Totals come from the API too; never sum lines yourself.',
  ].join('\n');
  const vat = await run(jonas, (db) => proposeLearning(db, jonas, {
    heading: 'Show prices with VAT and the øre amount from the API, never recompute',
    body: vatBody,
    rationale: 'I calculated VAT in a component and got rounding differences against the invoice.',
    project_id: portal.id, scope_id: portal.fe,
    context: { remote: 'azure:acme/platform/customer-portal', path: 'frontend/src/app/checkout/summary.ts', stacks: ['angular'] },
  }));
  const vatThread = await run(a, (db) => addComment(db, a, vat.id, {
    body: 'Worth saying why: credit notes are negative and `formatDkk()` is the only formatter that gets the sign right.',
    line_start: 3, line_end: 3,
    suggestion: '- Format it with `formatDkk()` from `@acme/money`; it is the only formatter that handles negative amounts on credit notes.',
  }));
  await run(a, (db) => addComment(db, a, vat.id, { body: 'Good catch. One small addition and I am happy to approve.' }));
  await run(a, (db) => requestChanges(db, a, vat.id, 'Please take the suggestion on line 3.'));
  await run(jonas, (db) => addComment(db, jonas, vat.id, { thread_id: vatThread.id, body: 'Agreed, applying it.' }));
  const applied = await run(jonas, (db) => applySuggestion(db, jonas, vatThread.comments[0].id));
  await run(jonas, (db) => reviseProposal(db, jonas, vat.id, {
    body: applied.body.replace('never sum lines yourself.', 'never sum lines yourself, not even for the basket badge.'),
    note: 'Also covered the basket badge, which I found doing its own sum.',
  }));

  // One waiting on the agent: changes requested, with an open suggestion.
  const poll = await run(sofie, (db) => proposeLearning(db, sofie, {
    heading: 'The tracking map polls every 5 seconds while a shipment is in transit',
    body: [
      'The tracking page polls `GET /shipments/{id}/position` every 5 seconds.',
      '',
      '- Stop polling when the tab is hidden (`document.visibilityState`).',
      '- Stop polling once the shipment is delivered.',
      '- Use `interval()` from RxJS, never `setInterval`.',
    ].join('\n'),
    rationale: 'Anders pointed out that the map kept polling in a background tab all night.',
    project_id: portal.id, scope_id: portal.fe,
    context: { remote: 'azure:acme/platform/customer-portal', path: 'frontend/src/app/tracking/live-map.ts', stacks: ['angular', 'frontend'] },
  }));
  await run(a, (db) => addComment(db, a, poll.id, {
    body: 'Positions move to the SignalR hub this quarter. Polling is only the fallback when the socket drops, so say that, or agents will build new polling.',
    line_start: 1, line_end: 1,
  }));
  await run(a, (db) => addComment(db, a, poll.id, {
    body: 'So the first position shows immediately:',
    line_start: 5, line_end: 5,
    suggestion: '- Use `timer(0, 5000)` from RxJS so the first position loads at once, never `setInterval`.',
  }));
  const tabThread = await run(a, (db) => addComment(db, a, poll.id, { body: 'This one is exactly right.', line_start: 3, line_end: 3 }));
  await run(a, (db) => setResolved(db, a, tabThread.id, true));
  await run(a, (db) => requestChanges(db, a, poll.id, 'Close. Reword line 1 so polling is the fallback, and take the suggestion on line 5.'));

  await run(sofie, async (db) => {
    const { section } = await firstSection(db, { organization_id: logistics.id }, 'guidelines');
    await editSection(db, sofie, section.id, {
      body: 'New behaviour is off by default and enabled per [[term:Customer group]]. Remove the flag within two sprints of full rollout, and delete its tests too.',
      rationale: 'Old flags kept their tests around after removal, which confused me.',
    });
  });
  await run(lars, (db) => proposeLearning(db, lars, {
    heading: 'Use Result<T> instead of exceptions for expected failures',
    body: 'Validation and "not found" return `Result.Fail(...)`. Exceptions are for bugs only.',
    rationale: 'Ida asked me to stop throwing NotFoundException from the gateway handlers. She thinks every .NET team should do this.',
    organization_id: payments.id,
    context: { remote: 'azure:acme/payments/payment-gateway', path: 'src/Gateway/Handlers/GetCharge.cs', stacks: ['dotnet', 'csharp', 'aspnetcore'] },
  }));

  console.log('Seeded "Acme Group": Acme Logistics (7 projects) and Acme Payments (2 projects).');
  if (boot.token) console.log(`Admin token: ${boot.token}`);
}

main()
  .catch((err) => {
    console.error(err.message ?? err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
