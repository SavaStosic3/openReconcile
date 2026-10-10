import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../deploy/config.js';
import { setupAdmin } from '../deploy/accounts.js';
import { piConnections } from '../backend/pi-connectors.js';
import { profile } from './helpers/pi-fixture.js';

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'openreconcile-pi-config-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  await setupAdmin({ dataDir, username: 'ConfigAdmin', password: 'disposable-config-test-password' });
  return { dataDir, env: { APP_DATA_DIR: dataDir }, file: join(dataDir, 'private-pi-connections.json') };
}

test('standalone PI remains unconfigured until a private connection file is supplied', async t => {
  const f = await fixture(t);
  const config = await loadConfig({ env: { ...f.env, PI_CONNECTIONS_FILE: '', PI_CONNECTIONS: JSON.stringify([profile()]) } });
  assert.equal(config.backendEnv.PI_CONNECTIONS, undefined);
  assert.deepEqual(piConnections(config.backendEnv), { configured: false, connections: [] });
});

test('standalone PI reads validated profiles from the private file and returns only safe public metadata', async t => {
  const f = await fixture(t), binding = profile();
  await writeFile(f.file, JSON.stringify([binding]), { mode: 0o600 });
  const config = await loadConfig({ env: { ...f.env, PI_CONNECTIONS_FILE: f.file } });
  assert.equal(config.backendEnv.PI_CONNECTIONS[0].auth.password, binding.auth.password);
  const metadata = piConnections(config.backendEnv), serialized = JSON.stringify(metadata);
  assert.equal(metadata.configured, true);
  for (const privateValue of [binding.auth.username, binding.auth.password, binding.baseUrl, binding.inputs[0].path]) assert.ok(!serialized.includes(privateValue));
});

test('standalone PI rejects missing, malformed, oversized and unsafe private profiles without leaking their contents', async t => {
  const f = await fixture(t), env = { ...f.env, PI_CONNECTIONS_FILE: f.file };
  await assert.rejects(loadConfig({ env }), /PI_CONNECTIONS_FILE/);
  for (const content of ['{ "secret": "DO-NOT-EXPOSE",', JSON.stringify([{ ...profile(), baseUrl: 'http://unsafe.test/piwebapi' }]), ' '.repeat(1_000_001)]) {
    await writeFile(f.file, content);
    await assert.rejects(loadConfig({ env }), error => {
      assert.match(error.message, /PI_CONNECTIONS_FILE/);
      assert.ok(!error.message.includes('DO-NOT-EXPOSE'));
      assert.ok(!error.message.includes('unsafe.test'));
      return true;
    });
  }
  await assert.rejects(loadConfig({ env: { ...f.env, PI_CONNECTIONS_FILE: f.dataDir } }), /PI_CONNECTIONS_FILE/);
});
