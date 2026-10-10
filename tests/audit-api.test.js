import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { handleApi } from '../backend/api.js';
import { Repository } from '../backend/repository.js';
import { exampleModel } from '../public/model.js';

function fixture(t) {
  const sqlite = new DatabaseSync(':memory:'); sqlite.exec('PRAGMA foreign_keys=ON');
  for (const file of ['0000_complete_random.sql','0001_published_snapshots.sql','0002_elite_layla_miller.sql','0003_kind_tempest.sql']) sqlite.exec(readFileSync(new URL(`../drizzle/${file}`, import.meta.url),'utf8'));
  let now = Date.parse('2026-10-10T12:00:00.000Z'), serial = 0, tail = Promise.resolve();
  const hooks = { beforeBatch: null, afterAll: null };
  const DB = { prepare(sql) { return { values: [], bind(...values) { assert.ok(values.length<=100,'D1 allows at most 100 bound parameters per statement.'); this.values = values; return this; }, async first() { return sqlite.prepare(sql).get(...this.values) ?? null; }, async all() { const results = sqlite.prepare(sql).all(...this.values); await hooks.afterAll?.(sql); return { results }; }, async run() { const r = sqlite.prepare(sql).run(...this.values); return { meta: { changes: Number(r.changes) } }; } }; }, async batch(statements) { const result = tail.then(async () => { await hooks.beforeBatch?.(); sqlite.exec('BEGIN'); try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; } catch (error) { sqlite.exec('ROLLBACK'); throw error; } }); tail = result.catch(() => {}); return result; } };
  const env = { DB, ADMIN_EMAIL: 'owner@example.test', NOW: () => now, UUID: () => `id-${String(++serial).padStart(8,'0')}` };
  const owner = { id: 'owner', email: 'owner@example.test', name: 'Owner' }, viewer = { id: 'viewer', email: 'viewer@example.test', name: 'Viewer' };
  const repo = new Repository(DB,{now: env.NOW,uuid: env.UUID});
  async function request(path,method='GET',body,identity=owner,extraHeaders={}) {
    const result = await handleApi(new Request(`https://balance.test${path}`,{ method, headers: { ...(method === 'GET' ? {} : { Origin:'https://balance.test','Content-Type':'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body:JSON.stringify(body) }) }),env,identity);
    return { status:result.status,body:await result.json() };
  }
  async function create() { const r = await request('/api/models','POST',{model:exampleModel()}); assert.equal(r.status,201,JSON.stringify(r.body)); return r.body.entry.id; }
  async function save(id,change) { const before = await repo.model(id), model=structuredClone(before.model); change(model); return request(`/api/models/${id}`,'PATCH',{revision:before.revision,model}); }
  t.after(() => sqlite.close());
  return { sqlite,env,owner,viewer,repo,hooks,request,create,save,advance:ms=>{now+=ms;} };
}

test('model audit records physical readings, mapping and structural changes with actor snapshots and guarded revisions',async t=>{
  const f=fixture(t),id=await f.create();
  await f.save(id,model=>{model.streams[0].value=123;model.streams[0].dataMapping={sourceName:'PLANT.FLOW'};model.name='New name';});
  const result=await f.request(`/api/audit?modelId=${id}`);assert.equal(result.status,200);
  assert.equal(result.body.settings.retentionDays,365);assert.equal(result.body.settings.revision,1);
  for(const category of ['measurement','mapping','model']) assert.ok(result.body.events.some(event=>event.category===category));
  const meter=result.body.events.find(event=>event.category==='measurement');
  assert.deepEqual(meter.actor,{id:'owner',name:'Owner'});assert.equal(meter.model.name,exampleModel().name);assert.equal(meter.revisionBefore,1);assert.equal(meter.revisionAfter,2);
  const value=meter.changes.find(change=>change.field==='value');assert.equal(value.before,100);assert.equal(value.after,123);
  assert.ok(!JSON.stringify(result.body).includes('password_hash'));
});

test('no-op, stale, locked, denied and invalid model writes never produce audit events',async t=>{
  const f=fixture(t),id=await f.create(),before=await f.repo.model(id);
  assert.equal((await f.request(`/api/models/${id}`,'PATCH',{revision:1,model:before.model})).status,200);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,1);
  const changed=structuredClone(before.model);changed.streams[0].value=130;
  assert.equal((await f.request(`/api/models/${id}`,'PATCH',{revision:1,model:changed})).status,409);
  assert.equal((await f.request(`/api/models/${id}`,'PATCH',{revision:2,model:changed},f.viewer)).status,403);
  assert.equal((await f.request(`/api/admin/models/${id}`,'PATCH',{revision:2,editLocked:true})).status,200);
  const n=f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  assert.equal((await f.request(`/api/models/${id}`,'PATCH',{revision:3,model:changed})).status,403);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,n);
});

test('an audit insert failure rolls back the underlying model mutation',async t=>{
  const f=fixture(t),id=await f.create();
  f.sqlite.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT,'fixture rejection'); END;");
  const result=await f.save(id,model=>{model.streams[0].value=200;});assert.equal(result.status,500);
  const after=await f.repo.model(id);assert.equal(after.revision,1);assert.equal(after.model.streams[0].value,100);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,1);
});

test('concurrent model saves audit only the winning revision and correct before value',async t=>{
  const f=fixture(t),id=await f.create(),model=(await f.repo.model(id)).model;
  const a=structuredClone(model),b=structuredClone(model);a.streams[0].value=200;b.streams[0].value=300;
  const results=await Promise.all([f.request(`/api/models/${id}`,'PATCH',{revision:1,model:a}),f.request(`/api/models/${id}`,'PATCH',{revision:1,model:b})]);
  assert.deepEqual(results.map(r=>r.status).sort(),[200,409]);
  const events=(await f.request(`/api/audit?category=measurement&modelId=${id}`)).body.events;assert.equal(events.length,1);
  assert.equal(events[0].changes.find(item=>item.field==='value').before,100);
  assert.equal(events[0].changes.find(item=>item.field==='value').after,(await f.repo.model(id)).model.streams[0].value);
});

test('fresh permissions guard mutations and history after grants or accounts are revoked',async t=>{
  const f=fixture(t),id=await f.create();await f.request('/api/session','GET',undefined,f.viewer);
  await f.request(`/api/admin/models/${id}/permissions`,'PUT',{userId:'viewer',level:'viewer'});
  assert.equal((await f.request('/api/audit','GET',undefined,f.viewer)).body.events.length,2);
  f.hooks.afterAll=async sql=>{if(sql.startsWith('SELECT event.*')){f.hooks.afterAll=null;f.sqlite.prepare('DELETE FROM model_grants WHERE user_id=?').run('viewer');}};
  assert.equal((await f.request('/api/audit','GET',undefined,f.viewer)).status,403);
  assert.equal((await f.request('/api/audit','GET',undefined,f.viewer)).body.events.length,0);
  await f.request('/api/admin/users/viewer','PATCH',{active:false});
  assert.equal((await f.request('/api/audit','GET',undefined,f.viewer)).status,403);
});

test('account and grant events snapshot authoritative names and race guards reject stale before states',async t=>{
  const f=fixture(t),id=await f.create();await f.request('/api/session','GET',undefined,f.viewer);
  assert.equal((await f.request('/api/admin/users/viewer','PATCH',{role:'editor'})).status,200);
  assert.equal((await f.request(`/api/admin/models/${id}/permissions`,'PUT',{userId:'viewer',level:'editor'})).status,200);
  const events=(await f.request('/api/audit?category=permission')).body.events;
  assert.equal(events.length,2);assert.ok(events.every(event=>event.target.name==='Viewer'));
  assert.ok(events.some(event=>event.changes.some(item=>item.before==='viewer'&&item.after==='editor')));
  const actor=await f.repo.user('owner');
  f.hooks.beforeBatch=async()=>{f.hooks.beforeBatch=null;f.sqlite.prepare("UPDATE users SET role='operator' WHERE id='viewer'").run();};
  await assert.rejects(f.repo.updateUser(actor,'viewer',{role:'admin'}),error=>error.status===409);
  f.hooks.beforeBatch=async()=>{f.hooks.beforeBatch=null;f.sqlite.prepare("UPDATE model_grants SET level='operator' WHERE user_id='viewer'").run();};
  await assert.rejects(f.repo.setGrant(actor,id,'viewer','viewer'),error=>error.status===409);
  assert.equal((await f.request('/api/audit?category=permission')).body.events.length,2);
});

test('viewers see only currently granted active models and never global account or retention events',async t=>{
  const f=fixture(t),a=await f.create(),b=await f.create();await f.request('/api/session','GET',undefined,f.viewer);
  await f.request(`/api/admin/models/${a}/permissions`,'PUT',{userId:'viewer',level:'viewer'});
  await f.request('/api/admin/users/viewer','PATCH',{role:'operator'});
  await f.request('/api/audit/settings','PATCH',{retentionDays:60,revision:1});
  const visible=(await f.request('/api/audit','GET',undefined,f.viewer)).body;
  assert.ok(visible.events.every(event=>event.model?.id===a));assert.deepEqual(visible.models.map(item=>item.id),[a]);
  assert.equal((await f.request(`/api/audit?modelId=${b}`,'GET',undefined,f.viewer)).body.events.length,0);
  assert.equal((await f.request('/api/audit/settings','PATCH',{retentionDays:0,revision:2},f.viewer)).status,403);
  const revision=(await f.repo.model(a)).revision;
  await f.request(`/api/admin/models/${a}`,'DELETE',{revision});
  assert.equal((await f.request('/api/audit','GET',undefined,f.viewer)).body.events.length,0);
  const admin=(await f.request('/api/audit')).body;assert.ok(admin.events.some(event=>event.action==='deleted'));assert.ok(admin.models.find(item=>item.id===a).deleted);
});

test('retention defaults, validation, optimistic changes and exact query-time cutoff leave model runs unchanged',async t=>{
  const f=fixture(t),id=await f.create();
  assert.equal((await f.request('/api/audit/settings')).body.settings.retentionDays,365);
  for(const value of [-1,3651,1.2,'30',null])assert.equal((await f.request('/api/audit/settings','PATCH',{retentionDays:value,revision:1})).status,400);
  const configured=await f.request('/api/audit/settings','PATCH',{retentionDays:1,revision:1});assert.equal(configured.status,200);assert.equal(configured.body.settings.revision,2);assert.deepEqual(configured.body.settings.updatedBy,{id:'owner',name:'Owner'});
  assert.equal((await f.request('/api/audit/settings','PATCH',{retentionDays:30,revision:1})).status,409);
  f.advance(24*60*60*1000);assert.ok((await f.request('/api/audit')).body.events.some(event=>event.action==='created'));
  f.advance(1);assert.equal((await f.request('/api/audit')).body.events.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM model_runs').get().n,0);
  assert.equal((await f.request('/api/audit/settings','PATCH',{retentionDays:0,revision:2})).status,200);
  await f.save(id,model=>{model.streams[0].value=111;});f.advance(4000*24*60*60*1000);
  assert.equal((await f.request('/api/audit?category=measurement')).body.events.length,1);
});

test('cleanup deletes at most 500 expired events per request and cascades dedicated readings',async t=>{
  const f=fixture(t),id=await f.create();await f.save(id,model=>{model.streams[0].value=150;});
  f.sqlite.prepare("UPDATE audit_events SET occurred_at='2020-01-01T00:00:00.000Z'").run();
  const insert=f.sqlite.prepare("INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,model_id,model_name,category,action,summary,changes_json) VALUES(?,'2020-01-01T00:00:00.000Z','owner','Owner',?,'Old','model','updated','Old','[]')");
  for(let i=0;i<1000;i++)insert.run(`old-${i}`,id);
  const before=f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  assert.equal((await f.request('/api/audit')).body.events.length,0);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,before-500);
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_readings').get().n,0);
  await f.request('/api/audit');assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,before-1000);
});

