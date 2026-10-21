// endoflife.ai lookups for the Halo integration.
//   resolve(name, version)  -> /v1/sbom?enrich=1 (alias table; never guesses)
//   status(slug, version)   -> /v1/status/{slug}/{version} (support end, precision, source)
//   exploited(slug, cycle)  -> the curated Exploited & Unpatchable feed
// Every result is cached for the run so a tenant with 2,000 assets and 300
// distinct (product, version) pairs costs 300 lookups, not 2,000.
// `fetchImpl` is injectable for the tests.
const UA = 'endoflife-ai-halo-integration/0.1';

export class EolClient {
  constructor({ base = 'https://api.endoflife.ai', apiKey = '', feedUrl = 'https://endoflife.ai/exploited-and-unpatchable.json', fetchImpl = globalThis.fetch, batchSize = 5, log = () => {} } = {}) {
    this.base = base.replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.feedUrl = feedUrl;
    this.fetch = fetchImpl;
    this.batchSize = batchSize;
    this.log = log;
    this.cache = new Map();
    this.stats = { calls: 0 };
    this.feed = null;
  }

  headers(extra = {}) { return { 'User-Agent': UA, Accept: 'application/json', ...(this.apiKey ? { 'X-API-Key': this.apiKey } : {}), ...extra }; }

  async getJson(url, init = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.stats.calls++;
        const r = await this.fetch(url, { ...init, headers: this.headers(init.headers) });
        const text = await r.text();
        if (r.ok) return text ? JSON.parse(text) : null;
        if (r.status === 404) return null;
        this.log(`${url}: HTTP ${r.status}${attempt ? '' : ', retrying'}`);
      } catch (e) { this.log(`${url}: ${e.message}${attempt ? '' : ', retrying'}`); }
      await new Promise(r => setTimeout(r, 800));
    }
    return null;
  }

  // One SBOM call per batch of (name, version) pairs; returns a Map keyed by
  // "name|version" -> flat object of the endoflife:* properties.
  async resolveMany(pairs) {
    const out = new Map();
    const todo = [];
    for (const p of pairs) {
      const k = (p.name + '|' + (p.version || '')).toLowerCase();
      if (this.cache.has('sbom:' + k)) out.set(k, this.cache.get('sbom:' + k)); else if (!todo.some(t => t.k === k)) todo.push({ ...p, k });
    }
    for (let i = 0; i < todo.length; i += this.batchSize) {
      const chunk = todo.slice(i, i + this.batchSize);
      const body = { bomFormat: 'CycloneDX', specVersion: '1.5', components: chunk.map(c => ({ type: c.type || 'application', name: c.name, version: c.version || '' })) };
      const j = await this.getJson(this.base + '/v1/sbom?enrich=1', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const comps = (j && j.components) || [];
      chunk.forEach((c, idx) => {
        const comp = comps[idx] || null;
        const flat = {};
        for (const prop of (comp && comp.properties) || []) if (prop.name && prop.name.startsWith('endoflife:')) flat[prop.name.slice('endoflife:'.length)] = prop.value;
        if (!comp) flat.status = 'lookup-failed';
        this.cache.set('sbom:' + c.k, flat);
        out.set(c.k, flat);
      });
    }
    return out;
  }

  async resolve(name, version, type) {
    const m = await this.resolveMany([{ name, version, type }]);
    return m.get((name + '|' + (version || '')).toLowerCase());
  }

  async status(slug, version) {
    const k = 'status:' + slug + '|' + version;
    if (this.cache.has(k)) return this.cache.get(k);
    const j = await this.getJson(`${this.base}/v1/status/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`);
    const v = j && !j.error ? j : null;
    this.cache.set(k, v);
    return v;
  }

  // Score and grade for a resolved cycle (the SBOM call scores only the first
  // N components at the key's tier; this fills the rest one pair at a time).
  async score(slug, version) {
    const k = 'score:' + slug + '|' + version;
    if (this.cache.has(k)) return this.cache.get(k);
    const j = await this.getJson(`${this.base}/v1/score/${encodeURIComponent(slug)}/${encodeURIComponent(version)}`);
    const v = j && !j.error ? j : null;
    this.cache.set(k, v);
    return v;
  }

  async loadFeed() {
    if (this.feed) return this.feed;
    const j = await this.getJson(this.feedUrl);
    this.feed = (j && j.entries) || [];
    return this.feed;
  }

  // True when the feed lists the cycle for the product, either exactly
  // ("7.2") or inside a range ("1.0 to 9.1", compared on major.minor).
  async exploited(slug, cycle) {
    if (!slug || !cycle) return { flag: false, cves: [] };
    const feed = await this.loadFeed();
    const cves = [];
    for (const e of feed) {
      if (e.product !== slug) continue;
      if ((e.affected_eol_versions || []).some(v => cycleMatches(cycle, v))) cves.push(e.cve);
    }
    return { flag: cves.length > 0, cves };
  }
}

const num = s => String(s).split('.').slice(0, 3).map(x => parseInt(x, 10) || 0);
const cmp = (a, b) => { const x = num(a), y = num(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); } return 0; };
export function cycleMatches(cycle, spec) {
  const c = String(cycle).toLowerCase().trim(), s = String(spec).toLowerCase().trim();
  if (c === s) return true;
  const m = s.match(/^([0-9][0-9.]*)\s+to\s+([0-9][0-9.]*)$/);
  if (m && /^[0-9][0-9.]*$/.test(c)) return cmp(c, m[1]) >= 0 && cmp(c, m[2]) <= 0;
  return false;
}
