import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateAsset, collectInputs, worstRow } from '../evaluate.mjs';
import { MockEol, TABLE } from './mock-eol.mjs';

const TODAY = '2026-10-20';
const asset = (fields, software = []) => ({ id: 1, inventory_number: 'X', fields: Object.entries(fields).map(([name, value], i) => ({ id: 100 + i, name, value })), software });

test('demo laptop "Windows 10": recognised product, no cycle, nothing guessed', async () => {
  const ev = await evaluateAsset(asset({ 'OS Version': 'Windows 10' }), new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.status, 'needs a more specific version');
  assert.equal(ev.values.product, 'windows');
  assert.equal(ev.values.eol_date, '');
  assert.equal(ev.values.exploited, '');
  assert.match(ev.values.detail, /release/);
  assert.equal(ev.ticket, null);
});

test('server on Windows Server 2016: warn, score, support end and source filled', async () => {
  const ev = await evaluateAsset(asset({ 'OS Version': 'Windows Server 2016 Standard' }), new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.status, 'warn');
  assert.equal(ev.values.product, 'windows-server');
  assert.equal(ev.values.cycle, '2016');
  assert.equal(ev.values.eol_date, '2027-01-12');
  assert.equal(ev.values.support_end, '2022-01-11');
  assert.equal(ev.values.score, '65');
  assert.equal(ev.values.grade, 'D (High risk)');
  assert.equal(ev.values.exploited, 'No');
  assert.match(ev.values.source, /learn\.microsoft\.com/);
  assert.equal(ev.values.verified, '2026-10-20');
  assert.equal(ev.values.checked, TODAY);
  assert.equal(ev.ticket, null);
});

test('worst row wins: active OS plus a past-EOL SQL Server row makes the asset eol and ticketable', async () => {
  const a = asset({ 'OS Version': 'Windows Server 2016' }, [{ name: 'Microsoft SQL Server 2016 SP2 (64-bit)', version: '13.2.5026.0' }, { name: 'Google Chrome', version: '129.0.6668.90' }]);
  const ev = await evaluateAsset(a, new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.status, 'eol');
  assert.equal(ev.values.cycle, '13.0-sp2');   // higher score than Chrome 129, both eol
  assert.equal(ev.values.eol_date, '2026-07-14');
  assert.ok(ev.ticket && ev.ticket.result.product === 'mssqlserver');
  const lines = ev.values.detail.split(' | ');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^Windows Server 2016: windows-server 2016, warn/);
  assert.match(lines[1], /mssqlserver 13.0-sp2, eol, eol 2026-07-14, score 80 \(E\)/);
});

test('exploited and unpatchable outranks a plain eol row and sets the flag', async () => {
  const a = asset({ 'OS Version': 'Windows Server 2012 R2' }, [{ name: 'FortiGate FortiOS', version: '7.2.8' }]);
  const ev = await evaluateAsset(a, new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.exploited, 'Yes');
  assert.equal(ev.values.product, 'fortios');
  assert.match(ev.values.detail, /EXPLOITED UNPATCHABLE CVE-2025-61624/);
  assert.ok(ev.ticket);
});

test('unknown software is reported not tracked, never scored', async () => {
  const a = asset({}, [{ name: 'Lenovo Vantage', version: '10.2201.22.0' }]);
  const ev = await evaluateAsset(a, new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.status, 'not tracked');
  assert.equal(ev.values.score, '');
  assert.equal(ev.values.product, '');
  assert.equal(ev.ticket, null);
});

test('asset with no OS and no software is not tracked with an explanation', async () => {
  const ev = await evaluateAsset({ id: 9, fields: [{ name: 'Model', value: 'HP' }] }, new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.status, 'not tracked');
  assert.match(ev.values.detail, /no operating system or software rows/);
  assert.equal(collectInputs({ id: 9 }).length, 0);
  assert.equal(worstRow([]), null);
});

test('month-precision dates print as months', async () => {
  const ev = await evaluateAsset(asset({}, [{ name: 'Oracle Java 8 Update 381', version: '8.0.3810.13' }]), new MockEol(TABLE), { today: TODAY });
  assert.equal(ev.values.eol_date, '2030-12');
});

test('one resolve call per distinct pair across rows', async () => {
  const eol = new MockEol(TABLE);
  const a = asset({ 'OS Version': 'Windows Server 2016' }, [{ name: 'Google Chrome', version: '129.0.1' }, { name: 'Google Chrome', version: '129.0.1' }]);
  await evaluateAsset(a, eol, { today: TODAY });
  assert.deepEqual(eol.calls.filter(c => c[0] === 'resolve').map(c => c[1]), ['windows-server|2016', 'chrome|129']);
});