test('search filters and stable keyset pagination handle tied timestamps, escaped wildcards and new events',async t=>{
  const f=fixture(t),id=await f.create();for(let i=0;i<5;i++)await f.save(id,model=>{model.streams[0].value=110+i;});
  const first=(await f.request(`/api/audit?modelId=${id}&limit=2`)).body;assert.equal(first.events.length,2);assert.ok(first.nextCursor);
  await f.save(id,model=>{model.streams[0].value=199;});
  const second=(await f.request(`/api/audit?modelId=${id}&limit=2&cursor=${encodeURIComponent(first.nextCursor)}`)).body;
  assert.ok(second.events.every(event=>!first.events.some(previous=>previous.id===event.id)));
  assert.equal((await f.request('/api/audit?q=%25')).body.events.length,0);
  assert.equal((await f.request('/api/audit?actorId=owner&category=measurement')).body.events.length,6);
  assert.equal((await f.request('/api/audit?from=2026-10-10T12%3A00%3A00Z&to=2026-10-10T12%3A00%3A01Z')).body.events.length,7);
  assert.equal((await f.request('/api/audit?to=2026-10-10T12%3A00%3A00Z')).body.events.length,0);
});

test('historical endpoints strictly validate ranges, categories, cursors, repeated keys and methods',async t=>{
  const f=fixture(t);await f.create();
  for(const query of ['?limit=0','?limit=101','?limit=1.5','?from=2026-02-30T00:00:00Z','?from=2026-10-11T00:00:00Z&to=2026-10-10T00:00:00Z','?cursor=e30%3D','?category=runs','?limit=1&limit=2','?unknown=1','?q='])assert.equal((await f.request(`/api/audit${query}`)).status,400,query);
  assert.equal((await f.request('/api/audit/trends')).status,400);
  assert.equal((await f.request('/api/audit','POST',{})).status,405);
  assert.equal((await f.request('/api/audit/settings','PATCH',{retentionDays:30,revision:1},f.owner,{Origin:'https://evil.test'})).status,403);
});

