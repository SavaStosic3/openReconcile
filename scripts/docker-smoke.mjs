// Runs only against isolated, disposable Compose projects and volumes.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const suffix = randomBytes(6).toString('hex');
const project = `openreconcile-smoke-${suffix}`, restoredProject = `${project}-restore`;
const volume = `${project}-data`, restoredVolume = `${restoredProject}-data`;
const password = randomBytes(24).toString('base64url');
const portFinder = createServer();
await new Promise((resolve, reject) => { portFinder.once('error', reject); portFinder.listen(0, '127.0.0.1', resolve); });
const port = portFinder.address().port;
await new Promise(resolve => portFinder.close(resolve));
const origin = `http://localhost:${port}`;

function compose(args, { restored = false, input } = {}) {
  const result = spawnSync('docker', ['compose', '-p', restored ? restoredProject : project, ...args], {
    cwd: root, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, PUBLIC_ORIGIN: origin, BIND_ADDRESS: '127.0.0.1', HTTP_PORT: String(port), OPENRECONCILE_DATA_VOLUME: restored ? restoredVolume : volume },
    ...(input !== undefined ? { input } : {}),
  });
  // Do not print inputs: the setup operation receives credentials through stdin.
  assert.equal(result.status, 0, `Compose ${args[0]} failed: ${result.error?.message ?? result.stderr ?? 'unknown error'}`);
  return result.stdout;
}

