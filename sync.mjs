#!/usr/bin/env node
// endoflife.ai EOL Risk for HaloPSA: read assets, map OS and software to
// endoflife.ai products, write the EOL fields back, open tickets for assets
// past end of life or exploited-and-unpatchable.
//
//   node sync.mjs --dry-run                 report only, no writes
//   node sync.mjs                           write fields
//   node sync.mjs --tickets --ticket-type 1 also open tickets
//   options: --client <id> --site <id> --asset-type <id> --asset-group <id>
//            --max <n> --no-detail --report <path> --env <file> --quiet
//
// Credentials come from ./halo.env or environment variables (never from arguments).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, describeConfig } from './env.mjs';
import { HaloClient } from './halo-client.mjs';
import { EolClient } from './eol-client.mjs';
import { evaluateAsset, rowLine } from './evaluate.mjs';
import { EOL_FIELDS, FIELD_NAMES, TICKET_PREFIX } from './fields.mjs';

export function parseArgs(argv) {
  const o = { dryRun: false, tickets: false, detail: true, max: Infinity, filters: {}, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => argv[++i];
    if (a === '--dry-run') o.dryRun = true;
    else if (a === '--tickets') o.tickets = true;
    else if (a === '--ticket-type') o.ticketType = Number(next());
    else if (a === '--ticket-priority') o.ticketPriority = Number(next());
    else if (a === '--client') o.filters.client_id = Number(next());
    else if (a === '--site') o.filters.site_id = Number(next());
    else if (a === '--asset-type') o.filters.assettype_id = Number(next());
    else if (a === '--asset-group') o.filters.assetgroup_id = Number(next());
    else if (a === '--max') o.max = Number(next());
    else if (a === '--no-detail') o.detail = false;
    else if (a === '--report') o.report = next();
    else if (a === '--env') o.env = next();
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  return o;
}

// Field ids by name from GET /Field (the asset field catalogue); ours are the
// records whose name matches exactly.
export function indexFields(fieldInfo) {
  const byName = new Map();
  for (const f of fieldInfo || []) {
    const n = String(f.name || f.label || '').trim();
    if (FIELD_NAMES.includes(n) && !byName.has(n)) byName.set(n, f);
  }
  return byName;
}

// Current value of one of our fields on the asset (so unchanged values are not rewritten).
function currentValue(asset, name) {
  for (const list of [asset.fields || [], asset.customfields || []]) for (const f of list) if (String(f.name || f.label || '') === name) return f.value == null ? '' : String(f.value);
  return '';
}

export function buildUpdate(asset, values, fieldIndex) {
  const fields = [];
  for (const spec of EOL_FIELDS) {
    const info = fieldIndex.get(spec.name);
    if (!info) continue;
    const v = values[spec.key] ?? '';
    if (currentValue(asset, spec.name) === v) continue;
    fields.push({ id: info.id, name: spec.name, value: v });
  }
  return fields.length ? { id: asset.id, fields } : null;
}

export function assetLabel(a) { return a.inventory_number || a.key_field || `asset ${a.id}`; }

export function buildTicket(asset, ev, { ticketType, ticketPriority } = {}) {
  const x = ev.ticket.result;
  const label = assetLabel(asset);
  const thirdParty = `${TICKET_PREFIX}${asset.id}:${x.product}:${x.cycle}`;
  const reason = x.exploited ? `is on the Exploited & Unpatchable list (${x.exploited_cves.join(', ')})` : `reached end of life on ${ev.values.eol_date}`;
  const summary = `[EOL] ${label} runs ${x.product} ${x.cycle}, ${x.exploited ? 'exploited and unpatchable' : 'end of life ' + ev.values.eol_date}`;
  const lines = [
    `${label} (${asset.assettype_name || 'asset'}, ${asset.client_name || ''}${asset.site_name ? ' / ' + asset.site_name : ''}) ${reason}.`,
    '',
    `Product: ${x.product} ${x.cycle}`,
    `Status: ${x.status}`,
    `End of life: ${ev.values.eol_date || 'not published'}${ev.values.support_end ? ' (active support ended ' + ev.values.support_end + ')' : ''}`,
    x.score != null ? `EOL Risk Score: ${x.score} ${ev.values.grade}` : null,
    x.exploited ? `Exploited & unpatchable: ${x.exploited_cves.join(', ')} (https://endoflife.ai/exploited-and-unpatchable)` : null,
    `Source: ${x.source || 'endoflife.ai'}${x.verified ? ' (verified ' + x.verified + ')' : ''}`,
    x.score_url ? `Score card: ${x.score_url}` : null,
    '',
    'Rows evaluated:',
    ...ev.rows.map(r => '  ' + rowLine(r)),
    '',
    'Opened by the endoflife.ai EOL Risk integration. Data: https://endoflife.ai, methodology: https://endoflife.ai/risk-score.',
  ].filter(l => l !== null);
  const t = { summary, details: lines.join('\n'), client_id: asset.client_id, site_id: asset.site_id, assets: [{ id: asset.id }], third_party_id_string: thirdParty, dont_do_rules: false };
  if (ticketType) t.tickettype_id = ticketType;
  if (ticketPriority) t.priority_id = ticketPriority;
  if (asset.username) t.user_name = asset.username;
  return t;
}

export function hasOpenTicket(openTickets, thirdParty) {
  const list = (openTickets && (openTickets.tickets || openTickets)) || [];
  return (Array.isArray(list) ? list : []).some(t => t.third_party_id_string === thirdParty);
}

function csvEscape(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
export function toCsv(results) {
  const head = ['asset_id', 'asset', 'client', 'site', 'asset_type', ...FIELD_NAMES];
  const lines = [head.join(',')];
  for (const r of results) lines.push([r.asset_id, r.asset, r.client, r.site, r.asset_type, ...EOL_FIELDS.map(f => r.values[f.key])].map(csvEscape).join(','));
  return lines.join('\n') + '\n';
}

export async function run(opts, { halo, eol, log = console.log, today } = {}) {
  const summary = { assets: 0, evaluated: 0, mapped: 0, past_eol: 0, warn: 0, exploited: 0, needs_version: 0, not_tracked: 0, fields_updated: 0, tickets_opened: 0, tickets_skipped_existing: 0, halo_calls: 0, eol_calls: 0, dry_run: !!opts.dryRun };
  const results = [];
  const fieldInfo = await halo.getFields();
  const fieldIndex = indexFields(Array.isArray(fieldInfo) ? fieldInfo : (fieldInfo && fieldInfo.fields) || []);
  const missing = FIELD_NAMES.filter(n => !fieldIndex.has(n));
  if (missing.length) log(`${missing.length} EOL field(s) not configured in Halo (${missing.join(', ')}): ${opts.dryRun ? 'dry run continues, values are reported only' : 'run setup-fields.mjs first; values for those fields are not written'}`);

  const assets = await halo.listAssets(opts.filters || {}, { max: opts.max ?? Infinity });
  summary.assets = assets.length;
  log(`${assets.length} asset(s) in scope${opts.filters && Object.keys(opts.filters).length ? ' (' + JSON.stringify(opts.filters) + ')' : ''}`);
  const updates = [], ticketPlans = [], typesMissingFields = new Map();
  for (const row of assets) {
    // The list row is enough only when it carries both the field values and the
    // software rows; otherwise (the usual case) the per-asset detail is read.
    const rowIsComplete = Array.isArray(row.fields) && Array.isArray(row.software);
    const asset = opts.detail === false || rowIsComplete ? row : (await halo.getAsset(row.id)) || row;
    const ev = await evaluateAsset(asset, eol, { today });
    summary.evaluated++;
    const st = ev.values.status;
    if (ev.worst && ev.worst.result.product && ev.worst.result.cycle) summary.mapped++;
    if (st === 'eol') summary.past_eol++; else if (st === 'warn') summary.warn++; else if (st === 'needs a more specific version') summary.needs_version++; else if (st === 'not tracked' || st === 'version not tracked') summary.not_tracked++;
    if (ev.values.exploited === 'Yes') summary.exploited++;
    // Halo silently drops a value written to a field that is not attached to the
    // asset's type (seen on the sandbox 2026-10-20: a Router with no "OS Version"
    // field accepted the POST and kept nothing). The asset's fields[] lists exactly
    // the type's fields, so a type missing our fields is skipped and reported.
    let upd = buildUpdate(asset, ev.values, fieldIndex);
    if (upd) {
      const attached = new Set((asset.fields || []).map(f => String(f.name || '')));
      const unattached = upd.fields.filter(f => !attached.has(f.name)).map(f => f.name);
      if (unattached.length) {
        upd = { ...upd, fields: upd.fields.filter(f => attached.has(f.name)) };
        const typeName = asset.assettype_name || `type ${asset.assettype_id}`;
        if (!typesMissingFields.has(typeName)) { typesMissingFields.set(typeName, unattached.length); log(`asset type "${typeName}" lacks ${unattached.length} EOL field(s) (${unattached.slice(0, 3).join(', ')}${unattached.length > 3 ? ', …' : ''}); add them to the type (setup-fields.mjs --types) or Halo drops the values`); }
        if (!upd.fields.length) upd = null;
      }
    }
    if (upd) updates.push(upd);
    const res = { asset_id: asset.id, asset: assetLabel(asset), client: asset.client_name || '', site: asset.site_name || '', asset_type: asset.assettype_name || '', values: ev.values, rows: ev.rows.map(r => ({ kind: r.kind, title: r.title, version: r.version, mapped: r.mapped && { slug: r.mapped.slug, version: r.mapped.version, note: r.mapped.note }, result: r.result })), fields_to_write: upd ? upd.fields.map(f => f.name) : [], ticket: null };
    if (!opts.quiet) log(`- ${res.asset} [${res.asset_type}] ${res.client}: ${st}${ev.values.product ? ' ' + ev.values.product + ' ' + ev.values.cycle : ''}${ev.values.eol_date ? ' eol ' + ev.values.eol_date : ''}${ev.values.score ? ' score ' + ev.values.score + ' ' + ev.values.grade : ''}${ev.values.exploited === 'Yes' ? ' EXPLOITED' : ''}${upd ? ' -> ' + upd.fields.length + ' field(s)' : ' (no change)'}`);
    if (opts.tickets && ev.ticket) {
      const t = buildTicket(asset, ev, opts);
      ticketPlans.push({ asset, ticket: t });
      res.ticket = { summary: t.summary, third_party_id_string: t.third_party_id_string };
    }
    results.push(res);
  }

  if (!opts.dryRun && updates.length) {
    await halo.updateAssets(updates);
    summary.fields_updated = updates.reduce((n, u) => n + u.fields.length, 0);
    log(`wrote ${summary.fields_updated} field value(s) on ${updates.length} asset(s)`);
  } else if (updates.length) {
    summary.fields_updated = 0;
    log(`dry run: would write ${updates.reduce((n, u) => n + u.fields.length, 0)} field value(s) on ${updates.length} asset(s)`);
  }

  for (const plan of ticketPlans) {
    const open = await halo.openTicketsForAsset(plan.asset.id);
    if (hasOpenTicket(open, plan.ticket.third_party_id_string)) { summary.tickets_skipped_existing++; log(`ticket exists for ${assetLabel(plan.asset)} (${plan.ticket.third_party_id_string}), skipped`); continue; }
    if (opts.dryRun) { log(`dry run: would open ticket "${plan.ticket.summary}"`); continue; }
    const created = await halo.createTickets([plan.ticket]);
    const first = Array.isArray(created) ? created[0] : created;   // Halo answers a one-ticket POST with the ticket object
    const id = first && first.id;
    summary.tickets_opened++;
    const r = results.find(x => x.asset_id === plan.asset.id); if (r && r.ticket) r.ticket.id = id || null;
    log(`opened ticket ${id || '?'}: ${plan.ticket.summary}`);
  }

  summary.halo_calls = halo.stats ? halo.stats.calls : null;
  summary.eol_calls = eol.stats ? eol.stats.calls : null;
  summary.asset_types_missing_fields = [...typesMissingFields.keys()];
  const report = { generated_at: new Date().toISOString(), summary, missing_fields: missing, results };
  if (opts.report) {
    const p = path.resolve(process.cwd(), opts.report);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(report, null, 2));
    fs.writeFileSync(p.replace(/\.json$/i, '') + '.csv', toCsv(results));
    log(`report: ${p} (+ .csv)`);
  }
  log(`summary: ${JSON.stringify(summary)}`);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 12).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
  const cfg = loadConfig(opts.env);
  console.log(describeConfig(cfg));
  if (!cfg.haloReady) { console.error('Halo credentials missing; see README "Register the application".'); process.exit(2); }
  if (opts.tickets && !opts.ticketType) { console.error('--tickets needs --ticket-type <id> (node probe.mjs lists ticket types)'); process.exit(2); }
  const log = (m) => console.log(m);
  const halo = new HaloClient(cfg, { log });
  const eol = new EolClient({ base: cfg.eolBase, apiKey: cfg.eolApiKey, log });
  await run(opts, { halo, eol, log });
}