test('literal historical searches support long ASCII and Unicode queries within D1 binding limits',async t=>{
  const f=fixture(t),id=await f.create(),long='Source'.repeat(20),unicode='工厂'.repeat(35);
  await f.save(id,model=>{model.streams[0].dataMapping={sourceName:long};});
  assert.ok((await f.request(`/api/audit?q=${encodeURIComponent(long)}`)).body.events.length);
  await f.save(id,model=>{model.streams[0].dataMapping={sourceName:unicode};});
  assert.ok((await f.request(`/api/audit?q=${encodeURIComponent(unicode)}`)).body.events.length);
  for(let i=0;i<105;i++)await f.save(id,model=>{model.streams[0].value=1000+i;});
  const page=await f.request('/api/audit?limit=100');assert.equal(page.status,200);assert.equal(page.body.events.length,100);
});

test('future revisions are rejected before a concurrent write can substitute a different audit before state',async t=>{
  const f=fixture(t),id=await f.create(),actor=await f.repo.user('owner'),model=(await f.repo.model(id)).model;
  model.streams[0].value=500;
  f.hooks.beforeBatch=async()=>{f.hooks.beforeBatch=null;f.sqlite.prepare('UPDATE models SET revision=2 WHERE id=?').run(id);};
  await assert.rejects(f.repo.updateModel(actor,id,model,2),error=>error.status===409);
  assert.equal((await f.repo.model(id)).revision,1);
  assert.equal((await f.request('/api/audit?category=measurement')).body.events.length,0);
});

