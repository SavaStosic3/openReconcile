import { createScheduledRunner } from '../backend/scheduled-runs.js';

// Timers only wake the worker. Persisted due times, atomic database claims,
// and fenced execution leases decide which occurrence is allowed to run.
export function createScheduler(env, {
  enabled = true, pollSeconds = 5,
  onError = () => console.error('The reconciliation scheduler could not check its persistent jobs. It will retry.'),
  ...runnerOptions
} = {}) {
  if (typeof enabled !== 'boolean' || !Number.isInteger(pollSeconds) || pollSeconds < 1 || pollSeconds > 60) throw new Error('Choose a valid server scheduler configuration.');
  const runner = createScheduledRunner(env, runnerOptions);
  let stopping = false, closing, pendingTick, pendingHeartbeat;
  let lastCheckAt = null, lastError = null;

  const report = error => {
    lastError = 'The scheduler could not check its persistent jobs.';
    try { onError(error); } catch { /* Logging must not stop recovery. */ }
  };
  const tick = () => {
    if (stopping) return Promise.resolve();
    if (pendingTick) return pendingTick;
    pendingTick = (async () => {
      try {
        const result = await (enabled ? runner.tick() : runner.recover());
        lastCheckAt = new Date().toISOString(); lastError = null;
        return result;
      } catch (error) { report(error); throw error; }
      finally { pendingTick = null; }
    })();
    return pendingTick;
  };
  const heartbeat = () => {
    if (pendingHeartbeat) return pendingHeartbeat;
    pendingHeartbeat = (async () => {
      try { await runner.heartbeat(); }
      catch (error) { report(error); }
      finally { pendingHeartbeat = null; }
    })();
    return pendingHeartbeat;
  };
  const pollTimer = setInterval(() => { void tick().catch(() => {}); }, pollSeconds * 1000);
  const heartbeatTimer = setInterval(() => { void heartbeat(); }, Math.max(100, Math.min(10_000, Math.floor((runnerOptions.leaseMs ?? 120_000) / 3))));
  pollTimer.unref(); heartbeatTimer.unref();
  // Run on startup as well as after each timer wake. No signed-in session is
  // created or reused; the backend resolves the saved schedule authorization.
  queueMicrotask(() => { void tick().catch(() => {}); });

  const close = () => closing ??= (async () => {
    stopping = true; clearInterval(pollTimer);
    try {
      // Keep renewing active leases while shutdown waits for gateway calls.
      await runner.drain();
      await pendingTick;
    } finally {
      clearInterval(heartbeatTimer);
      await pendingHeartbeat;
    }
  })();
  return {
    tick, close,
    status: () => ({ enabled, pollSeconds, stopping, checking: Boolean(pendingTick), lastCheckAt, lastError }),
  };
}
