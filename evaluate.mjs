// Pure evaluation of one Halo asset: inputs -> mapped rows -> endoflife.ai
// facts -> the twelve field values and the ticket decision. No Halo calls
// here; the endoflife.ai client is injected so the tests mock it.
import { mapTitle, assetOsTitle, assetSoftwareRows } from './map.mjs';
import { EOL_FIELDS } from './fields.mjs';

const RANK = { eol: 4, warn: 3, active: 2, 'needs a more specific version': 1, 'version not tracked': 1, 'not tracked': 0, 'lookup failed': 0 };

export function collectInputs(asset) {
  const rows = [];
  const os = assetOsTitle(asset);
  if (os) rows.push({ kind: 'os', title: os, version: '', mapped: mapTitle(os, '') });
  for (const s of assetSoftwareRows(asset)) rows.push({ kind: 'software', title: s.name, version: s.version, source: s.source, mapped: mapTitle(s.name, s.version) });
  return rows;
}

function fmtDate(d, precision) {
  if (!d) return '';
  const s = String(d).slice(0, 10);
  return precision === 'month' ? s.slice(0, 7) : precision === 'year' ? s.slice(0, 4) : s;
}

// Resolves every row through the API (batched by the client's cache) and
// attaches the facts. `eol` is an EolClient (or a mock with the same methods).
export async function enrichRows(rows, eol) {
  const pairs = rows.map(r => ({ name: r.mapped && r.mapped.slug ? r.mapped.slug : r.title, version: r.mapped && r.mapped.version ? r.mapped.version : (r.version || ''), type: (r.mapped && r.mapped.type) || 'application' }));
  const resolved = await eol.resolveMany(pairs.filter(p => p.name));
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i], p = pairs[i];
    const k = (p.name + '|' + (p.version || '')).toLowerCase();
    const f = resolved.get(k) || { status: 'lookup-failed' };
    const m = r.mapped || {};
    if (m.slug && !m.version) {
      // A rule recognised the product but the title names no cycle: say so, link the product.
      r.result = { status: 'needs a more specific version', product: m.slug, product_url: f.product_url || `https://endoflife.ai/${m.slug}`, note: m.note };
      continue;
    }
    const status = f.status === 'version-not-tracked' ? 'version not tracked' : f.status === 'not-tracked' ? 'not tracked' : f.status === 'lookup-failed' ? 'lookup failed' : f.status;
    r.result = { status, product: f.product || m.slug || null, cycle: f.cycle || null, eol_date: f.eol_date || null, eol_date_precision: f.eol_date_precision || 'day', days_until_eol: f.days_until_eol != null ? Number(f.days_until_eol) : null, source: f.eol_date_source_url || null, source_kind: f.eol_date_source || null, verified: f.eol_date_verified_at || null, product_url: f.product_url || null, score_url: f.score_url || null, score: f.score != null ? Number(f.score) : null, grade: f.grade || null, grade_label: f.grade_label || null, matched_by: f.matched_by || null, note: m.note || f.reason || null };
    if (r.result.product && r.result.cycle) {
      {
        // One score call per (product, cycle) for the run: support end, precision and the
        // score for rows the SBOM call did not score at the key's tier.
        const sc = await eol.score(r.result.product, r.result.cycle);
        if (sc) {
          if (r.result.score == null && sc.score != null) { r.result.score = Number(sc.score); r.result.grade = sc.grade || r.result.grade; }
          r.result.grade_label = sc.grade_label || r.result.grade_label;
          r.result.support_end = sc.support_date || null;
          r.result.support_end_precision = sc.support_date_precision || 'day';
          r.result.eol_date_precision = sc.eol_date_precision || r.result.eol_date_precision;
          r.result.source = r.result.source || sc.eol_date_source_url || null;
          r.result.verified = r.result.verified || sc.eol_date_verified_at || null;
          r.result.extended_support_available = sc.extended_support_available ?? null;
        }
      }
      const ex = await eol.exploited(r.result.product, r.result.cycle);
      r.result.exploited = ex.flag; r.result.exploited_cves = ex.cves;
    } else { r.result.exploited = false; r.result.exploited_cves = []; }
  }
  return rows;
}

// The worst row decides the single-value fields; every row goes into EOL Detail.
export function worstRow(rows) {
  const scored = rows.filter(r => r.result);
  if (!scored.length) return null;
  return scored.slice().sort((a, b) => {
    const ea = a.result.exploited ? 1 : 0, eb = b.result.exploited ? 1 : 0;
    if (ea !== eb) return eb - ea;
    const ra = RANK[a.result.status] ?? 0, rb = RANK[b.result.status] ?? 0;
    if (ra !== rb) return rb - ra;
    return (b.result.score ?? -1) - (a.result.score ?? -1);
  })[0];
}

export function rowLine(r) {
  const x = r.result || {};
  const head = `${r.title}${r.version ? ' ' + r.version : ''}`;
  if (!x.product || !x.cycle) return `${head}: ${x.status}${x.note ? ' (' + x.note + ')' : ''}`;
  const parts = [`${x.product} ${x.cycle}`, x.status, x.eol_date ? `eol ${fmtDate(x.eol_date, x.eol_date_precision)}` : 'eol date not published', x.score != null ? `score ${x.score} (${x.grade})` : null, x.exploited ? `EXPLOITED UNPATCHABLE ${x.exploited_cves.join(' ')}` : null];
  return `${head}: ${parts.filter(Boolean).join(', ')}`;
}

export function fieldValues(rows, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const w = worstRow(rows);
  const v = Object.fromEntries(EOL_FIELDS.map(f => [f.key, '']));
  v.checked = today;
  if (!w) { v.status = 'not tracked'; v.detail = 'no operating system or software rows on this asset'; return v; }
  const x = w.result;
  v.status = x.status;
  v.product = x.product ? (x.product_name ? `${x.product_name} (${x.product})` : x.product) : '';
  v.cycle = x.cycle || '';
  v.support_end = fmtDate(x.support_end, x.support_end_precision);
  v.eol_date = fmtDate(x.eol_date, x.eol_date_precision);
  v.score = x.score != null ? String(x.score) : '';
  v.grade = x.grade ? (x.grade_label ? `${x.grade} (${x.grade_label})` : x.grade) : '';
  v.exploited = x.product && x.cycle ? (x.exploited ? 'Yes' : 'No') : '';
  v.source = x.source || '';
  v.verified = x.verified || '';
  v.detail = rows.map(rowLine).join(' | ');   // Halo text fields flatten newlines; a visible separator survives
  return v;
}

export function ticketNeeded(rows) {
  const w = worstRow(rows);
  if (!w || !w.result.product || !w.result.cycle) return null;
  if (w.result.status !== 'eol' && !w.result.exploited) return null;
  return w;
}

export async function evaluateAsset(asset, eol, opts = {}) {
  const rows = await enrichRows(collectInputs(asset), eol);
  const values = fieldValues(rows, opts);
  return { rows, values, worst: worstRow(rows), ticket: ticketNeeded(rows) };
}
