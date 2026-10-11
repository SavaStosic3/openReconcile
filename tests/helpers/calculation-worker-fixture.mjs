import { parentPort, workerData } from 'node:worker_threads';
import { reconcile } from '../../public/solver.js';

if (workerData.fixture === 'crash') throw new Error('Fixture worker failure');
if (workerData.fixture === 'exit') process.exit(0);
const deadline = Date.now() + (workerData.delayMs ?? (workerData.name === 'Worker delay fixture' ? 1000 : 0));
while (Date.now() < deadline) { /* Deliberate synchronous CPU work, isolated from the HTTP thread. */ }
parentPort.postMessage({ type: 'result', result: workerData.fixture ? { status: 'ok', value: workerData.value } : reconcile(workerData) });
parentPort.close();
