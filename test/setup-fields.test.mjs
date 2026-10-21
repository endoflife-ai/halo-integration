import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloneFieldSpec, planTypeAttachments, typeInfoEntries, missingFieldsMessage } from '../setup-fields.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('cloneFieldSpec copies the template settings and only renames', () => {
  const t = { id: 102, guid: 'g', name: 'OS Version', kind: 'T', validate: 'X', access_level: 2, systemuse: -1, idstring: 'Windows Version=' };
  const f = cloneFieldSpec(t, { name: 'EOL Product' });
  assert.equal(f.name, 'EOL Product'); assert.equal(f.kind, 'T'); assert.equal(f.validate, 'X'); assert.equal(f.access_level, 2);
  assert.equal(f.systemuse, 0); assert.equal(f.idstring, '');
  assert.equal(f.id, undefined); assert.equal(f.guid, undefined);
});

test('planTypeAttachments adds only the missing fields to the chosen types', () => {
  const types = [{ id: 111, name: 'Server', fields: [{ field_id: 51 }, { field_id: 147 }] }, { id: 134, name: 'Router', fields: [] }];
  assert.deepEqual(planTypeAttachments(types, ['Server'], [147, 148]), [{ id: 111, name: 'Server', add: [148] }]);
  assert.deepEqual(planTypeAttachments([{ id: 1, name: 'Server', fields: [{ field_id: 147 }] }], ['Server'], [147]), []);
});

test('typeInfoEntries continues the sequence after the type’s existing fields', () => {
  const e = typeInfoEntries({ id: 111, fields: [{ sequence: 1 }, { sequence: 8 }] }, [147, 148], new Map([[147, 'EOL Product'], [148, 'EOL Cycle']]));
  assert.deepEqual(e.map(x => [x.field_id, x.field_name, x.sequence, x.typeinfo_id]), [[147, 'EOL Product', 9, 111], [148, 'EOL Cycle', 10, 111]]);
});

test('the missing-fields message names the UI path, every field and the admin-permission alternative', () => {
  const m = missingFieldsMessage(['EOL Product', 'EOL Cycle']);
  assert.match(m, /Configuration > Asset Management > Asset Fields > New/);
  assert.match(m, /EOL Product; EOL Cycle/);
  assert.match(m, /admin API permission/);
  assert.match(m, /--create-fields/);
});

test('importing the module runs nothing (no credentials needed)', () => {
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify('file:///' + path.join(HERE, '..', 'setup-fields.mjs').replace(/\\/g, '/'))}).then(m => console.log(Object.keys(m).sort().join(',')))`], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /cloneFieldSpec/);
});