test('actor metadata uses one latest name per actor while event snapshots retain earlier names',async t=>{
  const f=fixture(t),id=await f.create();
  const model=structuredClone((await f.repo.model(id)).model);model.streams[0].value=150;
  await f.request(`/api/models/${id}`,'PATCH',{revision:1,model},{...f.owner,name:'Updated owner'});
  const result=(await f.request('/api/audit','GET',undefined,{...f.owner,name:'Updated owner'})).body;
  assert.deepEqual(result.actors,[{id:'owner',name:'Updated owner'}]);
  assert.equal(result.events.find(event=>event.action==='created').actor.name,'Owner');
  assert.equal(result.events.find(event=>event.category==='measurement').actor.name,'Updated owner');
});

test('date ranges include their start and exclude exact next-day midnight',async t=>{
  const f=fixture(t),id=await f.create();f.advance(12*60*60*1000);
  await f.save(id,model=>{model.streams[0].value=150;});
  const result=(await f.request('/api/audit?from=2026-10-10T00%3A00%3A00Z&to=2026-10-11T00%3A00%3A00Z')).body;
  assert.equal(result.events.length,1);assert.equal(result.events[0].action,'created');
  assert.equal((await f.request('/api/audit?from=2026-10-11T00%3A00%3A00Z&to=2026-10-12T00%3A00%3A00Z')).body.events.length,1);
});

test('measurement trends show original physical values, unit transitions and clearing, excluding virtual caches and reconciliation runs',async t=>{
  const f=fixture(t),id=await f.create();
  await f.save(id,model=>{model.streams[0].value=110;});
  await f.save(id,model=>{model.streams[0].unit='t';});
  await f.save(id,model=>{model.streams[0].value=null;});
  await f.save(id,model=>{Object.assign(model.streams[0],{meterType:'virtual',formula:'1+2',value:999});});
  const result=await f.request(`/api/audit/trends?modelId=${id}&itemId=f1`);assert.equal(result.status,200);
  assert.equal(result.body.points.length,3);assert.equal(result.body.points[0].before,100);assert.equal(result.body.points[0].after,110);assert.equal(result.body.points[0].unit,'kg');
  assert.equal(result.body.points[1].before,110);assert.equal(result.body.points[1].after,110);assert.equal(result.body.points[1].previousUnit,'kg');assert.equal(result.body.points[1].unit,'t');
  assert.equal(result.body.points[2].after,null);assert.ok(!JSON.stringify(result.body.points).includes('999'));
});

