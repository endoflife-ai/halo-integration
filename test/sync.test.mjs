import test from 'node:test';
import assert from 'node:assert/strict';
import { run, parseArgs, buildUpdate, indexFields, hasOpenTicket, toCsv } from '../sync.mjs';
import { FIELD_NAMES } from '../fields.mjs';
import { MockEol, TABLE } from './mock-eol.mjs';

const FIELD_INFO = FIELD_NAMES.map((name, i) => ({ id: 500 + i, name, usage: 2 })).concat([{ id: 7, name: 'OS Version', usage: 2 }]);

class MockHalo {
  constructor(assets) {
    this.assets = assets; this.posts = []; this.openTickets = {}; this.stats = { calls: 0 };
  }
  async getFields() { this.stats.calls++; return FIELD_INFO; }
  async listAssets(filters, { max = Infinity } = {}) { this.stats.calls++; return this.assets.filter(a => !filters.client_id || a.client_id === filters.client_id).slice(0, max).map(a => ({ id: a.id, inventory_number: a.inventory_number, client_id: a.client_id })); }
  async getAsset(id) { this.stats.calls++; return structuredClone(this.assets.find(a => a.id === id)); }
  async updateAssets(rows, { batchSize = 50 } = {}) { for (let i = 0; i < rows.length; i += batchSize) { this.stats.calls++; this.posts.push(['/Asset', rows.slice(i, i + batchSize)]); } return []; }
  async openTicketsForAsset(id) { this.stats.calls++; return { tickets: this.openTickets[id] || [] }; }
  async createTickets(tickets) { this.stats.calls++; this.posts.push(['/Tickets', tickets]); return tickets.map((t, i) => ({ id: 9000 + i, ...t })); }
}

// Halo lists exactly the asset type's fields on the asset; the EOL fields are attached (empty) on these types.
const withEol = (fields) => [...fields, ...FIELD_INFO.filter(f => f.name.startsWith('EOL ') && !fields.some(x => x.name === f.name)).map(f => ({ id: f.id, name: f.name, value: null }))];
const ASSETS = [
  { id: 1, inventory_number: 'KL-LAP-1', assettype_name: 'Laptop', client_id: 10, client_name: 'HaloPSA', site_id: 11, site_name: 'Halo House', fields: withEol([{ id: 7, name: 'OS Version', value: 'Windows 10' }]), software: [] },
  { id: 2, inventory_number: 'SQL-SRV-01', assettype_name: 'Database', client_id: 20, client_name: 'Acorn', site_id: 21, site_name: 'London HQ', fields: withEol([{ id: 7, name: 'OS Version', value: 'Windows Server 2012 R2 Standard' }]), software: [{ name: 'Microsoft SQL Server 2019 (64-bit)', version: '15.0.4382.1' }] },
  { id: 3, inventory_number: 'AD-SRV-01', assettype_name: 'Server', client_id: 20, client_name: 'Acorn', site_id: 21, site_name: 'London HQ', fields: withEol([{ id: 7, name: 'OS Version', value: 'Windows Server 2016' }, { id: 504, name: 'EOL Status', value: 'warn' }, { id: 501, name: 'EOL Cycle', value: '2016' }]), software: [] },
];

