import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateMeterReadings, evaluateMeterDetails, getMeterName, isVirtualMeter } from '../public/virtual-meters.js';
import { exampleModel, validateModel } from '../public/model.js';

const physical = (id, value = 10, extra = {}) => ({ id, name: id, measured: true, value, uncertainty: 2, uncertaintyType: 'absolute', ...extra });
const virtual = (id, formula, extra = {}) => physical(id, 999, { meterType: 'virtual', formula, ...extra });
const readings = streams => evaluateMeterReadings({ streams });
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test('formulas support precedence, parentheses, unary operations and right-associative exponentiation without evaluating code', () => {
  const meters = [physical('Feed', 20), virtual('Arithmetic', '( [ Feed ] + 2) * 3 / 2 - 1'), virtual('Powers', '-2^2 + 2^3^2'), virtual('Scientific', '1e2 + .5 * +2')];
  const result = readings(meters);
  near(result.get('Arithmetic').value, 32);
  near(result.get('Powers').value, 508);
  near(result.get('Scientific').value, 101);
  assert.equal(result.get('Powers').error, null);
  assert.match(readings([virtual('Code', 'globalThis.alert(1)')]).get('Code').error, /Unexpected character/);
});

test('named readings use exact trimmed names, default to stream name, and calculate chains fresh without changing cached values', () => {
  const input = [physical('Feed', 12, { meterName: ' Feed meter ' }), virtual('First', '[Feed meter] * 2'), virtual('Second', '[First] + [Feed meter]')];
  const result = readings(input);
  near(result.get('Second').value, 36);
  assert.equal(input[1].value, 999);
  assert.equal(getMeterName(input[0]), 'Feed meter');
  assert.equal(getMeterName(input[1]), 'First');
  assert.equal(isVirtualMeter(input[0]), false);
  assert.equal(isVirtualMeter(input[1]), true);
  assert.equal(readings([physical('Feed'), virtual('Case', '[feed]')]).get('Case').value, null);
  input[0].value = 20;
  near(readings(input).get('Second').value, 60);
});

test('formulas reject missing, unmeasured, ambiguous, self and circular references with per-meter errors', () => {
  const cases = [
    [[virtual('Virtual', '[Unknown]')], /was not found/],
    [[physical('Feed', 2, { measured: false }), virtual('Virtual', '[Feed]')], /was not found/],
    [[physical('One', 2, { meterName: 'Same' }), physical('Two', 3, { meterName: 'Same' }), virtual('Virtual', '[Same]')], /ambiguous/],
    [[virtual('Virtual', '[Virtual]')], /itself/],
    [[virtual('Virtual', '[Other]'), virtual('Other', '[Virtual]')], /Circular/]
  ];
  for (const [streams, pattern] of cases) {
    streams.push(physical('Unaffected', 7));
    const result = readings(streams);
    assert.equal(result.get('Virtual').value, null);
    assert.match(result.get('Virtual').error, pattern);
    near(result.get('Unaffected').value, 7);
  }
});

test('invalid arithmetic, incomplete formulas and resource limits return clear errors', () => {
  const formulas = ['1 / 0', '1 - 2', '1e308 * 2', '(-2)^.5', '0^0', '[Missing', '1 +', '2(3)', '', '1'.repeat(1001), '('.repeat(70) + '1' + ')'.repeat(70), Array(300).fill('1').join('+')];
  for (const formula of formulas) {
    const result = readings([virtual('Virtual', formula)]).get('Virtual');
    assert.equal(result.value, null, formula);
    assert.ok(result.error, formula);
  }
});

test('nonlinear derivatives, repeated sources and nested calculation errors propagate first-order marginal uncertainty', () => {
  const result = evaluateMeterDetails({ streams: [physical('Feed', 10), virtual('Square', '[Feed]^2', { uncertainty: 3 }), virtual('Double', '[Square] + [Square]', { uncertainty: 4 })] });
  near(result.get('Square').value, 100);
  near(result.get('Square').derivatives.get('Feed'), 20);
  near(result.get('Square').sigma, Math.sqrt(1609));
  near(result.get('Double').sigma, Math.sqrt(4 * 1609 + 16));
  near(result.get('Double').sensitivities.get('Feed'), 40);
  near(result.get('Double').sensitivities.get('Square'), 2);
});

test('invalid uncertainty preserves reading previews but withholds propagated sigma', () => {
  for (const extra of [{ uncertaintyType: 'unknown' }, { uncertainty: -1 }, { uncertainty: 0 }, { uncertaintyType: 'percent', value: 0 }]) {
    const result = evaluateMeterDetails({ streams: [physical('Feed', 10, extra), virtual('Virtual', '[Feed] + 1')] });
    assert.equal(result.get('Feed').sigma, null);
    assert.equal(result.get('Virtual').sigma, null);
    assert.equal(result.get('Virtual').error, null);
  }
});

test('finite extreme standard deviations are preserved without squaring overflow or underflow', () => {
  for (const sigma of [1e200, 1e-200]) {
    const result = evaluateMeterDetails({ streams: [physical('Feed', 10, { uncertainty: sigma }), virtual('Copy', '[Feed]', { uncertainty: sigma })] });
    assert.equal(result.get('Feed').sigma, sigma);
    assert.ok(Math.abs(result.get('Copy').sigma / sigma - Math.SQRT2) < 1e-12);
  }
});

test('division preserves finite sensitivity for extreme denominators and permits zero divided by a tiny reading', () => {
  const large = evaluateMeterDetails({ streams: [physical('Denominator', 1e200), virtual('Ratio', '1e308 / [Denominator]')] });
  assert.ok(Math.abs(large.get('Ratio').derivatives.get('Denominator') / -1e-92 - 1) < 1e-12);
  assert.equal(large.get('Ratio').error, null);
  const tiny = evaluateMeterDetails({ streams: [physical('Denominator', 1e-200), virtual('Zero', '0 / [Denominator]')] });
  assert.equal(tiny.get('Zero').value, 0);
  assert.equal(tiny.get('Zero').error, null);
});

test('draft validation permits incomplete formulas and ignores stale cached virtual readings while rejecting malformed metadata', () => {
  const model = exampleModel();
  Object.assign(model.streams[0], { meterType: 'virtual', meterName: 'Virtual feed', formula: '[Missing] +', value: -100 });
  assert.doesNotThrow(() => validateModel(model));
  for (const properties of [{ meterType: 'script' }, { formula: 42 }, { formula: '1'.repeat(1001) }, { meterName: 'Has [brackets]' }, { meterName: 'a'.repeat(101) }]) {
    const copy = structuredClone(model); Object.assign(copy.streams[0], properties);
    assert.throws(() => validateModel(copy), /invalid type, name, or formula/);
  }
});
