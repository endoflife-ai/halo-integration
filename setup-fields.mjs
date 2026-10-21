#!/usr/bin/env node
// Attaches the twelve EOL asset fields to the asset types that hold
// computers, servers, databases and applications, and, only with
// --create-fields, creates any that are missing first.
//
// Creating an asset field is configuration: Halo requires the admin API
// permission on the application for POST /Field (confirmed by Halo,
// 2026-10-21; without it the call answers HTTP 401). The default path never
// asks for it: the administrator creates the twelve fields in the UI
// (Configuration > Asset Management > Asset Fields > New, type Text, no system
// use) and this script attaches them, which the asset permissions allow.
// Asset fields are the Field entity (GET/POST /Field, kind "T"); created ones
// are cloned from the tenant's own "OS Version" field so the kind, validation
// and access settings are the ones this Halo build expects.
//
//   node setup-fields.mjs --dry-run
//   node setup-fields.mjs [--types "Laptop,Workstation,..."]
//   node setup-fields.mjs --create-fields   (application has the admin API permission)
import { loadConfig, describeConfig } from './env.mjs';
import { HaloClient } from './halo-client.mjs';
import { EOL_FIELDS, FIELD_NAMES } from './fields.mjs';

export const DEFAULT_TYPES = ['Laptop', 'Workstation', 'Server', 'Virtual Server', 'Database', 'Database Server', 'Application Server', 'Business Application', 'Cluster'];

// Properties copied from the template field (verified on the sandbox 2026-10-20:
// kind T, validate X, access_level 2); everything else is left to Halo's defaults.
const CLONE_KEYS = ['kind', 'validate', 'datafrom', 'datalength', 'issoftware', 'lookup', 'showoncalendar', 'moveupdatetype', 'inactiveupdatetype', 'moveupdatedefault', 'showonactivity', 'parenttype_id', 'order_values_alphanumerically', 'access_level', 'integration_precedence_type'];

export function cloneFieldSpec(template, spec) {
  const f = {};
  for (const k of CLONE_KEYS) if (template[k] !== undefined && template[k] !== null) f[k] = template[k];
  f.name = spec.name;
  f.systemuse = 0;        // "No system use"
  f.mandatory = false;
  f.url = '';
  f.idstring = '';
  return f;
}

// One TypeInfo entry per field, shaped like the entries GET /AssetType/{id} returns.
export function planTypeAttachments(assetTypes, typeNames, fieldIds) {
  const plans = [];
  for (const t of assetTypes) {
    if (!typeNames.includes(t.name)) continue;
    const have = new Set((t.fields || []).map(x => x.field_id));
    const add = fieldIds.filter(id => !have.has(id));
    if (add.length) plans.push({ id: t.id, name: t.name, add });
  }
  return plans;
}

export function missingFieldsMessage(names) {
  return `Missing EOL asset fields: create them in Configuration > Asset Management > Asset Fields > New (type Text, no system use, not mandatory) with exactly these names: ${names.join('; ')}. Then re-run this script to attach them. (Or give the application the admin API permission and re-run with --create-fields.)`;
}

export function typeInfoEntries(type, fieldIds, names) {
  const start = (type.fields || []).reduce((m, f) => Math.max(m, Number(f.sequence) || 0), 0);
  return fieldIds.map((id, i) => ({ typeinfo_id: type.id, field_id: id, field_name: names.get(id) || '', sequence: start + i + 1, type: 'X', tab_id: -1, tab_name: '', groupname: '', techdetail: 1, userdetail: 1 }));
}

