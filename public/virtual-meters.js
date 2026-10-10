// Formulas operate on raw readings in each meter's selected unit. No JavaScript
// evaluation or automatic unit conversion is performed here.
export const getMeterName = stream => (typeof stream.meterName === 'string' && stream.meterName.trim()) || (typeof stream.name === 'string' && stream.name.trim()) || 'Unnamed meter';
export const isVirtualMeter = stream => stream.measured && stream.meterType === 'virtual';

const MAX_FORMULA = 1000, MAX_TOKENS = 512, MAX_DEPTH = 64;

function parseFormula(formula) {
  if (typeof formula !== 'string' || !formula.trim()) throw new Error('Enter a virtual meter formula.');
  if (formula.length > MAX_FORMULA) throw new Error('Formulas must be at most 1,000 characters.');
  const tokens = []; let position = 0;
  while (position < formula.length) {
    if (/\s/.test(formula[position])) { position++; continue; }
    const start = position, character = formula[position];
    if (character === '[') {
      const end = formula.indexOf(']', position + 1);
      if (end < 0) throw new Error('Close each meter reference with ].');
      const name = formula.slice(position + 1, end).trim();
      if (!name || name.includes('[')) throw new Error('Use a meter name inside [brackets].');
      tokens.push({ type: 'reference', name }); position = end + 1;
    } else if ('+-*/^()'.includes(character)) {
      tokens.push({ type: character }); position++;
    } else {
      const match = formula.slice(position).match(/^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!match) throw new Error(`Unexpected character at position ${start + 1}. Use numbers, [meter names], and + - * / ^ ( ).`);
      const value = Number(match[0]);
      if (!Number.isFinite(value)) throw new Error('Formula numbers must be finite.');
      tokens.push({ type: 'number', value }); position += match[0].length;
    }
    if (tokens.length > MAX_TOKENS) throw new Error('The formula has too many operations.');
  }
  tokens.push({ type: 'end' }); let cursor = 0;
  function expression(minimum = 0, depth = 0) {
    if (depth > MAX_DEPTH) throw new Error('The formula is nested too deeply.');
    const token = tokens[cursor++]; let left;
    if (token.type === 'number' || token.type === 'reference') left = token;
    else if (token.type === '+' || token.type === '-') left = { type: 'unary', operator: token.type, operand: expression(3, depth + 1) };
    else if (token.type === '(') {
      left = expression(0, depth + 1);
      if (tokens[cursor++].type !== ')') throw new Error('Close each opening parenthesis.');
    } else throw new Error('Expected a number, [meter name], or opening parenthesis.');
    const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 4 };
    while ((precedence[tokens[cursor].type] ?? 0) > minimum) {
      const operator = tokens[cursor++].type, power = precedence[operator];
      left = { type: 'binary', operator, left, right: expression(operator === '^' ? power - 1 : power, depth + 1) };
    }
    return left;
  }
  const tree = expression();
  if (tokens[cursor].type !== 'end') throw new Error('Separate terms with a math operator and check the parentheses.');
  return tree;
}

function combine(a, b, leftFactor, rightFactor, value) {
  if (!Number.isFinite(value) || !Number.isFinite(leftFactor) || !Number.isFinite(rightFactor)) throw new Error('The formula produces a nonfinite value or derivative.');
  const derivatives = new Map();
  for (const [id, derivative] of a.derivatives) derivatives.set(id, derivative * leftFactor);
  for (const [id, derivative] of b.derivatives) derivatives.set(id, (derivatives.get(id) || 0) + derivative * rightFactor);
  for (const [id, derivative] of derivatives) {
    if (!Number.isFinite(derivative)) throw new Error('The formula sensitivity is too large.');
    if (derivative === 0) derivatives.delete(id);
  }
  return { value, derivatives };
}

function evaluateTree(tree, reference) {
  if (tree.type === 'number') return { value: tree.value, derivatives: new Map() };
  if (tree.type === 'reference') {
    const meter = reference(tree.name);
    return { value: meter.value, derivatives: new Map([[meter.id, 1]]) };
  }
  if (tree.type === 'unary') {
    const a = evaluateTree(tree.operand, reference);
    return combine(a, { derivatives: new Map() }, tree.operator === '-' ? -1 : 1, 0, tree.operator === '-' ? -a.value : a.value);
  }
  const a = evaluateTree(tree.left, reference), b = evaluateTree(tree.right, reference);
  if (tree.operator === '+') return combine(a, b, 1, 1, a.value + b.value);
  if (tree.operator === '-') return combine(a, b, 1, -1, a.value - b.value);
  if (tree.operator === '*') return combine(a, b, b.value, a.value, a.value * b.value);
  if (tree.operator === '/') {
    if (b.value === 0) throw new Error('Division by zero in the formula.');
    const value = a.value / b.value;
    // Dividing sequentially avoids overflow/underflow from squaring a finite
    // denominator (which could silently erase a real source sensitivity).
    return combine(a, b, a.derivatives.size ? 1 / b.value : 0, b.derivatives.size ? -value / b.value : 0, value);
  }
  if (a.value === 0 && b.value === 0) throw new Error('Zero to the power of zero is undefined.');
  const value = a.value ** b.value;
  const baseDerivative = a.derivatives.size ? (b.value === 0 ? 0 : b.value * a.value ** (b.value - 1)) : 0;
  if (b.derivatives.size && a.value <= 0) throw new Error('A meter-dependent exponent requires a positive base.');
  const exponentDerivative = b.derivatives.size ? value * Math.log(a.value) : 0;
  return combine(a, b, baseDerivative, exponentDerivative, value);
}

