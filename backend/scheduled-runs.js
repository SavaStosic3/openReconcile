import { Repository, accessClause } from './repository.js';
import { ApiError } from './policy.js';
import { createCatalog, advanceSchedule } from '../public/management-store.js';
import { resolveReportingPeriod, defaultReportingSettings } from '../public/reporting-periods.js';
import { executeModelRun } from '../public/schedule-runner.js';
import { connectorAdapters } from './connectors.js';

const activeStates = "('claimed','running','output')";
const changed = result => Number(result?.meta?.changes ?? 0) > 0;
const clone = value => structuredClone(value);
const terminalStates = new Set(['finished', 'interrupted', 'cancelled']);
const cancelled = message => Object.assign(new Error(message), { cancelled: true });

function catalogFor(model, target = 'published') {
  const catalog = createCatalog(target === 'published' ? model.publishedModel : model.model, { id: model.id, now: target === 'published' ? model.publishedAt : model.updatedAt });
  catalog.schedules[model.id] = model.schedule;
  catalog.sources[model.id] = model.sources;
  return catalog;
}

function pendingRun(model, id, actor, scheduledAt, now, { target = 'published', trigger = 'scheduled', period: selectedPeriod = null } = {}) {
  const source = target === 'published' ? model.publishedModel : model.model;
  const settings = model.schedule.reporting ?? defaultReportingSettings(source);
  const period = resolveReportingPeriod(settings, source, now, selectedPeriod);
  const startedAt = new Date(now).toISOString();
  return {
    id, modelId: model.id, modelName: source.name, modelUpdatedAt: target === 'published' ? model.publishedAt : model.updatedAt,
    target, publishedVersion: target === 'published' ? model.publishedVersion : null, trigger, startedAt, finishedAt: startedAt,
    inputSourceId: model.schedule.inputSourceId, outputSourceId: model.schedule.outputSourceId,
    modelSnapshot: { ...clone(source), periodHours: period.periodHours },
    reportingPeriod: { ...period, modelPeriodHours: source.periodHours, settings },
    result: null, status: 'running', error: null,
    execution: { state: 'running', scheduledAt, actorId: actor.id, actorName: actor.name, delivery: 'not_attempted' }
  };
}

// Shared by the standalone worker and authenticated workspace reads. No job
// credentials, ownership token, or captured model are exposed to the browser.
export async function schedulingStatus(repo, modelIds) {
  const executions = {};
  for (const id of modelIds) {
    const model = await repo.model(id);
    if (!model) continue;
    const authorization = await repo.first('SELECT authorization.*,users.name AS actor_name FROM schedule_authorizations authorization JOIN users ON users.id=authorization.user_id WHERE model_id=?', [id]);
    const latest = await repo.first("SELECT * FROM scheduled_jobs WHERE model_id=? AND trigger='scheduled' ORDER BY claimed_at DESC,id DESC LIMIT 1", [id]);
    const run = latest ? JSON.parse(latest.run_json) : null;
    const actor = authorization ? await repo.user(authorization.user_id) : null;
    const permission = actor ? await repo.permission(actor, model) : null;
    const blocked = model.schedule.enabled && (!authorization || !permission?.canSchedule);
    executions[id] = {
      status: blocked ? 'needs_authorization' : latest ? terminalStates.has(latest.state) ? latest.state === 'finished' ? run.status : latest.state : latest.state === 'claimed' ? 'running' : latest.state : model.schedule.enabled ? 'ready' : 'disabled',
      startedAt: run?.startedAt ?? null,
      error: blocked ? 'Save this schedule again with an account authorized to schedule this model.' : run?.error ?? null,
      actorId: authorization?.user_id ?? null, actorName: authorization?.actor_name ?? null,
      ...(latest ? { runId: latest.id, scheduledAt: latest.scheduled_at, delivery: run.execution?.delivery ?? 'not_attempted' } : {})
    };
  }
  return executions;
}