test('bulk physical meter changes retain complete audit details and all reading points beyond one event chunk',async t=>{
  const f=fixture(t),id=await f.create();
  await f.save(id,model=>{const stream=model.streams[0];model.streams=Array.from({length:150},(_,i)=>({...stream,id:`meter-${i}`,label:`Meter ${i}`,value:i}));});
  const before=await f.repo.model(id);assert.equal(before.model.streams.length,150);
  const result=await f.save(id,model=>{for(const stream of model.streams)stream.value+=1000;});assert.equal(result.status,200);
  const events=(await f.request(`/api/audit?modelId=${id}&category=measurement&limit=100`)).body.events.filter(event=>event.revisionAfter===3);
  assert.equal(events.flatMap(event=>event.changes).filter(item=>item.field==='value').length,150);assert.ok(events.every(event=>event.changes.length<=100&&!event.truncated));
  assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_readings reading JOIN audit_events event ON event.id=reading.event_id WHERE revision_after=3').get().n,150);
  const trend=(await f.request(`/api/audit/trends?modelId=${id}&itemId=meter-149`)).body;
  assert.equal(trend.points.at(-1).before,149);assert.equal(trend.points.at(-1).after,1149);
});

test('trends keep the most recent 500 points in revision order within one millisecond',async t=>{
  const f=fixture(t),id=await f.create();
  const event=f.sqlite.prepare("INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,model_id,model_name,category,action,summary,changes_json,revision_after) VALUES(?,'2026-10-10T12:00:00.000Z','owner','Owner',?,'Model','measurement','updated','Changed','[]',?)");
  const reading=f.sqlite.prepare("INSERT INTO audit_readings(id,event_id,model_id,item_id,item_name,before_json,after_json,unit,metric,meter_type) VALUES(?,?,?,'f1','Feed',?,?,'kg','mass','physical')");
  for(let i=0;i<503;i++){const eventId=`trend-${String(503-i).padStart(4,'0')}`;event.run(eventId,id,i+2);reading.run(`reading-${i}`,eventId,id,String(i),String(i+1));}
  const result=(await f.request(`/api/audit/trends?modelId=${id}&itemId=f1`)).body;
  assert.equal(result.points.length,500);assert.equal(result.truncated,true);assert.equal(result.points[0].before,3);assert.equal(result.points.at(-1).after,503);
});

test('schedule, source, publication, lock, deletion and restoration edits are audited without full snapshots or gateway secrets',async t=>{
  const f=fixture(t),id=await f.create();
  Object.assign(f.env,{SQL_GATEWAY_URL:'https://gateway.test',SQL_GATEWAY_TOKEN:'s'.repeat(40),SQL_GATEWAY_FETCH:async()=>new Response(JSON.stringify({connections:[{id:'plant',name:'Plant',dialect:'postgres',canRead:true,canWrite:false}]}))});
  const source={id:'input',name:'Input',type:'sql',direction:'input',connectionId:'plant',table:'readings',tagColumn:'tag',valueColumn:'value',timestampColumn:'observed',aggregation:'latest'};
  assert.equal((await f.request(`/api/models/${id}/sources`,'PUT',{revision:1,sources:[source]})).status,200);
  assert.equal((await f.request(`/api/models/${id}/publication`,'PATCH',{revision:2,published:true})).status,200);
  assert.equal((await f.request(`/api/models/${id}/schedule`,'PATCH',{revision:3,changes:{intervalMinutes:120}})).status,200);
  assert.equal((await f.request(`/api/admin/models/${id}`,'PATCH',{revision:4,editLocked:true})).status,200);
  assert.equal((await f.request(`/api/admin/models/${id}`,'DELETE',{revision:5})).status,200);
  assert.equal((await f.request(`/api/admin/models/${id}/restore`,'POST',{revision:6})).status,200);
  const result=(await f.request(`/api/audit?modelId=${id}`)).body;
  for(const category of ['connector','publication','schedule'])assert.ok(result.events.some(event=>event.category===category));
  for(const action of ['created','published','deleted','restored','policy_changed'])assert.ok(result.events.some(event=>event.action===action));
  const serialized=JSON.stringify(result.events);assert.ok(!serialized.includes(f.env.SQL_GATEWAY_TOKEN));assert.ok(!serialized.includes('modelSnapshot'));assert.ok(!serialized.includes('run_json'));
  assert.equal((await f.request(`/api/audit/trends?modelId=${id}`)).status,200);
});

test('twenty reconciliation runs remain the exact cap and never produce audit or reading events',async t=>{
  const f=fixture(t),id=await f.create();
  const count=f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n;
  for(let i=0;i<23;i++){f.advance(1000);const r=await f.request(`/api/models/${id}/runs`,'POST',{trigger:'manual'});assert.equal(r.status,200);}
  assert.equal((await f.repo.runs(id)).length,20);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n,count);assert.equal(f.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_readings').get().n,0);
});