// Solver-facing details include direct formula derivatives and sensitivities to
// independent physical-meter/calculation errors. A virtual meter introduces its
// own independent error in addition to propagated errors from its references.
export function evaluateMeterDetails(model) {
  const measured = (model?.streams || []).filter(stream => stream.measured);
  const names = new Map(), results = new Map(), active = new Set();
  for (const stream of measured) {
    const name = getMeterName(stream);
    if (!names.has(name)) names.set(name, []);
    names.get(name).push(stream);
  }
  function evaluate(stream) {
    if (results.has(stream.id)) return results.get(stream.id);
    if (active.has(stream.id)) return { value: null, error: `Circular meter reference involving [${getMeterName(stream)}].` };
    if (active.size >= MAX_DEPTH) return { value: null, error: 'Virtual meter references are nested too deeply.' };
    active.add(stream.id);
    let result;
    try {
      let value, derivatives = new Map();
      if (isVirtualMeter(stream)) {
        const calculated = evaluateTree(parseFormula(stream.formula), name => {
          const matches = names.get(name);
          if (!matches?.length) throw new Error(`Meter [${name}] was not found. References must match a measured meter name exactly.`);
          if (matches.length !== 1) throw new Error(`Meter [${name}] is ambiguous. Give each referenced meter a unique name.`);
          if (matches[0].id === stream.id) throw new Error(`A virtual meter cannot reference itself: [${name}].`);
          const reading = evaluate(matches[0]);
          if (reading.error) throw new Error(`[${name}]: ${reading.error}`);
          return { id: matches[0].id, value: reading.value };
        });
        value = calculated.value; derivatives = calculated.derivatives;
      } else {
        if (stream.value === '' || stream.value === null || stream.value === undefined || !Number.isFinite(Number(stream.value))) throw new Error('Enter a nonnegative physical meter reading.');
        value = Number(stream.value);
      }
      if (!Number.isFinite(value)) throw new Error('The formula produces a nonfinite reading.');
      if (value < 0) throw new Error('Meter readings must be nonnegative. Check the formula or input readings.');
      const sensitivities = new Map([[stream.id, 1]]);
      for (const [id, derivative] of derivatives) {
        for (const [errorId, sensitivity] of results.get(id).sensitivities) {
          const next = (sensitivities.get(errorId) || 0) + derivative * sensitivity;
          if (!Number.isFinite(next)) throw new Error('The formula sensitivity is too large.');
          sensitivities.set(errorId, next);
        }
      }
      const configured = Number(stream.uncertainty);
      const calculatedSigma = stream.uncertaintyType === 'percent' ? Math.abs(value) * configured / 100 : configured;
      const independentSigma = ['absolute', 'percent'].includes(stream.uncertaintyType) && Number.isFinite(calculatedSigma) && calculatedSigma > 0 ? calculatedSigma : null;
      const errorSigmas = independentSigma === null ? [] : [independentSigma];
      let validUncertainty = independentSigma !== null;
      for (const [errorId, sensitivity] of sensitivities) {
        if (errorId !== stream.id && sensitivity !== 0) {
          const referenceSigma = results.get(errorId).independentSigma;
          if (referenceSigma === null || !Number.isFinite(referenceSigma) || referenceSigma <= 0) validUncertainty = false;
          else errorSigmas.push(sensitivity * referenceSigma);
        }
      }
      // hypot rescales internally, preserving finite very large/small standard
      // deviations even when their squares would overflow or underflow.
      const sigma = Math.hypot(...errorSigmas);
      result = { value, error: null, derivatives, sensitivities,
        independentSigma, sigma: validUncertainty && Number.isFinite(sigma) && sigma > 0 ? sigma : null };
    } catch (error) {
      result = { value: null, error: error instanceof Error ? error.message : 'The meter formula could not be evaluated.' };
    }
    active.delete(stream.id); results.set(stream.id, result); return result;
  }
  for (const stream of measured) evaluate(stream);
  return results;
}

// UI API: errors are scoped to each measured stream, so an incomplete draft can
// show useful previews for other meters without throwing or mutating the model.
export function evaluateMeterReadings(model) {
  return new Map([...evaluateMeterDetails(model)].map(([id, reading]) => [id, { value: reading.value, error: reading.error }]));
}
