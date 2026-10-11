import test from 'node:test';
import assert from 'node:assert/strict';
import { callSqlGateway } from '../backend/sql-connectors.js';
import { aggregateReadings, UNSUPPORTED_COUNTER_PRECISION_MARKER } from '../connectors/sql-gateway/src/contract.js';

for (const opening of [9007199254740992, UNSUPPORTED_COUNTER_PRECISION_MARKER]) test(`SQL ${typeof opening === 'number' ? 'numeric' : 'unsupported-type'} counter precision rejection reaches the application as an actionable sanitized data error`, async () => {
  const start = '2026-10-10T09:00:00.000Z', end = '2026-10-10T10:00:00.000Z';
  const body = { tags: ['COUNTER'], start, end, aggregation: 'totalizerDelta', quality: {} };
  let precisionError;
  try {
    aggregateReadings([{ source_name: 'COUNTER', value: opening, timestamp: start }, { source_name: 'COUNTER', value: 9007199254740993, timestamp: end }], body);
  } catch (error) { precisionError = error; }
  assert.equal(precisionError?.code, 'UNSUPPORTED_COUNTER_PRECISION');
  const env = {
    SQL_GATEWAY_URL: 'https://gateway.example', SQL_GATEWAY_TOKEN: 'a'.repeat(40),
    SQL_GATEWAY_FETCH: async () => new Response(JSON.stringify({ error: { code: precisionError.code, message: 'COUNTER: password=secret host=plant-private' } }), { status: precisionError.status }),
  };
  await assert.rejects(callSqlGateway(env, 'read', body), error => error.status === 422 && /^COUNTER: /.test(error.message) && /precision/i.test(error.message) && !/secret|plant-private/.test(error.message));
});
