// Data-quality policy is shared by source configuration and the SQL gateway.
export const INPUT_QUALITY_DEFAULTS = Object.freeze({
  maxAgeMinutes: 60,
  minCoveragePercent: 100,
  qualityColumn: null,
  goodQualityValues: Object.freeze(['Good']),
  badQualityPolicy: 'reject',
  interpolation: 'step',
  gapPolicy: 'reject',
  totalizerReset: 'reject',
  rolloverValue: null,
});
const qualityKeys = Object.keys(INPUT_QUALITY_DEFAULTS);
export function validateInputQuality(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !qualityKeys.includes(key))) throw new Error('Choose valid input data-quality settings.');
  const result = { ...INPUT_QUALITY_DEFAULTS, ...value };
  if (typeof result.maxAgeMinutes !== 'number' || !Number.isFinite(result.maxAgeMinutes) || result.maxAgeMinutes <= 0 || result.maxAgeMinutes > 366 * 24 * 60) throw new Error('Maximum reading age must be greater than zero and no more than 366 days.');
  if (typeof result.minCoveragePercent !== 'number' || !Number.isFinite(result.minCoveragePercent) || result.minCoveragePercent < 0 || result.minCoveragePercent > 100) throw new Error('Minimum data coverage must be between 0 and 100 percent.');
  if (result.qualityColumn !== null && (typeof result.qualityColumn !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(result.qualityColumn))) throw new Error('Use a simple SQL quality-column identifier of at most 64 characters.');
  if (!Array.isArray(result.goodQualityValues) || result.goodQualityValues.length < 1 || result.goodQualityValues.length > 32
    || result.goodQualityValues.some(flag => typeof flag !== 'string' || !flag || flag !== flag.trim() || flag.length > 80 || /[\u0000-\u001f\u007f]/.test(flag))
    || new Set(result.goodQualityValues).size !== result.goodQualityValues.length) throw new Error('Choose 1–32 distinct good-quality flags, each at most 80 characters.');
  result.goodQualityValues = [...result.goodQualityValues];
  for (const [key, allowed] of Object.entries({ badQualityPolicy: ['reject', 'exclude'], interpolation: ['step', 'linear'], gapPolicy: ['reject', 'scale'], totalizerReset: ['reject', 'restart', 'rollover'] })) {
    if (!allowed.includes(result[key])) throw new Error(`Choose a valid ${key} setting.`);
  }
  if (result.rolloverValue !== null && (typeof result.rolloverValue !== 'number' || !Number.isFinite(result.rolloverValue) || result.rolloverValue <= 0)) throw new Error('Totalizer rollover value must be a positive finite number.');
  if (result.totalizerReset === 'rollover' && result.rolloverValue === null) throw new Error('Set the totalizer rollover value before allowing rollover.');
  return result;
}

