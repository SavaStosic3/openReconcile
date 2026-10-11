import { parentPort, workerData } from 'node:worker_threads';
import { reconcile } from '../public/solver.js';

// Only the numeric solver runs here. Credentials, connector access, database
// claims, authorization checks and output delivery stay in the server.
try {
  parentPort.postMessage({ type: 'result', result: reconcile(workerData) });
} catch {
  parentPort.postMessage({ type: 'error', message: 'The calculation worker could not reconcile this model.' });
} finally {
  parentPort.close();
}