test('dry run evaluates everything and posts nothing', async () => {
  const halo = new MockHalo(ASSETS);
  const report = await run({ dryRun: true, tickets: true, ticketType: 1, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  assert.equal(halo.posts.length, 0);
  assert.equal(report.summary.assets, 3);
  assert.equal(report.summary.past_eol, 1);
  assert.equal(report.summary.needs_version, 1);
  assert.equal(report.summary.warn, 1);
  assert.equal(report.summary.fields_updated, 0);
  const sql = report.results.find(r => r.asset === 'SQL-SRV-01');
  assert.equal(sql.values.status, 'eol');
  assert.equal(sql.values.cycle, '2012-r2');
  assert.ok(sql.ticket && /SQL-SRV-01 runs windows-server 2012-r2, end of life 2023-10-10/.test(sql.ticket.summary));
});

test('live run writes changed fields in one POST and opens one ticket with an idempotency key', async () => {
  const halo = new MockHalo(ASSETS);
  const report = await run({ tickets: true, ticketType: 1, ticketPriority: 2, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  const assetPosts = halo.posts.filter(p => p[0] === '/Asset');
  assert.equal(assetPosts.length, 1, 'all assets in one batch');
  const rows = assetPosts[0][1];
  assert.equal(rows.length, 3);
  const ad = rows.find(r => r.id === 3);
  assert.ok(!ad.fields.some(f => f.name === 'EOL Status'), 'unchanged EOL Status is not rewritten');
  assert.ok(ad.fields.some(f => f.name === 'EOL Date' && f.value === '2027-01-12'));
  assert.ok(rows.find(r => r.id === 1).fields.some(f => f.name === 'EOL Status' && f.value === 'needs a more specific version'));
  const ticketPosts = halo.posts.filter(p => p[0] === '/Tickets');
  assert.equal(ticketPosts.length, 1);
  const t = ticketPosts[0][1][0];
  assert.equal(t.third_party_id_string, 'endoflife-ai:2:windows-server:2012-r2');
  assert.equal(t.tickettype_id, 1); assert.equal(t.priority_id, 2); assert.equal(t.client_id, 20); assert.deepEqual(t.assets, [{ id: 2 }]);
  assert.match(t.details, /Source: https:\/\/learn\.microsoft\.com/);
  assert.match(t.details, /SQL Server 2019.*mssqlserver 15\.0, active/);
  assert.equal(report.summary.tickets_opened, 1);
  assert.equal(report.summary.fields_updated, rows.reduce((n, r) => n + r.fields.length, 0));
});

test('a second run does not open a duplicate ticket', async () => {
  const halo = new MockHalo(ASSETS);
  halo.openTickets[2] = [{ id: 77, third_party_id_string: 'endoflife-ai:2:windows-server:2012-r2' }];
  const report = await run({ tickets: true, ticketType: 1, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  assert.equal(halo.posts.filter(p => p[0] === '/Tickets').length, 0);
  assert.equal(report.summary.tickets_skipped_existing, 1);
});

test('scope filters and --max reach the Halo list call', async () => {
  const halo = new MockHalo(ASSETS);
  const report = await run({ dryRun: true, filters: { client_id: 20 }, max: 1, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  assert.equal(report.summary.assets, 1);
});

test('an asset whose type lacks the EOL fields is not written (Halo would drop the values) and the type is reported', async () => {
  const halo = new MockHalo([{ id: 9, inventory_number: 'RTR-1', assettype_name: 'Router', client_id: 1, fields: [{ id: 51, name: 'Model', value: 'FG-60F' }], software: [{ name: 'FortiOS', version: '7.2.8' }] }, ASSETS[2]]);
  const logs = [];
  const report = await run({ quiet: true }, { halo, eol: new MockEol(TABLE), log: (m) => logs.push(m), today: '2026-10-20' });
  const rows = halo.posts.filter(p => p[0] === '/Asset')[0][1];
  assert.deepEqual(rows.map(r => r.id), [3], 'only the server whose type carries the fields is written');
  assert.deepEqual(report.summary.asset_types_missing_fields, ['Router']);
  assert.ok(logs.some(l => /asset type "Router" lacks \d+ EOL field/.test(l)));
  assert.equal(report.results.find(r => r.asset === 'RTR-1').values.status, 'eol', 'the verdict is still evaluated and reported');
});

test('a list row that already carries fields and software skips the detail read', async () => {
  const halo = new MockHalo(ASSETS);
  halo.listAssets = async () => [{ ...ASSETS[2] }];   // full row from the list
  let detailReads = 0; halo.getAsset = async (id) => { detailReads++; return structuredClone(ASSETS.find(a => a.id === id)); };
  const report = await run({ dryRun: true, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  assert.equal(detailReads, 0);
  assert.equal(report.results[0].values.status, 'warn');
  halo.listAssets = async () => [{ id: 3, fields: ASSETS[2].fields }];   // fields but no software rows: detail still read
  await run({ dryRun: true, quiet: true }, { halo, eol: new MockEol(TABLE), log: () => {}, today: '2026-10-20' });
  assert.equal(detailReads, 1);
});

test('parseArgs', () => {
  const o = parseArgs(['--dry-run', '--client', '20', '--tickets', '--ticket-type', '3', '--max', '5', '--no-detail', '--report', 'x.json']);
  assert.deepEqual(o.filters, { client_id: 20 }); assert.equal(o.dryRun, true); assert.equal(o.ticketType, 3); assert.equal(o.max, 5); assert.equal(o.detail, false); assert.equal(o.report, 'x.json');
  assert.throws(() => parseArgs(['--bogus']));
});

test('buildUpdate, indexFields, hasOpenTicket, toCsv', () => {
  const idx = indexFields(FIELD_INFO);
  assert.equal(idx.size, FIELD_NAMES.length);
  const upd = buildUpdate({ id: 5, fields: [{ name: 'EOL Status', value: 'eol' }] }, { status: 'eol', product: 'x' }, idx);
  assert.deepEqual(upd.fields.map(f => f.name), ['EOL Product'], 'only the changed field is written; unchanged and empty-to-empty are skipped');
  assert.equal(buildUpdate({ id: 5, fields: [{ name: 'EOL Status', value: 'eol' }] }, { status: 'eol' }, new Map([['EOL Status', { id: 1 }]])), null);
  assert.equal(hasOpenTicket({ tickets: [{ third_party_id_string: 'a' }] }, 'a'), true);
  assert.equal(hasOpenTicket([], 'a'), false);
  const csv = toCsv([{ asset_id: 1, asset: 'A, "1"', client: 'C', site: 'S', asset_type: 'T', values: { status: 'eol', detail: 'l1\nl2' } }]);
  assert.match(csv, /^asset_id,asset,client,site,asset_type,EOL Product/);
  assert.match(csv, /"A, ""1"""/);
  assert.match(csv, /"l1\nl2"/);
});