if (process.argv[1] && /setup-fields\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const dry = args.includes('--dry-run');
  const createFields = args.includes('--create-fields');
  const ti = args.indexOf('--types');
  const typeNames = ti >= 0 ? args[ti + 1].split(',').map(s => s.trim()) : DEFAULT_TYPES;
  const ei = args.indexOf('--env');
  const cfg = loadConfig(ei >= 0 ? args[ei + 1] : undefined);
  console.log(describeConfig(cfg));
  if (!cfg.haloReady) { console.error('Halo credentials missing'); process.exit(2); }
  const halo = new HaloClient(cfg, { log: (m) => console.log('  ' + m) });

  const fi = await halo.getFields();
  const fields = Array.isArray(fi) ? fi : (fi && fi.fields) || [];
  const template = fields.find(f => /^os version$/i.test(f.name || ''));
  if (!template) { console.error('no "OS Version" asset field to clone from; create one EOL field by hand and re-run'); process.exit(1); }
  console.log(`template "OS Version": id ${template.id} kind ${template.kind} validate ${template.validate} access_level ${template.access_level}`);
  const existing = new Map(fields.filter(f => FIELD_NAMES.includes(String(f.name || '').trim())).map(f => [String(f.name).trim(), f]));
  const toCreate = EOL_FIELDS.filter(s => !existing.has(s.name));
  console.log(`fields present ${existing.size}, to create ${toCreate.length}: ${toCreate.map(s => s.name).join(', ') || 'none'}`);

  if (toCreate.length && !createFields) {
    console.log(missingFieldsMessage(toCreate.map(s => s.name)));
  }
  if (toCreate.length && createFields) {
    const payload = toCreate.map(s => cloneFieldSpec(template, s));
    if (dry) console.log('dry run: would POST /Field?kind=T ' + JSON.stringify(payload[0]) + ' (and ' + (payload.length - 1) + ' more)');
    else {
      let created = null;
      try { created = await halo.request('POST', '/Field', { query: { kind: 'T' }, body: payload }); }
      catch (e) {
        console.log(`field creation refused (${e.message.slice(0, 80)}): the application needs the admin API permission for this. ${missingFieldsMessage(toCreate.map(s => s.name))}`);
      }
      const list = created == null ? [] : Array.isArray(created) ? created : [created];
      for (const c of list) if (c && c.id) existing.set(c.name, c);
      if (list.length) console.log(`created ${list.length} field(s): ${list.map(c => c && (c.name + '#' + c.id)).join(', ')}`);
      if (list.length !== payload.length || list.some(c => !c || !c.id)) {
        // Some builds return one record for a batch; re-read the catalogue to get every id.
        const again = await halo.getFields();
        for (const f of (Array.isArray(again) ? again : [])) if (FIELD_NAMES.includes(String(f.name || '').trim())) existing.set(String(f.name).trim(), f);
        console.log(`re-read: ${existing.size}/${FIELD_NAMES.length} EOL fields present`);
      }
    }
  }

  const types = await halo.getAssetTypes();
  const tl = Array.isArray(types) ? types : (types && types.assettypes) || [];
  const detailed = [];
  for (const t of tl) if (typeNames.includes(t.name)) detailed.push(await halo.get(`/AssetType/${t.id}`, { includedetails: true }));
  const fieldIds = FIELD_NAMES.map(n => existing.get(n) && existing.get(n).id).filter(Boolean);
  const names = new Map(fieldIds.map(id => [id, [...existing.values()].find(f => f.id === id).name]));
  const plans = planTypeAttachments(detailed, typeNames, fieldIds);
  console.log(`asset types to update: ${plans.length}: ${plans.map(p => p.name + ' +' + p.add.length).join('; ') || 'none'}`);
  if (dry && toCreate.length && createFields) console.log(`dry run: after creating the fields, ${detailed.length} asset type(s) would get +${toCreate.length}: ${detailed.map(t => t.name).join(', ')}`);
  if (dry && plans.length) console.log('dry run: would POST /AssetType ' + JSON.stringify({ id: plans[0].id, fields: [...(detailed.find(x => x.id === plans[0].id).fields || []).slice(0, 1), ...typeInfoEntries(detailed.find(x => x.id === plans[0].id), plans[0].add.slice(0, 1), names)] }) + ' ...');
  if (!dry && plans.length && fieldIds.length) {
    for (const p of plans) {
      const t = detailed.find(x => x.id === p.id);
      const fieldsNew = [...(t.fields || []), ...typeInfoEntries(t, p.add, names)];
      await halo.post('/AssetType', [{ id: t.id, name: t.name, fields: fieldsNew }]);
      console.log(`  ${p.name}: attached ${p.add.length}`);
    }
  }
  console.log(`halo calls: ${halo.stats.calls}${dry ? ' (dry run, nothing written)' : ''}`);
}
