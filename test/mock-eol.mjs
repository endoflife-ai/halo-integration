// A stand-in for EolClient with canned answers keyed by "slug|version".
export class MockEol {
  constructor(table = {}) { this.table = table; this.stats = { calls: 0 }; this.calls = []; }
  async resolveMany(pairs) {
    const out = new Map();
    for (const p of pairs) {
      const k = (p.name + '|' + (p.version || '')).toLowerCase();
      this.calls.push(['resolve', k]); this.stats.calls++;
      const t = this.table[k];
      out.set(k, t ? { status: t.status, product: t.product, cycle: t.cycle, eol_date: t.eol_date, eol_date_precision: t.eol_date_precision, days_until_eol: t.days_until_eol, eol_date_source: 'vendor-fetched', eol_date_source_url: t.source, eol_date_verified_at: t.verified, product_url: 'https://endoflife.ai/' + t.product, score_url: `https://endoflife.ai/score/${t.product}/${t.cycle}`, score: t.score, grade: t.grade, matched_by: 'name' } : { status: 'not-tracked', reason: 'name not recognised' });
    }
    return out;
  }
  async score(slug, cycle) {
    this.calls.push(['score', slug + '|' + cycle]); this.stats.calls++;
    const t = Object.values(this.table).find(x => x.product === slug && x.cycle === cycle);
    return t ? { score: t.score, grade: t.grade, grade_label: t.grade_label, support_date: t.support_end, support_date_precision: 'day', eol_date_precision: t.eol_date_precision || 'day', eol_date_source_url: t.source, eol_date_verified_at: t.verified } : null;
  }
  async exploited(slug, cycle) {
    const t = Object.values(this.table).find(x => x.product === slug && x.cycle === cycle);
    return t && t.exploited ? { flag: true, cves: t.exploited } : { flag: false, cves: [] };
  }
}

export const TABLE = {
  'windows-server|2016': { status: 'warn', product: 'windows-server', cycle: '2016', eol_date: '2027-01-12', days_until_eol: 84, support_end: '2022-01-11', score: 65, grade: 'D', grade_label: 'High risk', source: 'https://learn.microsoft.com/en-us/lifecycle/products/?terms=windows%20server', verified: '2026-10-20' },
  'windows-server|2012-r2': { status: 'eol', product: 'windows-server', cycle: '2012-r2', eol_date: '2023-10-10', days_until_eol: -1106, support_end: '2018-10-09', score: 95, grade: 'F', grade_label: 'Critical risk', source: 'https://learn.microsoft.com/en-us/lifecycle/products/?terms=windows%20server', verified: '2026-10-20' },
  'mssqlserver|15.0': { status: 'active', product: 'mssqlserver', cycle: '15.0', eol_date: '2030-01-08', days_until_eol: 1176, support_end: '2025-02-28', score: 30, grade: 'B', grade_label: 'Medium risk', source: 'https://learn.microsoft.com/en-us/lifecycle/products/?terms=sql%20server', verified: '2026-10-20' },
  'mssqlserver|13.0-sp2': { status: 'eol', product: 'mssqlserver', cycle: '13.0-sp2', eol_date: '2026-07-14', days_until_eol: -98, support_end: '2021-07-13', score: 80, grade: 'E', grade_label: 'High risk', source: 'https://learn.microsoft.com/en-us/lifecycle/products/?terms=sql%20server', verified: '2026-10-20' },
  'fortios|7.2': { status: 'eol', product: 'fortios', cycle: '7.2', eol_date: '2026-09-30', days_until_eol: -20, score: 90, grade: 'F', grade_label: 'Critical risk', source: 'https://support.fortinet.com/', verified: '2026-10-19', exploited: ['CVE-2025-61624'] },
  'windows|10-22h2': { status: 'eol', product: 'windows', cycle: '10-22h2', eol_date: '2025-10-14', days_until_eol: -371, score: 85, grade: 'E', grade_label: 'High risk', source: 'https://learn.microsoft.com/en-us/lifecycle/products/windows-10-home-and-pro', verified: '2026-10-20' },
  'chrome|129': { status: 'eol', product: 'chrome', cycle: '129', eol_date: '2024-10-15', days_until_eol: -735, score: 60, grade: 'D', grade_label: 'High risk', source: 'https://chromereleases.googleblog.com/', verified: '2026-10-20' },
  'oracle-jdk|8': { status: 'active', product: 'oracle-jdk', cycle: '8', eol_date: '2030-12', eol_date_precision: 'month', days_until_eol: 1500, score: 40, grade: 'C', grade_label: 'Medium risk', source: 'https://www.oracle.com/java/technologies/java-se-support-roadmap.html', verified: '2026-10-20' },
};
