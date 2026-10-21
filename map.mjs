// Title + version -> endoflife.ai product slug + version candidate.
// Honest by design: a title the rules cannot place is tried once by slugified
// name (the API's alias table decides), and a version too coarse to be a
// cycle ("Windows 10" with no release) is reported as such, never guessed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RULES = JSON.parse(fs.readFileSync(path.join(HERE, 'mapping.json'), 'utf8')).rules.map(r => ({ ...r, re: new RegExp(r.pattern, 'i') }));

export const slugify = s => String(s || '').toLowerCase().trim().replace(/\+/g, '-plus').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

const firstVersion = s => { const m = String(s || '').match(/(\d+(?:\.\d+)*)/); return m ? m[1] : ''; };
// The row's own version string first, unless the rule prefers the number in the
// title (.NET Framework rows carry build numbers like 4.8.04084 while the title says 4.8).
const pick = (r, title, version) => r.prefer === 'title' ? (firstVersion(title.replace(r.re, '')) || firstVersion(version)) : (firstVersion(version) || firstVersion(title.replace(r.re, '')));
const take = (v, n) => v ? v.split('.').slice(0, n).join('.') : '';

// Windows client cycles are "<major>-<release><edition>": 10-22h2 (one cycle
// for both editions), 11-24h2-w (Home/Pro/Workstation) or 11-24h2-e
// (Enterprise/Education), plus -e-lts for LTSC and -iot-lts. Without a release
// the cycle is unknown and the honest answer is "needs a more specific version".
export function windowsClientCycle(title, version) {
  const text = `${title || ''} ${version || ''}`;
  const major = (text.match(/windows\s*(10|11)/i) || [])[1] || (/^(10|11)\b/.test(String(version || '')) ? String(version).slice(0, 2) : '');
  const release = (text.match(/\b(\d\d)h([12])\b/i) || []);
  const build = (text.match(/\b10\.0\.(\d{5})\b/) || [])[1];
  const rel = release.length ? release[1] + 'h' + release[2] : BUILD_TO_RELEASE[build] || '';
  if (!major || !rel) return { version: null, reason: major ? `Windows ${major} needs a release (22H2, 24H2, LTSC 2021) or a 10.0.x build number to name a cycle` : 'Windows version not stated' };
  const ltsc = /ltsc|enterprise ltsc|iot enterprise/i.test(text);
  const iot = /iot/i.test(text);
  const enterprise = /enterprise|education/i.test(text);
  if (iot && ltsc) return { version: `${major}-${rel}-iot-lts` };
  if (ltsc) return { version: `${major}-${rel}-e-lts` };
  // Windows 10 22H2 is one cycle; 21H2 and Windows 11 releases split by edition.
  if (major === '10' && rel === '22h2') return { version: '10-22h2' };
  return { version: `${major}-${rel}-${enterprise ? 'e' : 'w'}`, editionAssumed: !/enterprise|education|home|pro|workstation/i.test(text) };
}
const BUILD_TO_RELEASE = { 19045: '22h2', 19044: '21h2', 19043: '21h1', 19042: '20h2', 19041: '2004', 18363: '1909', 18362: '1903', 17763: '1809', 17134: '1803', 16299: '1709', 15063: '1703', 14393: '1607', 10586: '1511', 10240: '1507', 22000: '21h2', 22621: '22h2', 22631: '23h2', 26100: '24h2', 26200: '25h2' };

// Returns { slug, version, type, rule, note } or { slug, version: null, note }.
// `title` is the software or OS name as Halo holds it, `version` the row's own
// version string when there is one (software rows), '' for the OS field.
export function mapTitle(title, version = '') {
  const t = String(title || '').trim();
  if (!t) return null;
  for (const r of RULES) {
    const m = r.re.exec(t);
    if (!m) continue;
    const out = { slug: r.slug, type: r.type || 'application', rule: r.pattern, title: t, raw_version: version || '' };
    switch (r.version) {
      case 'group': {
        let v = (m.groups && m.groups.v) || '';
        if (r.postfix) for (const [k, suffix] of Object.entries(r.postfix)) if (new RegExp('\\b' + k + '\\b', 'i').test(t)) v += suffix;
        out.version = v || firstVersion(version) || null; break;
      }
      case 'field': out.version = firstVersion(version) || firstVersion(t.replace(r.re, '')) || null; break;
      case 'year': {
        const text = `${t} ${version}`.toLowerCase();
        const keys = Object.keys(r.years).sort((a, b) => b.length - a.length);
        const hit = keys.find(k => new RegExp('\\b' + k.replace(/\s+/g, '\\s*') + '\\b', 'i').test(text));
        if (!hit) { out.version = null; out.note = `${r.slug}: no product year in the title or version`; break; }
        let v = r.years[hit];
        const sp = text.match(/\bsp\s*(\d)\b|service pack\s*(\d)/i);
        if (sp && r.slug === 'mssqlserver') v += '-sp' + (sp[1] || sp[2]);
        out.version = v; break;
      }
      case 'windows-client': { const w = windowsClientCycle(t, version); out.version = w.version; if (w.reason) out.note = w.reason; if (w.editionAssumed) out.note = 'edition not stated; Home/Pro cycle assumed'; break; }
      case 'major': out.version = take(pick(r, t, version), 1) || null; break;
      case 'major.minor': out.version = take(pick(r, t, version), 2) || null; break;
      case 'major.minor.patch': out.version = take(pick(r, t, version), 3) || null; break;
      default: out.version = firstVersion(version) || null;
    }
    if (!out.version && !out.note) out.note = `${r.slug}: no version in "${t}"${version ? ' / "' + version + '"' : ''}`;
    return out;
  }
  // No rule: let the API's alias table try the title as given, then slugified.
  return { slug: null, type: 'application', rule: null, title: t, raw_version: version || '', version: firstVersion(version) || null, note: 'no mapping rule; tried by name' };
}

// The OS of an asset as Halo holds it: the "OS Version" field (+ service
// pack), else Intune's OS string, else os_override.
export function assetOsTitle(asset) {
  const f = fieldValue(asset, 'OS Version');
  const sp = fieldValue(asset, 'OS Service Pack');
  if (f) return sp ? `${f} ${sp}` : f;
  return asset.intune_operating_system || asset.os_override || '';
}

export function fieldValue(asset, name) {
  const lists = [asset.fields || [], asset.customfields || []];
  for (const list of lists) for (const fld of list) {
    if (String(fld.name || fld.label || '').toLowerCase() === name.toLowerCase()) {
      const v = fld.value ?? fld.display ?? '';
      return v == null ? '' : String(v).trim();
    }
  }
  return '';
}

// All software rows Halo holds for the asset, from whichever connector filled them.
export function assetSoftwareRows(asset) {
  const rows = [];
  for (const s of asset.software || []) if (s && s.name) rows.push({ name: s.name, version: s.version || '', source: 'software' });
  for (const s of asset.lansweeper_software || []) if (s && s.name) rows.push({ name: s.name, version: s.version || '', source: 'lansweeper' });
  for (const s of asset.qualys_software || []) if (s && (s.name || s.fullName)) rows.push({ name: s.name || s.fullName, version: s.version || '', source: 'qualys' });
  const seen = new Set();
  return rows.filter(r => { const k = (r.name + '|' + r.version).toLowerCase(); if (seen.has(k)) return false; seen.add(k); return true; });
}