let cookie = '';
async function api(path, { method = 'GET', body, expected = 200, headers = {} } = {}) {
  const response = await fetch(`${origin}${path}`, {
    method, signal: AbortSignal.timeout(30_000),
    // Container recreation deliberately closes the old process. Do not reuse
    // a pooled connection after synchronous Docker commands replace it.
    headers: { Origin: origin, Connection: 'close', ...(cookie ? { Cookie: cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal(response.status, expected, `${method} ${path}: expected ${expected}, received ${response.status}`);
  if (path === '/api/auth/login' && response.ok) cookie = response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  return response.json();
}
const close = (actual, expected) => assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) < 1e-7, `Expected ${expected}; received ${actual}`);

try {
  compose(['config', '--quiet']);
  const setup = "import {readFileSync} from 'node:fs'; import {setupAdmin,addUser} from './deploy/accounts.js'; const {password}=JSON.parse(readFileSync(0,'utf8')); await setupAdmin({dataDir:'/data',username:'SmokeAdmin',password}); await addUser({dataDir:'/data',username:'SmokeViewer',password,role:'viewer'});";
  compose(['run', '--rm', '-T', 'app', 'node', '--input-type=module', '-e', setup], { input: JSON.stringify({ password }) });
  compose(['up', '-d', '--no-build', '--wait', '--wait-timeout', '90', 'app']);
  console.info('Container initialized and healthy.');
  const page = await fetch(origin, { headers: { Connection: 'close' }, signal: AbortSignal.timeout(10_000) });
  assert.ok(page.ok); assert.match(await page.text(), /name="openreconcile-auth-mode" content="password"/);
  await api('/healthz');
  await api('/api/workspace', { expected: 401, headers: { 'oai-authenticated-user-id': 'spoof', 'oai-authenticated-user-email': 'admin@example.test', 'CF-Connecting-IP': '1.2.3.4' } });
  await api('/api/auth/chatgpt', { expected: 404 });
  await api('/api/auth/login', { method: 'POST', body: { username: 'SmokeAdmin', password }, expected: 403, headers: { Origin: 'https://untrusted.example' } });
  await api('/api/auth/login', { method: 'POST', body: { username: 'SmokeAdmin', password } });
  assert.equal((await api('/api/session')).user.role, 'admin');
  const ids = [];
  for (const [file, objective, expectedFlows] of [
    ['showcase-model.json', 0.4, [804,804,201,1056,1056,951,105,900,51]],
    ['storage-showcase-model.json', 100/350, [1010-20/7,805+5/7,805+5/7,604+2/7,604+2/7,500+20/7]],
  ]) {
    const model = JSON.parse(await readFile(new URL(`../examples/${file}`, import.meta.url), 'utf8'));
    const created = await api('/api/models', { method: 'POST', body: { model }, expected: 201 });
    ids.push(created.entry.id);
    await api(`/api/models/${created.entry.id}/publication`, { method: 'PATCH', body: { published: true, revision: created.permission.revision } });
    const { run } = await api(`/api/models/${created.entry.id}/runs`, { method: 'POST', body: { trigger: 'manual', target: 'published' } });
    assert.ok(['ok','warning'].includes(run.status)); close(run.result.objective, objective);
    assert.equal(run.reportingPeriod.periodHours, 1);
    run.result.streams.forEach((stream, index) => close(stream.value, expectedFlows[index]));
    run.result.balances.forEach(balance => close(balance.reconciled, 0));
    if (file.startsWith('storage')) {
      const raw = [[2000,2200],[3000,3200],[4000,4100]];
      run.result.inventories.forEach((stock,index) => {
        close(stock.opening.value,raw[index][0]-5/7); close(stock.closing.value,raw[index][1]+5/7);
        close(stock.accumulation.value,raw[index][1]-raw[index][0]+10/7);
        close(stock.accumulation.uncertainty,Math.sqrt(50-2500/350));
      });
    }
  }
  await api('/api/auth/login', { method: 'POST', body: { username: 'SmokeViewer', password } });
  console.info('Both analytical showcase reconciliations passed.');
  assert.equal((await api('/api/session')).user.role,'viewer');
  await api('/api/admin', { expected: 403 });
  await api(`/api/models/${ids[0]}/runs`, { method: 'POST', body: { trigger:'manual',target:'published' }, expected: 403 });
  assert.equal((await api('/api/workspace')).catalog.models.length,0);
  console.info('Restricted-user permissions passed.');
  await api('/api/auth/login', { method: 'POST', body: { username: 'SmokeAdmin', password } });
  const scheduledWorkspace = await api('/api/workspace');
  assert.equal(scheduledWorkspace.scheduling.mode, 'server');
  assert.equal(scheduledWorkspace.scheduling.enabled, true);
  for (const id of ids) {
    await api(`/api/models/${id}/schedule`, { method: 'PATCH', body: { revision: scheduledWorkspace.permissions[id].revision, changes: { enabled: true, intervalMinutes: 60 } } });
    // A stale or active browser cannot issue a second scheduled execution on a
    // company server. Scheduling belongs to the durable server worker.
    await api(`/api/models/${id}/runs`, { method: 'POST', body: { trigger: 'scheduled' }, expected: 409 });
  }
  await api('/api/auth/logout', { method: 'POST', body: {} });
  cookie = '';
  await api('/api/workspace', { expected: 401 });
  const forceDue = "import {openDatabase} from './deploy/sqlite.js'; const db=openDatabase({dataDir:'/data'}); try { for(const row of (await db.prepare('SELECT id,schedule_json FROM models WHERE deleted_at IS NULL').all()).results) { const schedule=JSON.parse(row.schedule_json); schedule.nextRunAt=new Date(Date.now()-1000).toISOString(); await db.prepare('UPDATE models SET schedule_json=? WHERE id=?').bind(JSON.stringify(schedule),row.id).run(); } } finally { db.close(); }";
  compose(['exec','-T','app','node','--input-type=module','-e',forceDue]);
  const waitForRuns = "import {openDatabase} from './deploy/sqlite.js'; const db=openDatabase({dataDir:'/data'}); try { const deadline=Date.now()+45000; let runs; do { runs=(await db.prepare(\"SELECT run_json FROM model_runs WHERE json_extract(run_json,'$.trigger')='scheduled' ORDER BY model_id\").all()).results.map(row=>JSON.parse(row.run_json)); if(runs.length===2&&runs.every(run=>run.status!=='running')) break; if(runs.length>2) throw Error('Duplicate scheduled runs'); await new Promise(resolve=>setTimeout(resolve,250)); } while(Date.now()<deadline); if(runs.length!==2||runs.some(run=>run.status==='running')) throw Error('The server did not reconcile without a browser'); console.log(JSON.stringify(runs)); } finally { db.close(); }";
  const unattendedRuns = JSON.parse(compose(['exec','-T','app','node','--input-type=module','-e',waitForRuns]));
  assert.equal(unattendedRuns.length, 2);
  for (const run of unattendedRuns) {
    assert.equal(run.trigger, 'scheduled'); assert.equal(run.target, 'published'); assert.equal(run.publishedVersion, 1);
    assert.ok(['ok','warning'].includes(run.status), run.error);
    close(run.result.objective, run.modelName === 'Three-tank transfer' ? 100/350 : 0.4);
    run.result.balances.forEach(balance => close(balance.reconciled, 0));
    assert.equal(new Date(run.reportingPeriod.start).getUTCMinutes(), 0);
    assert.equal(new Date(run.reportingPeriod.end).getUTCMinutes(), 0);
  }
  console.info('Both published analytical models reconciled unattended with all sessions logged out.');
  await api('/api/auth/login', { method: 'POST', body: { username: 'SmokeAdmin', password } });
  const before = await api('/api/workspace');
  compose(['exec','-T','app','node','deploy/cli.mjs','backup','--output','/data/backups/smoke']);
  compose(['up','-d','--no-build','--force-recreate','--wait','--wait-timeout','90','app']);
  const after = await api('/api/workspace');
  assert.deepEqual(after.catalog.models,before.catalog.models);
  // The saved claim advances its due time atomically, so restarting a worker
  // must not replay either completed run.
  assert.deepEqual(after.catalog.runs, before.catalog.runs);
  console.info('Container recreation preserved models, runs, and sessions without replaying scheduled work.');
  compose(['stop','app']);
  const restore = "import {readFileSync,writeFileSync} from 'node:fs'; import {createHash} from 'node:crypto'; const dir='/source/backups/smoke/'; const manifest=JSON.parse(readFileSync(dir+'backup-manifest.json','utf8')); for(const name of ['app.sqlite','server-secrets.json']) { const bytes=readFileSync(dir+name); if(createHash('sha256').update(bytes).digest('hex')!==manifest.files[name]) throw Error('Invalid backup'); writeFileSync('/data/'+name,bytes,{flag:'wx',mode:0o600}); }";
  compose(['run','--rm','-T','--volume',`${volume}:/source:ro`,'app','node','--input-type=module','-e',restore],{restored:true});
  compose(['up','-d','--no-build','--wait','--wait-timeout','90','app'],{restored:true});
  const recovered=await api('/api/workspace');
  assert.deepEqual(recovered.catalog.models,before.catalog.models);
  assert.deepEqual(recovered.catalog.runs,before.catalog.runs);
  console.info('Docker smoke passed: private login, RBAC, both analytical reconciliations, unattended scheduling, no restart replay, and backup restoration.');
} finally {
  // Names are generated here and cannot target the company's persistent volume.
  for(const restored of [true,false]) {
    try { compose(['down','--volumes','--remove-orphans'],{restored}); }
    catch(error) { console.error(`Disposable smoke cleanup failed: ${error.message}`); process.exitCode=1; }
  }
}
