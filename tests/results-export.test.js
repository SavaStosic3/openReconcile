import test from 'node:test';
import assert from 'node:assert/strict';
import { resultsCsv } from '../public/results-export.js';
import { exampleModel } from '../public/model.js';
import { reconcile } from '../public/solver.js';

function parseCsv(csv) {
  // An independent CSV reader for quoted fields, escaped quotes and newlines.
  const rows = []; let row = [], field = '', quoted = false;
  for (let index = 0; index < csv.length; index++) {
    const character = csv[index];
    if (character === '"') {
      if (quoted && csv[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (!quoted && character === ',') { row.push(field); field = ''; }
    else if (!quoted && character === '\r' && csv[index + 1] === '\n') {
      row.push(field); rows.push(row); row = []; field = ''; index++;
    } else field += character;
  }
  row.push(field); rows.push(row);
  return rows.slice(1).map(fields => Object.fromEntries(rows[0].map((header, index) => [header, fields[index]])));
}

test('CSV carries reconciliation verdict and complete warnings while preserving numeric precision and item status', () => {
  const model = exampleModel(); model.streams[0].value = 1000;
  const result = reconcile(model);
  assert.equal(result.status, 'warning');
  result.warnings.push('Review "shift A", units\nand timing.');
  const rows = parseCsv(resultsCsv(model, result, { id: 'run-1', status: 'warning' }));
  assert.equal(rows.length, model.streams.length);
  for (const [index, row] of rows.entries()) {
    assert.equal(row['Reconciled kg'], String(result.streams[index].value));
    assert.equal(row['Standard uncertainty kg'], String(result.streams[index].uncertainty));
    assert.equal(row.Status, result.streams[index].status);
    assert.equal(row['Reconciliation status'], 'warning'); assert.equal(row['Result quality'], 'questionable');
    assert.equal(row['Quality policy'], 'conservative-v1'); assert.deepEqual(JSON.parse(row.Warnings), result.warnings);
  }
});

test('CSV distinguishes external delivery failure from balance quality and retains formula-injection protection', () => {
  const model = exampleModel(); model.streams[0].name = '=SUM(1,2)';
  const result = reconcile(model); assert.equal(result.status, 'ok');
  const rows = parseCsv(resultsCsv(model, result, { id: 'delivery-failed', status: 'failed' }));
  assert.equal(rows[0].Item, "'=SUM(1,2)"); assert.equal(rows[0]['Run status'], 'failed');
  assert.equal(rows[0]['Reconciliation status'], 'ok'); assert.equal(rows[0]['Result quality'], 'good');
  assert.deepEqual(JSON.parse(rows[0].Warnings), []);
});

test('CSV rejects invalid calculations and preserves source-data quality warnings', () => {
  const model = exampleModel(), result = reconcile(model);
  for (const status of ['invalid', 'infeasible', 'failed']) assert.throws(() => resultsCsv(model, { ...result, status }), /Only successful/);
  const rows = parseCsv(resultsCsv(model, result, { sql: { input: { readings: [{ sourceName: 'Feed', quality: { warnings: ['Scaled missing coverage.'] } }] } } }));
  assert.equal(rows[0]['Result quality'], 'questionable');
  assert.deepEqual(JSON.parse(rows[0].Warnings), ['Feed: Scaled missing coverage.']);
});

test('CSV preserves a run-level review verdict even when its numerical result is clean', () => {
  const model = exampleModel(), result = reconcile(model); assert.equal(result.status, 'ok');
  for (const status of ['warning', 'underdetermined']) {
    const rows = parseCsv(resultsCsv(model, result, { status }));
    assert.equal(rows[0]['Result quality'], 'questionable');
    assert.equal(rows[0]['Run status'], status); assert.equal(rows[0]['Reconciliation status'], 'ok');
  }
});

test('CSV rejects unfinished and unknown run states while allowing a standalone numerical result', () => {
  const model = exampleModel(), result = reconcile(model);
  for (const status of ['running', 'invalid', 'infeasible', 'unknown', null]) assert.throws(() => resultsCsv(model, result, { status }), /Only successful/);
  assert.equal(parseCsv(resultsCsv(model, result))[0]['Result quality'], 'good');
  assert.throws(() => resultsCsv(model, { ...result, status: 'invalid' }, { status: 'failed' }), /Only successful/);
});