export class InputQualityError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function problem(code, sourceName, message) { throw new InputQualityError(code, `${sourceName}: ${message}`); }
function numeric(value) {
  if (typeof value === 'string' && /^[+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) value = Number(value);
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
const advanced = aggregation => ['timeWeightedAverage', 'totalizerDelta'].includes(aggregation);

// Samples use canonical ISO timestamps. Bad points stay in the time series as
// barriers: excluding a flag never joins the good samples on either side.
export function aggregateQualityReadings(samples, { sourceName, start, end, aggregation, quality: configured }) {
  const quality = validateInputQuality(configured);
  const startMs = Date.parse(start), endMs = Date.parse(end), duration = endMs - startMs, maxAge = quality.maxAgeMinutes * 60_000;
  if (!Number.isFinite(duration) || duration <= 0) problem('INVALID_SOURCE_DATA', sourceName, 'select a nonempty reporting period.');
  if (!Array.isArray(samples) || samples.length === 0) problem('MISSING_SOURCE_DATA', sourceName, 'no source readings were found for this period.');
  let rejectedCount = 0;
  const points = samples.map(sample => {
    const time = Date.parse(sample.timestamp);
    if (!Number.isFinite(time) || time < (advanced(aggregation) ? startMs - maxAge : startMs) || time > endMs || (!advanced(aggregation) && time === endMs)) problem('INVALID_SOURCE_DATA', sourceName, 'a reading falls outside the permitted period or boundary lookback.');
    const flag = typeof sample.quality === 'number' && Number.isFinite(sample.quality) && Number.isInteger(sample.quality) ? String(sample.quality) : sample.quality;
    const good = quality.qualityColumn === null || (typeof flag === 'string' && quality.goodQualityValues.includes(flag));
    if (!good) {
      rejectedCount++;
      if (quality.badQualityPolicy === 'reject') problem('BAD_SOURCE_QUALITY', sourceName, 'a reading has an unaccepted historian quality flag.');
      return { time, good: false, value: null };
    }
    const value = numeric(sample.value);
    if (value === null) problem('INVALID_SOURCE_DATA', sourceName, 'a good-quality reading is missing, negative, or not numeric.');
    return { time, good: true, value };
  }).sort((a, b) => a.time - b.time);
  const unique = [];
  for (const point of points) {
    const previous = unique.at(-1);
    if (previous?.time === point.time) {
      if (previous.good !== point.good || previous.value !== point.value) problem('AMBIGUOUS_SOURCE_DATA', sourceName, 'different readings or quality flags share the same timestamp.');
      continue;
    }
    unique.push(point);
  }
  const valid = unique.filter(point => point.good);
  if (!valid.length) problem('MISSING_SOURCE_DATA', sourceName, 'no accepted readings remain after quality checks.');
  const latest = valid.at(-1);
  if (endMs - latest.time > maxAge) problem('STALE_SOURCE_DATA', sourceName, 'the latest accepted reading is older than the maximum age at the period end.');
  const warnings = rejectedCount ? [`Excluded ${rejectedCount} reading(s) with unaccepted quality flags; their gaps are not bridged.`] : [];
  let coverageMs = 0, normalizedArea = 0, counterValue = 0, resetCount = 0;
  if (aggregation === 'totalizerDelta') {
    if (!unique.some(point => point.good && point.time <= startMs) || latest.time !== endMs) problem('INCOMPLETE_TOTALIZER', sourceName, 'totalizer data needs a valid start baseline and a reading exactly at the period end.');
    for (let i = 0; i < unique.length - 1; i++) {
      const a = unique[i], b = unique[i + 1];
      const left = Math.max(startMs, a.time), right = Math.min(endMs, b.time);
      if (right <= left) continue;
      if (!a.good || !b.good || b.time - a.time > maxAge) continue;
      if (quality.totalizerReset === 'rollover' && (a.value >= quality.rolloverValue || b.value >= quality.rolloverValue)) problem('INVALID_SOURCE_DATA', sourceName, 'counter values must be below the configured rollover value.');
      let delta = b.value - a.value;
      if (delta < 0) {
        resetCount++;
        if (quality.totalizerReset === 'reject') problem('TOTALIZER_RESET', sourceName, 'the totalizer decreased; select an explicit reset or rollover policy to use this period.');
        if (left !== a.time || right !== b.time) problem('INCOMPLETE_TOTALIZER', sourceName, 'a reset spans a period boundary, so the period amount cannot be determined.');
        delta = quality.totalizerReset === 'restart' ? b.value : quality.rolloverValue - a.value + b.value;
      }
      counterValue += delta * ((right - left) / (b.time - a.time));
      coverageMs += right - left;
      if (left !== a.time || right !== b.time) warnings.push('The totalizer start boundary was linearly interpolated between accepted readings.');
    }
    if (coverageMs < duration - 0.001) problem('INCOMPLETE_TOTALIZER', sourceName, 'the totalizer has an unknown gap; incomplete counter deltas cannot be scaled.');
    if (resetCount) warnings.push(quality.totalizerReset === 'restart'
      ? `Assumed ${resetCount} reset(s) to zero; material accumulated between the previous sample and each reset is unknown and excluded.`
      : `Assumed one rollover per observed decrease (${resetCount}); additional rollovers between samples cannot be detected.`);
  } else if (aggregation === 'timeWeightedAverage' && quality.interpolation === 'linear') {
    for (let i = 0; i < unique.length - 1; i++) {
      const a = unique[i], b = unique[i + 1];
      if (!a.good || !b.good || b.time - a.time > maxAge) continue;
      const left = Math.max(startMs, a.time), right = Math.min(endMs, b.time);
      if (right <= left) continue;
      const span = b.time - a.time;
      const leftFraction = (left - a.time) / span, rightFraction = (right - a.time) / span;
      const leftValue = a.value * (1 - leftFraction) + b.value * leftFraction;
      const rightValue = a.value * (1 - rightFraction) + b.value * rightFraction;
      normalizedArea += (leftValue / 2 + rightValue / 2) * ((right - left) / duration);
      coverageMs += right - left;
    }
  } else {
    // Last-value hold has a finite lifetime. A bad sample stops its lifetime
    // immediately, including when that bad sample was explicitly excluded.
    for (let i = 0; i < unique.length; i++) {
      const point = unique[i];
      if (!point.good) continue;
      const left = Math.max(startMs, point.time);
      const right = Math.min(endMs, unique[i + 1]?.time ?? endMs, point.time + maxAge);
      if (right <= left) continue;
      coverageMs += right - left;
      if (aggregation === 'timeWeightedAverage') normalizedArea += point.value * ((right - left) / duration);
    }
  }
  const coveragePercent = Math.min(100, Math.max(0, coverageMs / duration * 100));
  if (coveragePercent + 1e-9 < quality.minCoveragePercent) problem('INSUFFICIENT_COVERAGE', sourceName, `data coverage is ${coveragePercent.toFixed(2)}%; at least ${quality.minCoveragePercent}% is required.`);
  let value;
  if (aggregation === 'timeWeightedAverage') {
    if (coverageMs <= 0) problem('INSUFFICIENT_COVERAGE', sourceName, 'no interval has accepted flow coverage.');
    if (coverageMs < duration - 0.001) {
      if (quality.gapPolicy === 'reject') problem('SOURCE_DATA_GAP', sourceName, 'the flow has an uncovered interval; enable explicit scaling or provide complete data.');
      value = normalizedArea / (coverageMs / duration);
      warnings.push(`Scaled the accepted time-weighted mean over the full period; ${(100 - coveragePercent).toFixed(2)}% of its duration is extrapolated.`);
    } else value = normalizedArea;
  } else if (aggregation === 'totalizerDelta') value = counterValue;
  else if (aggregation === 'latest') value = latest.value;
  else value = valid.reduce((sum, point) => sum + (aggregation === 'average' ? point.value / valid.length : point.value), 0);
  if (!Number.isFinite(value) || value < 0) problem('INVALID_SOURCE_DATA', sourceName, 'the aggregated reading is not a finite nonnegative number.');
  const latestTimestamp = new Date(latest.time).toISOString();
  return { sourceName, value, timestamp: latestTimestamp, quality: {
    coveragePercent, sampleCount: valid.length, rejectedCount, latestTimestamp, resetCount, warnings: [...new Set(warnings)],
  } };
}
