import test from 'node:test';
import assert from 'node:assert/strict';
import { HaloClient } from '../halo-client.mjs';
import { EolClient, cycleMatches } from '../eol-client.mjs';
import { parseEnv } from '../env.mjs';

const CFG = { base: 'https://t.halopsa.com', tenant: 't', clientId: 'id', clientSecret: 'secret', scope: 'all' };
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, headers: { get: (k) => headers[k.toLowerCase()] }, text: async () => typeof body === 'string' ? body : JSON.stringify(body) });

function fakeFetch(script) {
  const calls = [];
  const f = async (url, init) => { calls.push({ url, init }); const next = script.shift(); if (!next) throw new Error('unexpected call ' + url); return typeof next === 'function' ? next(url, init) : next; };
  f.calls = calls; return f;
}

test('token is requested once, sent as Bearer, renewed on 401', async () => {
  const fetch = fakeFetch([
    res(200, { access_token: 'T1', expires_in: 3600 }),
    res(200, { record_count: 1, assets: [{ id: 1 }] }),
    res(401, 'expired'),
    res(200, { access_token: 'T2', expires_in: 3600 }),
    res(200, { id: 1 }),
  ]);
  const h = new HaloClient(CFG, { fetchImpl: fetch, sleep: async () => {}, now: () => 1_000_000 });
  const list = await h.listAssets();
  assert.equal(list.length, 1);
  assert.match(fetch.calls[0].url, /\/auth\/token\?tenant=t$/);
  assert.match(fetch.calls[0].init.body, /grant_type=client_credentials/);
  assert.equal(fetch.calls[1].init.headers.Authorization, 'Bearer T1');
  assert.match(fetch.calls[1].url, /\/api\/Asset\?pageinate=true&page_size=100&page_no=1&includeinactive=false&includeactive=true&includeassetfields=true$/);
  await h.getAsset(1);
  assert.equal(fetch.calls[4].init.headers.Authorization, 'Bearer T2');
  assert.equal(h.stats.retries, 1);
});

test('429 waits for retry-after and retries; 5xx retries; 4xx throws', async () => {
  const sleeps = [];
  const fetch = fakeFetch([
    res(200, { access_token: 'T', expires_in: 3600 }),
    res(429, 'slow down', { 'retry-after': '7' }),
    res(503, 'busy'),
    res(200, [{ id: 3 }]),
    res(400, 'bad request'),
  ]);
  const h = new HaloClient(CFG, { fetchImpl: fetch, sleep: async (ms) => sleeps.push(ms), now: () => 5 });
  const r = await h.getFieldInfo();
  assert.deepEqual(r, [{ id: 3 }]);
  assert.equal(sleeps[0], 7000);
  assert.equal(h.stats.rateLimited, 1);
  await assert.rejects(() => h.getAssetTypes(), /HTTP 400/);
});

test('budget: the 501st call inside five minutes waits for the window', async () => {
  let t = 0; const sleeps = [];
  const script = [res(200, { access_token: 'T', expires_in: 3600 })];
  for (let i = 0; i < 501; i++) script.push(res(200, {}));
  const h = new HaloClient(CFG, { fetchImpl: fakeFetch(script), sleep: async (ms) => { sleeps.push(ms); t += ms; }, now: () => t, budget: 500 });
  for (let i = 0; i < 501; i++) { await h.get('/Health'); t += 100; }
  assert.equal(sleeps.length, 1);
  assert.ok(sleeps[0] > 240_000 && sleeps[0] <= 300_100, 'waited for the rolling window, got ' + sleeps[0]);
});

test('pagination stops at record_count and respects max', async () => {
  const page = (n) => res(200, { record_count: 250, assets: Array.from({ length: n }, (_, i) => ({ id: i })) });
  const fetch = fakeFetch([res(200, { access_token: 'T', expires_in: 3600 }), page(100), page(100), page(50)]);
  const h = new HaloClient(CFG, { fetchImpl: fetch, sleep: async () => {}, now: () => 1 });
  assert.equal((await h.listAssets()).length, 250);
  const fetch2 = fakeFetch([res(200, { access_token: 'T', expires_in: 3600 }), page(100), page(100)]);
  const h2 = new HaloClient(CFG, { fetchImpl: fetch2, sleep: async () => {}, now: () => 1 });
  assert.equal((await h2.listAssets({}, { max: 120 })).length, 120);
  assert.equal(fetch2.calls.length, 3);
});

test('EolClient batches SBOM lookups, caches, sends the key, and parses properties', async () => {
  const fetch = fakeFetch([
    (url, init) => { const b = JSON.parse(init.body); assert.equal(b.components.length, 2); assert.equal(init.headers['X-API-Key'], 'K'); return res(200, { components: b.components.map(c => ({ ...c, properties: c.name === 'windows-server' ? [{ name: 'endoflife:status', value: 'warn' }, { name: 'endoflife:product', value: 'windows-server' }, { name: 'endoflife:cycle', value: '2016' }, { name: 'endoflife:eol_date', value: '2027-01-12' }] : [{ name: 'endoflife:status', value: 'not-tracked' }, { name: 'endoflife:reason', value: 'name not recognised' }] })) }); },
    res(200, { score: 65, grade: 'D', support_date: '2022-01-11' }),
    res(200, { entries: [{ product: 'windows-server', affected_eol_versions: ['2012-r2', '2003 to 2008'] }] }),
  ]);
  const e = new EolClient({ apiKey: 'K', fetchImpl: fetch, batchSize: 5 });
  const m = await e.resolveMany([{ name: 'windows-server', version: '2016' }, { name: 'Lenovo Vantage', version: '10' }, { name: 'windows-server', version: '2016' }]);
  assert.equal(m.get('windows-server|2016').cycle, '2016');
  assert.equal(m.get('lenovo vantage|10').status, 'not-tracked');
  await e.resolveMany([{ name: 'windows-server', version: '2016' }]);   // cached: no new call
  const sc = await e.score('windows-server', '2016'); await e.score('windows-server', '2016');
  assert.equal(sc.score, 65);
  assert.deepEqual(await e.exploited('windows-server', '2012-r2'), { flag: true, cves: [undefined] });
  assert.equal((await e.exploited('windows-server', '2016')).flag, false);
  assert.equal(fetch.calls.length, 3);
  assert.equal(e.stats.calls, 3);
});

test('cycleMatches handles exact cycles and "a to b" ranges', () => {
  assert.equal(cycleMatches('7.2', '7.2'), true);
  assert.equal(cycleMatches('7.2', '7.0'), false);
  assert.equal(cycleMatches('8.5', '1.0 to 9.1'), true);
  assert.equal(cycleMatches('9.2', '1.0 to 9.1'), false);
  assert.equal(cycleMatches('2012-r2', '2003 to 2016'), false, 'non-numeric cycles never match a range');
});

test('parseEnv ignores comments and quotes', () => {
  assert.deepEqual(parseEnv('# c\nA=1\nB="two words"\n\nbad\n'), { A: '1', B: 'two words' });
});
