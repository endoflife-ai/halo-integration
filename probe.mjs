#!/usr/bin/env node
// Read-only look at a Halo tenant: token, one page of assets, one asset with
// details, its software rows, the field catalogue, asset types and ticket
// types. Saves the raw responses to ./probe-output/halo-probe-*.json so you
// can see what your tenant returns. Makes no writes to Halo.
//   node probe.mjs [--asset <id>] [--env <file>]
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, describeConfig, ROOT } from './env.mjs';
import { HaloClient } from './halo-client.mjs';
import { FIELD_NAMES } from './fields.mjs';

const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const cfg = loadConfig(opt('--env'));
console.log(describeConfig(cfg));
if (!cfg.haloReady) { console.error('Halo credentials missing'); process.exit(2); }
const out = path.join(ROOT, 'probe-output');
fs.mkdirSync(out, { recursive: true });
const save = (name, data) => { fs.writeFileSync(path.join(out, `halo-probe-${name}.json`), JSON.stringify(data, null, 2)); console.log(`  saved probe-output/halo-probe-${name}.json`); };
const halo = new HaloClient(cfg, { log: (m) => console.log('  ' + m) });

await halo.getToken();
console.log('token: ok');

const list = await halo.get('/Asset', { pageinate: true, page_size: 5, page_no: 1, includeassetfields: true, includeactive: true });
const rows = (list && list.assets) || [];
console.log(`assets: record_count ${list && list.record_count}, first page ${rows.length}; list row keys with fields: ${rows[0] && Array.isArray(rows[0].fields) ? 'yes (' + rows[0].fields.length + ')' : 'no'}`);
save('asset-list', list);

const id = Number(opt('--asset')) || (rows[0] && rows[0].id);
if (id) {
  const a = await halo.getAsset(id);
  console.log(`asset ${id}: ${a.inventory_number || a.key_field} type ${a.assettype_name}; fields ${(a.fields || []).length}, customfields ${(a.customfields || []).length}, software ${(a.software || []).length}`);
  for (const f of a.fields || []) if (f.value != null && f.value !== '') console.log(`    field ${f.id} ${f.name}: ${String(f.value).slice(0, 60)}`);
  save('asset-detail', a);
  const sw = await halo.getAssetSoftware(id);
  console.log(`asset software rows: ${Array.isArray(sw) ? sw.length : JSON.stringify(sw).slice(0, 120)}`);
  save('asset-software', sw);
}

const fi = await halo.getFields();
const fields = Array.isArray(fi) ? fi : (fi && fi.fields) || [];
console.log(`asset fields (GET /Field): ${fields.length} record(s): ${fields.map(f => f.id + ' ' + f.name + ' [' + f.kind + '/' + f.validate + ']').join('; ')}`);
const os = fields.find(f => /^os version$/i.test(f.name || f.label || ''));
if (os) console.log(`  "OS Version": id ${os.id}, kind ${os.kind}, validate ${os.validate}, access_level ${os.access_level}`);
const ours = fields.filter(f => FIELD_NAMES.includes(String(f.name || f.label || '').trim()));
console.log(`  EOL fields present: ${ours.length}/${FIELD_NAMES.length}${ours.length ? ' (' + ours.map(f => f.name + '#' + f.id).join(', ') + ')' : ''}`);
save('field', fields);

const types = await halo.getAssetTypes();
const tl = Array.isArray(types) ? types : (types && types.assettypes) || [];
console.log(`asset types: ${tl.length}: ${tl.map(t => t.id + ' ' + t.name).join('; ')}`);
save('assettypes', types);

try {
  const tt = await halo.get('/TicketType', { showall: true });
  const ttl = Array.isArray(tt) ? tt : [];
  console.log(`ticket types: ${ttl.length}: ${ttl.slice(0, 20).map(t => t.id + ' ' + t.name).join('; ')}`);
  save('tickettypes', tt);
} catch (e) { console.log(`ticket types: ${e.message}`); }

try {
  const sv = await halo.get('/Asset/GetAllSoftwareVersions');
  console.log(`GetAllSoftwareVersions: ${Array.isArray(sv) ? sv.length + ' row(s)' : JSON.stringify(sv).slice(0, 200)}`);
  save('software-versions', sv);
} catch (e) { console.log(`GetAllSoftwareVersions: ${e.message}`); }

console.log(`halo calls: ${halo.stats.calls}`);