// The worker has no HTTP identity or fabricated administrator. An explicit
// schedule save authorizes its existing user; every execution stage repeats
// that user's current role/grant and model configuration in guarded SQL.
export function createScheduledRunner(env, { now = typeof env.NOW === 'function' ? env.NOW : Date.now, uuid = typeof env.UUID === 'function' ? env.UUID : () => crypto.randomUUID(), leaseMs = 120_000 } = {}) {
  if (!env?.STANDALONE_SCHEDULER) throw new Error('Unattended scheduling is available only in the standalone server.');
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000) throw new Error('The scheduler lease must be at least one second.');
  const repo = new Repository(env.DB, { now, uuid, standaloneScheduler: true }), ownerToken = uuid();
  let pending = null, stopping = false;
  const active = new Set();

  const prune = id => [
    repo.statement('DELETE FROM model_runs WHERE model_id=? AND id NOT IN (SELECT id FROM model_runs WHERE model_id=? ORDER BY started_at DESC,id DESC LIMIT 20)', [id,id]),
    repo.statement(`DELETE FROM scheduled_jobs WHERE model_id=? AND state NOT IN ${activeStates} AND id NOT IN (SELECT id FROM scheduled_jobs WHERE model_id=? ORDER BY claimed_at DESC,id DESC LIMIT 20)`, [id,id])
  ];
  const persistRun = (id, condition = '1=1', values = []) => repo.statement(`INSERT INTO model_runs(id,model_id,run_json,started_at,created_by) SELECT id,model_id,run_json,json_extract(run_json,'$.startedAt'),actor_id FROM scheduled_jobs WHERE id=? AND ${condition} ON CONFLICT(id) DO UPDATE SET run_json=excluded.run_json`, [id,...values]);
  const uncertainPause = (jobId,modelId) => {
    const stamp=repo.stamp();
    // This update follows the fenced terminal-job write in the SAME batch.
    // changes()>0 proves this worker actually finalized/recovered the job.
    // Pausing prevents a later occurrence from exporting the same reporting
    // period again while the earlier destination outcome is still unknown.
    const pause=repo.statement(`UPDATE models SET schedule_json=json_set(schedule_json,'$.enabled',json('false'),'$.nextRunAt',NULL),revision=revision+1,updated_at=? WHERE id=? AND json_extract(schedule_json,'$.enabled')=1 AND changes()>0 AND EXISTS(SELECT 1 FROM scheduled_jobs WHERE id=? AND state IN ('finished','interrupted','cancelled') AND json_extract(run_json,'$.execution.delivery')='uncertain')`,[stamp,modelId,jobId]);
    const audit=repo.statement(`INSERT INTO audit_events(id,occurred_at,actor_id,actor_name,model_id,model_name,category,action,summary,target_id,target_name,changes_json,revision_before,revision_after,truncated) SELECT ?,?,job.actor_id,json_extract(job.run_json,'$.execution.actorName'),models.id,models.name,'schedule','delivery_paused',?,job.id,'Reconciliation run',?,models.revision-1,models.revision,0 FROM models JOIN scheduled_jobs job ON job.model_id=models.id WHERE job.id=? AND changes()>0`,[repo.uuid(),stamp,'Paused automatic reconciliation because output delivery is uncertain. Review the destination before enabling the schedule again.',JSON.stringify([{field:'enabled',before:true,after:false},{field:'outputDelivery',before:null,after:'uncertain'}]),jobId]);
    return [pause,audit];
  };

  async function heartbeat() {
    if (!active.size) return;
    const stamp = now();
    await repo.statement(`UPDATE scheduled_jobs SET lease_until=? WHERE owner_token=? AND state IN ${activeStates} AND lease_until>?`, [stamp+leaseMs, ownerToken, stamp]).run();
  }

  async function recover() {
    const stamp = now(), rows = await repo.all(`SELECT * FROM scheduled_jobs WHERE state IN ${activeStates} AND lease_until<=? ORDER BY claimed_at,id LIMIT 100`, [stamp]);
    let count = 0;
    for (const row of rows) {
      const run = JSON.parse(row.run_json), outputUncertain = row.state === 'output' || run.execution?.delivery === 'uncertain';
      run.status = 'failed'; run.finishedAt = new Date(Math.max(stamp,Date.parse(run.startedAt))).toISOString();
      run.error = outputUncertain ? 'The reconciliation was interrupted while output delivery was in progress. Delivery is uncertain; verify the destination before manually rerunning this period or enabling its schedule again. No automatic retry was performed.' : 'The reconciliation was interrupted before completion. No automatic retry was performed; this period can be rerun manually.';
      run.execution = { ...run.execution, state: 'interrupted', delivery: outputUncertain ? 'uncertain' : 'not_attempted' };
      const update = repo.statement(`UPDATE scheduled_jobs SET state='interrupted',run_json=?,finished_at=? WHERE id=? AND state IN ${activeStates} AND lease_until<=?`, [JSON.stringify(run),run.finishedAt,row.id,stamp]);
      const results = await repo.db.batch([update,...uncertainPause(row.id,row.model_id),persistRun(row.id,"state='interrupted'"),...prune(row.model_id)]);
      if (changed(results[0])) count++;
    }
    return count;
  }

  async function claim(model) {
    const authorization = await repo.first('SELECT * FROM schedule_authorizations WHERE model_id=?', [model.id]);
    if (!authorization) return null;
    const actor = await repo.user(authorization.user_id);
    if (!actor || !(await repo.permission(actor,model)).canSchedule) return null;
    const stamp = now(), scheduledAt = model.schedule.nextRunAt;
    if (!model.publishedModel || !model.schedule.enabled || !Number.isFinite(Date.parse(scheduledAt)) || Date.parse(scheduledAt)>stamp) return null;
    const id = uuid(), run = pendingRun(model,id,actor,scheduledAt,stamp), advanced = advanceSchedule(catalogFor(model), model.id, stamp).schedules[model.id];
    const snapshot = { ...model, schedule: advanced, authorization: { userId: actor.id, generation: authorization.generation } };
    const guard = accessClause('edit', actor.id);
    const insert = repo.statement(`INSERT OR IGNORE INTO scheduled_jobs(id,model_id,actor_id,generation,scheduled_at,owner_token,lease_until,state,snapshot_json,run_json,claimed_at) SELECT ?,models.id,?,?,?,?,?,'claimed',?,?,? FROM models JOIN schedule_authorizations authorization ON authorization.model_id=models.id WHERE models.id=? AND models.revision=? AND models.deleted_at IS NULL AND models.published=1 AND models.published_version=? AND models.schedule_json=? AND authorization.user_id=? AND authorization.generation=? AND ${guard.sql}`, [id,actor.id,authorization.generation,scheduledAt,ownerToken,stamp+leaseMs,JSON.stringify(snapshot),JSON.stringify(run),run.startedAt,model.id,model.revision,model.publishedVersion,JSON.stringify(model.schedule),actor.id,authorization.generation,...guard.values]);
    const advance = repo.statement(`UPDATE models SET schedule_json=?,revision=revision+1,updated_at=? WHERE id=? AND EXISTS(SELECT 1 FROM scheduled_jobs WHERE id=? AND owner_token=? AND state='claimed')`, [JSON.stringify(advanced),run.startedAt,model.id,id,ownerToken]);
    const results = await repo.db.batch([insert,advance,persistRun(id,"state='claimed' AND owner_token=?",[ownerToken]),...prune(model.id)]);
    if (!changed(results[0])) return null;
    return { id, actor, snapshot, run };
  }

  function stageGuard(job) {
    if (job.run.trigger==='manual') {
      const model=job.snapshot, guard=accessClause('run',job.actor.id);
      const snapshotClause=job.run.target==='published' ? 'models.published=1 AND models.published_version=? AND models.published_model_json=?' : 'models.model_json=?';
      const snapshotValues=job.run.target==='published' ? [model.publishedVersion,JSON.stringify(model.publishedModel)] : [JSON.stringify(model.model)];
      return {
        sql:`EXISTS(SELECT 1 FROM models WHERE models.id=scheduled_jobs.model_id AND models.deleted_at IS NULL AND ${snapshotClause} AND models.schedule_json=? AND models.sources_json=? AND ${guard.sql})`,
        values:[...snapshotValues,JSON.stringify(model.schedule),JSON.stringify(model.sources),...guard.values]
      };
    }
    const model = job.snapshot, guard = accessClause('edit',job.actor.id);
    return {
      sql: `EXISTS(SELECT 1 FROM models JOIN schedule_authorizations authorization ON authorization.model_id=models.id WHERE models.id=scheduled_jobs.model_id AND models.deleted_at IS NULL AND models.published=1 AND models.published_version=? AND models.published_model_json=? AND models.schedule_json=? AND models.sources_json=? AND authorization.user_id=? AND authorization.generation=? AND ${guard.sql})`,
      values: [model.publishedVersion,JSON.stringify(model.publishedModel),JSON.stringify(model.schedule),JSON.stringify(model.sources),job.actor.id,model.authorization.generation,...guard.values]
    };
  }
  async function checkpoint(job, state, run = null) {
    const guard = stageGuard(job), stamp = now();
    const update = repo.statement(`UPDATE scheduled_jobs SET state=?,lease_until=?${run ? ',run_json=?' : ''} WHERE id=? AND owner_token=? AND state IN ${activeStates} AND lease_until>? AND ${guard.sql}`, [state,stamp+leaseMs,...(run ? [JSON.stringify(run)] : []),job.id,ownerToken,stamp,...guard.values]);
    const results = await repo.db.batch([update,...(run ? [persistRun(job.id,'owner_token=? AND state=?',[ownerToken,state])] : [])]);
    if (!changed(results[0])) throw cancelled('The schedule, publication, scheduling account, or worker lease changed before this run could continue.');
  }

  async function finish(job, run, state = 'finished') {
    const stamp = now();
    run.execution = { ...job.run.execution, ...run.execution, state };
    const update = repo.statement(`UPDATE scheduled_jobs SET state=?,run_json=?,finished_at=? WHERE id=? AND owner_token=? AND state IN ${activeStates} AND lease_until>?`, [state,JSON.stringify(run),run.finishedAt,job.id,ownerToken,stamp]);
    // Authorization was proven at claim and recorded durably. Saving the final
    // failure must remain possible after revocation, unpublishing, or deletion.
    const results = await repo.db.batch([update,...uncertainPause(job.id,job.snapshot.id),persistRun(job.id,'owner_token=? AND state=?',[ownerToken,state]),...prune(job.snapshot.id)]);
    return changed(results[0]);
  }

  async function execute(job) {
    active.add(job.id); let outputStarted = false, invalidated = false, latestRun=job.run;
    const completed = async (run,state) => {
      if (await finish(job,run,state)) return run;
      // A lease lost to recovery is fenced from completion. Return the durable
      // outcome, rather than reporting an obsolete worker's apparent success.
      await recover();
      const saved=await repo.first('SELECT run_json FROM scheduled_jobs WHERE id=?',[job.id]);
      return saved ? JSON.parse(saved.run_json) : run;
    };
    try {
      await checkpoint(job,'running');
      const adapters = connectorAdapters(env), inputAdapters = {};
      for (const [key, adapter] of Object.entries(adapters.inputAdapters)) inputAdapters[key] = async (...args) => {
        const imported = await adapter(...args);
        try { await checkpoint(job,'running'); } catch (error) { invalidated=true; throw error; }
        return imported;
      };
      const result = await executeModelRun(catalogFor(job.snapshot,job.run.target),job.snapshot.id, {
        trigger:job.run.trigger,id:job.id,now,target:job.run.target,publishedVersion:job.run.publishedVersion,
        period:{start:job.run.reportingPeriod.start,end:job.run.reportingPeriod.end,kind:job.run.reportingPeriod.kind},
        ...adapters,inputAdapters,
        beforeOutput: async run => {
          latestRun=run;
          if (Date.parse(run.finishedAt)<Date.parse(run.startedAt)) throw new Error('The execution clock moved before the run start.');
          // The calculation is available, but the run is still in progress
          // until its destination confirms delivery. Published views must not
          // select this checkpoint as a completed reconciliation.
          run.status='running';
          run.execution = { ...job.run.execution,state:'output',delivery:'uncertain' };
          try { await checkpoint(job,'output',run); } catch (error) { invalidated=true; throw error; }
          latestRun=run;
          outputStarted=true;
        }
      });
      const run = result.run; latestRun=run;
      if (!outputStarted && !invalidated) {
        try { await checkpoint(job,'running'); }
        catch (error) { invalidated=true; run.status='failed';run.error=error.message; }
      }
      run.execution = { ...job.run.execution,delivery:outputStarted ? run.error ? 'uncertain' : 'confirmed' : 'not_attempted' };
      const previous = (await repo.runs(job.snapshot.id,job.snapshot)).findLast(item => item.id!==job.id && item.target===run.target && item.publishedVersion===run.publishedVersion && item.reportingPeriod?.start===run.reportingPeriod.start && item.reportingPeriod?.end===run.reportingPeriod.end && item.reportingPeriod?.kind===run.reportingPeriod.kind);
      if (previous) run.rerunOf=previous.id;
      return await completed(run,invalidated?'cancelled':'finished');
    } catch (error) {
      // A persistence/history error after SQL output must retain the completed
      // calculation and its input audit. The durable output checkpoint is a
      // fallback when the runner did not return its final in-memory record.
      let baseline=latestRun;
      if (!baseline.result) {
        try { const saved=await repo.first('SELECT run_json FROM scheduled_jobs WHERE id=?',[job.id]); if(saved) baseline=JSON.parse(saved.run_json); } catch {}
      }
      const run = { ...baseline,status:'failed',finishedAt:new Date(Math.max(now(),Date.parse(baseline.startedAt))).toISOString(),error:error instanceof ApiError ? error.message : error instanceof Error ? error.message : 'Reconciliation could not be completed.' };
      run.execution = { ...run.execution,delivery:outputStarted ? baseline.execution?.delivery==='confirmed' ? 'confirmed' : 'uncertain' : 'not_attempted' };
      return await completed(run,error.cancelled?'cancelled':'finished');
    } finally { active.delete(job.id); }
  }

  async function doTick() {
    await recover();
    if (env.SCHEDULER_ENABLED===false || stopping) return [];
    const rows = await repo.all(`SELECT models.id FROM models JOIN schedule_authorizations authorization ON authorization.model_id=models.id WHERE models.deleted_at IS NULL AND models.published=1 AND json_extract(models.schedule_json,'$.enabled')=1 AND json_extract(models.schedule_json,'$.nextRunAt')<=? AND EXISTS(SELECT 1 FROM users actor LEFT JOIN model_grants grant_row ON grant_row.user_id=actor.id AND grant_row.model_id=models.id WHERE actor.id=authorization.user_id AND actor.active=1 AND (actor.role='admin' OR (actor.role='editor' AND grant_row.level='editor'))) AND NOT EXISTS(SELECT 1 FROM scheduled_jobs WHERE scheduled_jobs.model_id=models.id AND state IN ${activeStates}) ORDER BY json_extract(models.schedule_json,'$.nextRunAt'),models.id LIMIT 100`, [repo.stamp()]);
    const runs = [];
    for (const row of rows) {
      if (stopping) break;
      try {
        const model = await repo.model(row.id);
        if (!model) continue;
        const job = await claim(model);
        if (job) runs.push(await execute(job));
      } catch (error) {
        // A malformed or temporarily unavailable model must not starve the
        // other due schedules. Execution errors after claim are durable above.
        console.error('A scheduled model could not be claimed.', row.id, error instanceof Error ? error.message : 'Unexpected scheduler error');
      }
    }
    return runs;
  }
  return {
    leaseMs, heartbeat, recover,
    async tick() {
      await heartbeat();
      if (stopping || pending) return [];
      pending=doTick();
      try { return await pending; } finally { pending=null; }
    },
    async drain() { stopping=true; if (pending) await pending; },
    async manual(actor,model,options) {
      const stamp=now(),id=options.id??uuid(),run=pendingRun(model,id,actor,null,stamp,{target:options.target,trigger:'manual',period:options.period});
      const guard=accessClause('run',actor.id),snapshot={...model};
      const insert=repo.statement(`INSERT OR IGNORE INTO scheduled_jobs(id,model_id,actor_id,trigger,generation,scheduled_at,owner_token,lease_until,state,snapshot_json,run_json,claimed_at) SELECT ?,id,?,'manual',0,?,?,?,'claimed',?,?,? FROM models WHERE id=? AND revision=? AND deleted_at IS NULL AND ${guard.sql}`, [id,actor.id,id,ownerToken,stamp+leaseMs,JSON.stringify(snapshot),JSON.stringify(run),run.startedAt,model.id,model.revision,...guard.values]);
      const results=await repo.db.batch([insert,persistRun(id,"state='claimed' AND owner_token=?",[ownerToken]),...prune(model.id)]);
      if (!changed(results[0])) {
        if (await repo.first(`SELECT id FROM scheduled_jobs WHERE model_id=? AND state IN ${activeStates} LIMIT 1`,[model.id])) throw new ApiError(409,'A reconciliation is already running for this model. Wait for it to finish before running manually.');
        await repo.rejectWrite(actor,model.id,model.revision,'canRun');
      }
      return execute({id,actor,snapshot,run});
    },
    async status() { return schedulingStatus(repo,(await repo.all('SELECT id FROM models WHERE deleted_at IS NULL')).map(row=>row.id)); }
  };
}

// Manual and scheduled runs reserve the same active-model lease. This closes
// both directions of the race: a worker cannot start during a manual output,
// and two manual requests cannot export concurrently. The manual lease has its
// own heartbeat so it also works when unattended scheduling is disabled.
export async function executeStandaloneManualRun(env,repo,user,model,catalog,options) {
  const runner=createScheduledRunner(env,{now:repo.now,uuid:repo.uuid});
  const heartbeat=setInterval(()=>runner.heartbeat().catch(error=>console.error('A manual reconciliation lease could not be renewed.',error instanceof Error?error.message:'Unexpected lease error')),Math.min(10_000,runner.leaseMs/3));
  heartbeat.unref?.();
  try { return {run:await runner.manual(user,model,options)}; }
  finally { clearInterval(heartbeat); }
}
