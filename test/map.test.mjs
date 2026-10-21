import test from 'node:test';
import assert from 'node:assert/strict';
import { mapTitle, windowsClientCycle, assetOsTitle, assetSoftwareRows, slugify } from '../map.mjs';

const cases = [
  // [title, version, slug, version-or-null]
  ['Windows 10', '', 'windows', null],                         // demo laptop: no release, no guess
  ['Windows 10 Pro 22H2', '', 'windows', '10-22h2'],
  ['Windows 10 Enterprise 21H2', '', 'windows', '10-21h2-e'],
  ['Windows 10 Enterprise LTSC 2021', '21H2', 'windows', '10-21h2-e-lts'],
  ['Windows 11 Pro', '24H2', 'windows', '11-24h2-w'],
  ['Microsoft Windows 11 Enterprise', '10.0.26100', 'windows', '11-24h2-e'],
  ['Windows 11', '', 'windows', null],
  ['Windows Server 2019 Standard', '', 'windows-server', '2019'],
  ['Windows Server 2012 R2 Datacenter', '', 'windows-server', '2012-r2'],
  ['Windows Server 2016', '10.0.14393', 'windows-server', '2016'],
  ['Microsoft SQL Server 2019 (64-bit)', '15.0.4382.1', 'mssqlserver', '15.0'],
  ['Microsoft SQL Server 2016 SP2', '', 'mssqlserver', '13.0-sp2'],
  ['SQL Server 2008 R2', '', 'mssqlserver', '10.50'],
  ['Microsoft Exchange Server 2016', '', 'msexchange', '2016'],
  ['Microsoft Office Professional Plus 2016', '16.0.5456', 'office', '2016'],
  ['Microsoft .NET Framework 4.8', '4.8.04084', 'dotnetfx', '4.8'],
  ['Microsoft .NET Runtime - 6.0.25 (x64)', '6.0.25', 'dotnet', '6'],
  ['Red Hat Enterprise Linux 8.6', '', 'rhel', '8'],
  ['Ubuntu 22.04.3 LTS', '', 'ubuntu', '22.04'],
  ['Ubuntu', '20.04', 'ubuntu', '20.04'],
  ['VMware ESXi 7.0 Update 3', '', 'vmware-esxi', '7.0'],
  ['macOS Sonoma 14.2', '', 'macos', '14'],
  ['Google Chrome', '129.0.6668.90', 'chrome', '129'],
  ['Oracle Java 8 Update 381', '8.0.3810.13', 'oracle-jdk', '8'],
  ['PostgreSQL 15', '15.4', 'postgresql', '15'],
  ['Python 3.11.4 (64-bit)', '3.11.4', 'python', '3.11'],
  ['Node.js', '18.17.1', 'nodejs', '18'],
  ['Internet Information Services 10', '', 'iis', '10'],
  ['FortiGate FortiOS', '7.2.8', 'fortios', '7.2'],
  ['PAN-OS', '10.1.9', 'panos', '10.1'],
  ['Cisco IOS XE', '17.9.4a', 'cisco-ios-xe', '17.9'],
  ['Lenovo Vantage', '10.2201.22.0', null, '10.2201.22.0'],      // unknown title: tried by name with its full version, not guessed
];

for (const [title, version, slug, ver] of cases) {
  test(`map "${title}" / "${version}"`, () => {
    const m = mapTitle(title, version);
    assert.equal(m.slug, slug, 'slug');
    assert.equal(m.version, ver, 'version');
    if (slug && !ver) assert.ok(m.note, 'a recognised product without a cycle carries a reason');
  });
}

test('Windows client: the reason explains what is missing', () => {
  const w = windowsClientCycle('Windows 10', '');
  assert.equal(w.version, null);
  assert.match(w.reason, /release/);
  assert.equal(windowsClientCycle('Windows 10 Pro', '10.0.19045').version, '10-22h2');
  assert.equal(windowsClientCycle('Windows 11 IoT Enterprise LTSC 2024', '24H2').version, '11-24h2-iot-lts');
});

test('assetOsTitle prefers the OS Version field, then Intune, then os_override', () => {
  assert.equal(assetOsTitle({ fields: [{ name: 'OS Version', value: 'Windows 10' }, { name: 'OS Service Pack', value: '22H2' }] }), 'Windows 10 22H2');
  assert.equal(assetOsTitle({ fields: [{ name: 'OS Version', value: '' }], intune_operating_system: 'Windows 11 Pro 23H2' }), 'Windows 11 Pro 23H2');
  assert.equal(assetOsTitle({ os_override: 'Ubuntu 22.04' }), 'Ubuntu 22.04');
  assert.equal(assetOsTitle({ fields: [{ name: 'Model', value: 'X1' }] }), '');
});

test('assetSoftwareRows merges connectors and dedupes name+version', () => {
  const rows = assetSoftwareRows({ software: [{ name: 'Google Chrome', version: '129.0' }, { name: 'Google Chrome', version: '129.0' }], lansweeper_software: [{ name: 'google chrome', version: '129.0' }, { name: 'Zoom', version: '5.17' }] });
  assert.deepEqual(rows.map(r => r.name + '|' + r.version), ['Google Chrome|129.0', 'Zoom|5.17']);
});

test('slugify matches the API convention', () => {
  assert.equal(slugify('Node.js'), 'node-js');
  assert.equal(slugify('C++ Redistributable'), 'c-plus-plus-redistributable');
});
