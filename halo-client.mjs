// Minimal HaloPSA REST client: client-credentials token (cached, renewed
// before the one-hour expiry), JSON GET/POST, one retry on transient errors,
// HTTP 429 back-off, and a self-imposed budget of 500 calls per rolling five
// minutes (Halo's tenant-wide limit is 700 per 300 seconds; the rest is left
// for the MSP's other tools). `fetchImpl` is injectable so tests never touch
// the network.
export class HaloClient {
  constructor(cfg, { fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise(r => setTimeout(r, ms)), log = () => {}, budget = 500 } = {}) {
    if (!cfg || !cfg.base || !cfg.clientId || !cfg.clientSecret) throw new Error('HaloClient needs base, clientId and clientSecret (see halo.env.example)');
    this.cfg = cfg;
    this.fetch = fetchImpl;
    this.now = now;
    this.sleep = sleep;
    this.log = log;
    this.budget = budget;
    this.token = null;
    this.tokenExpiresAt = 0;
    this.calls = [];          // timestamps of calls in the current window (for the budget)
    this.stats = { calls: 0, retries: 0, rateLimited: 0 };
  }

  get api() { return this.cfg.base + '/api'; }

  async getToken() {
    if (this.token && this.now() < this.tokenExpiresAt - 60_000) return this.token;
    const url = this.cfg.base + '/auth/token' + (this.cfg.tenant ? '?tenant=' + encodeURIComponent(this.cfg.tenant) : '');
    const body = new URLSearchParams({ grant_type: 'client_credentials', client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, scope: this.cfg.scope || 'all' });
    const r = await this.fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'endoflife-ai-halo-integration/0.1' }, body: body.toString() });
    const text = await r.text();
    if (!r.ok) throw new Error(`Halo token request failed: HTTP ${r.status} ${text.slice(0, 200)}`);
    const j = JSON.parse(text);
    if (!j.access_token) throw new Error('Halo token response had no access_token');
    this.token = j.access_token;
    this.tokenExpiresAt = this.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.token;
  }

  async throttle() {
    const windowMs = 300_000;
    const t = this.now();
    this.calls = this.calls.filter(ts => t - ts < windowMs);
    if (this.calls.length >= this.budget) {
      const wait = windowMs - (t - this.calls[0]) + 50;
      this.log(`budget: ${this.calls.length} calls in 5 min, pausing ${Math.ceil(wait / 1000)}s`);
      await this.sleep(wait);
    }
    this.calls.push(this.now());
  }

  async request(method, path, { query, body } = {}) {
    const qs = query ? '?' + Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(String(v))).join('&') : '';
    const url = this.api + path + qs;
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      await this.throttle();
      const token = await this.getToken();
      let r;
      try {
        r = await this.fetch(url, { method, headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'endoflife-ai-halo-integration/0.1' }, body: body === undefined ? undefined : JSON.stringify(body) });
      } catch (e) {
        lastErr = e; this.stats.retries++; this.log(`${method} ${path}: network error ${e.message}, retrying`); await this.sleep(800 * (attempt + 1)); continue;
      }
      this.stats.calls++;
      const text = await r.text();
      if (r.status === 429) {
        this.stats.rateLimited++;
        const retryAfter = Number(r.headers && r.headers.get && r.headers.get('retry-after')) || 30;
        this.log(`${method} ${path}: HTTP 429, waiting ${retryAfter}s`);
        await this.sleep(retryAfter * 1000);
        continue;
      }
      if (r.status === 401 && attempt === 0) { this.token = null; this.stats.retries++; continue; }   // expired token: renew once
      if (r.status >= 500 && attempt < 3) { this.stats.retries++; this.log(`${method} ${path}: HTTP ${r.status}, retrying`); await this.sleep(1000 * (attempt + 1)); continue; }
      if (!r.ok) throw new Error(`Halo ${method} ${path} failed: HTTP ${r.status} ${text.slice(0, 300)}`);
      return text ? JSON.parse(text) : null;
    }
    throw lastErr || new Error(`Halo ${method} ${path}: gave up after retries`);
  }

  get(path, query) { return this.request('GET', path, { query }); }
  post(path, body) { return this.request('POST', path, { body }); }

  // Every active asset (plus inactive when asked), paged. Filters are passed
  // straight to /Asset: client_id, site_id, assettype_id, assetgroup_id.
  async listAssets(filters = {}, { pageSize = 100, includeInactive = false, max = Infinity } = {}) {
    const out = [];
    for (let page = 1; out.length < max; page++) {
      const j = await this.get('/Asset', { pageinate: true, page_size: pageSize, page_no: page, includeinactive: includeInactive, includeactive: true, includeassetfields: true, ...filters });
      const rows = (j && j.assets) || [];
      out.push(...rows);
      if (rows.length < pageSize) break;
      if (j.record_count != null && out.length >= j.record_count) break;
    }
    return out.slice(0, max);
  }

  getAsset(id) { return this.get(`/Asset/${id}`, { includedetails: true }); }
  getAssetSoftware(deviceId) { return this.get('/AssetSoftware', { device_id: deviceId }); }
  // Asset fields are the Field entity (kind "T"; "OS Version", "Model", ...).
  // FieldInfo is the ticket/custom-field catalogue and does not list them.
  getFields(query = {}) { return this.get('/Field', query); }
  getFieldInfo(query = {}) { return this.get('/FieldInfo', query); }
  getAssetTypes() { return this.get('/AssetType'); }

  // POST /Asset "adds or updates one or more Assets": id present = update.
  async updateAssets(rows, { batchSize = 50 } = {}) {
    const results = [];
    for (let i = 0; i < rows.length; i += batchSize) results.push(await this.post('/Asset', rows.slice(i, i + batchSize)));
    return results;
  }

  openTicketsForAsset(assetId) { return this.get('/Tickets', { asset_id: assetId, open_only: true, pageinate: false }); }
  createTickets(tickets) { return this.post('/Tickets', tickets); }
}
