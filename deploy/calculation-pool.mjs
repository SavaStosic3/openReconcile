import { Worker } from 'node:worker_threads';

export const DEFAULT_CALCULATION_LIMITS = Object.freeze({ workers: 1, maxQueue: 8, timeoutMs: 120_000, queueTimeoutMs: 30_000 });
const failure = (message, code) => Object.assign(new Error(message), { code });

export function createCalculationPool({
  workers = DEFAULT_CALCULATION_LIMITS.workers, maxQueue = DEFAULT_CALCULATION_LIMITS.maxQueue,
  timeoutMs = DEFAULT_CALCULATION_LIMITS.timeoutMs, queueTimeoutMs = DEFAULT_CALCULATION_LIMITS.queueTimeoutMs,
  workerURL = new URL('./calculation-worker.mjs', import.meta.url),
} = {}) {
  for (const [name, value, maximum] of [['workers', workers, 4], ['maxQueue', maxQueue, 32], ['timeoutMs', timeoutMs, 300_000], ['queueTimeoutMs', queueTimeoutMs, 300_000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`Choose a valid calculation ${name} limit (1–${maximum}).`);
  }
  const active = new Set(), queue = [];
  let closed = false, closing;

  function settle(job, error, result) {
    if (job.settled) return;
    job.settled = true;
    clearTimeout(job.timer);
    job.signal?.removeEventListener('abort', job.abort);
    if (error) job.reject(error); else job.resolve(result);
  }

  function stop(job, error) {
    settle(job, error);
    if (job.worker) {
      // Hold the slot until termination completes. Replacement work cannot
      // temporarily exceed the thread bound while an old worker shuts down.
      job.termination ??= job.worker.terminate();
      void job.termination.catch(() => {});
    } else {
      const index = queue.indexOf(job);
      if (index !== -1) queue.splice(index, 1);
    }
  }

  function launch(job) {
    clearTimeout(job.timer);
    active.add(job);
    try {
      // Fresh workers release solver allocations after every run and cannot
      // carry state from an earlier model. No user code is evaluated.
      job.worker = new Worker(workerURL, { workerData: job.model, resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 8 } });
    } catch {
      active.delete(job);
      settle(job, failure('The calculation worker could not start.', 'CALCULATION_WORKER_FAILED'));
      pump();
      return;
    }
    job.model = null;
    job.timer = setTimeout(() => stop(job, failure('The calculation exceeded its execution time limit. Reduce the model or increase CALCULATION_TIMEOUT_SECONDS.', 'CALCULATION_TIMEOUT')), timeoutMs);
    job.worker.once('message', message => {
      if (message?.type === 'result' && message.result && typeof message.result === 'object') settle(job, null, message.result);
      else settle(job, failure('The calculation worker could not reconcile this model.', 'CALCULATION_WORKER_FAILED'));
      // A result is terminal even if the worker fails to exit itself.
      job.termination ??= job.worker.terminate();
      void job.termination.catch(() => {});
    });
    job.worker.once('error', () => stop(job, failure('The calculation worker failed or exceeded its memory limit.', 'CALCULATION_WORKER_FAILED')));
    job.worker.once('exit', () => {
      settle(job, failure('The calculation worker stopped before returning a result.', 'CALCULATION_WORKER_FAILED'));
      active.delete(job);
      pump();
    });
  }

  function pump() {
    while (!closed && active.size < workers && queue.length) {
      const job = queue.shift();
      if (!job.settled) launch(job);
    }
  }

  return {
    calculate(model, { signal } = {}) {
      if (closed) return Promise.reject(failure('Calculation cancelled: the server is shutting down.', 'CALCULATION_CANCELLED'));
      if (signal?.aborted) return Promise.reject(failure('Calculation cancelled.', 'CALCULATION_CANCELLED'));
      if (active.size >= workers && queue.length >= maxQueue) return Promise.reject(failure('The calculation queue is full. Try again after another run finishes.', 'CALCULATION_BUSY'));
      return new Promise((resolve, reject) => {
        const job = { model, signal, resolve, reject, settled: false, worker: null, timer: null, termination: null, abort: null };
        job.abort = () => stop(job, failure('Calculation cancelled.', 'CALCULATION_CANCELLED'));
        signal?.addEventListener('abort', job.abort, { once: true });
        if (active.size < workers) launch(job);
        else {
          queue.push(job);
          job.timer = setTimeout(() => stop(job, failure('The calculation waited too long for a worker. Try again after another run finishes.', 'CALCULATION_QUEUE_TIMEOUT')), queueTimeoutMs);
        }
      });
    },
    status: () => ({ active: active.size, queued: queue.length, closed, workers, maxQueue, timeoutMs, queueTimeoutMs }),
    close() {
      return closing ??= (async () => {
        closed = true;
        const error = failure('Calculation cancelled: the server is shutting down.', 'CALCULATION_CANCELLED');
        for (const job of [...queue, ...active]) stop(job, error);
        await Promise.allSettled([...active].map(job => job.termination));
      })();
    },
  };
}
