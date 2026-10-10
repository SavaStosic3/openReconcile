import { validateInputQuality } from './input-quality.js';

export const PI_INPUT_AGGREGATIONS = ['latest', 'sum', 'average', 'timeWeightedAverage', 'totalizerDelta'];
export const PI_QUALITY_FLAGS = ['Good', 'Questionable', 'Substituted', 'Bad'];
export const PI_QUALITY_COLUMN = 'piQuality';
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);

// The browser stores aliases and policies. PI endpoints, paths and credentials
// belong exclusively to the server-owned connection profiles.
export function validatePiSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || ![Object.prototype, null].includes(Object.getPrototypeOf(source))) throw new Error('Choose a PI Web API source configuration.');
  const base = ['id', 'name', 'type', 'direction', 'connectionId'];
  const keys = source.direction === 'input' ? [...base, 'aggregation', ...(Object.hasOwn(source, 'quality') ? ['quality'] : [])] : base;
  if (Object.keys(source).length !== keys.length || Object.keys(source).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(source, key))) throw new Error('The PI source contains missing or unsupported fields.');
  if (!safeId(source.id) || !safeId(source.connectionId)) throw new Error('Choose a safe source and connection identifier of at most 128 characters.');
  if (source.type !== 'pi' || !['input', 'output'].includes(source.direction)) throw new Error('Choose an input or output PI source.');
  if (typeof source.name !== 'string' || source.name !== source.name.trim() || !source.name || source.name.length > 160 || /[\u0000-\u001f\u007f]/.test(source.name)) throw new Error('Enter a source name of at most 160 characters.');
  const result = Object.fromEntries(keys.map(key => [key, source[key]]));
  if (source.direction === 'input') {
    if (!PI_INPUT_AGGREGATIONS.includes(source.aggregation)) throw new Error('Choose a supported PI input aggregation.');
    if (Object.hasOwn(source, 'quality') && (!source.quality || typeof source.quality !== 'object' || Array.isArray(source.quality) || ![Object.prototype, null].includes(Object.getPrototypeOf(source.quality)))) throw new Error('Choose valid PI input data-quality settings.');
    if (source.quality && Object.hasOwn(source.quality, 'qualityColumn') && source.quality.qualityColumn !== PI_QUALITY_COLUMN) throw new Error('PI historian quality flags cannot be disabled or replaced with a column.');
    result.quality = validateInputQuality({ ...source.quality, qualityColumn: PI_QUALITY_COLUMN });
    if (result.quality.goodQualityValues.length !== 1 || result.quality.goodQualityValues[0] !== 'Good') throw new Error('PI input accepts only Good readings without Questionable or Substituted flags. Choose whether to reject or exclude other readings.');
  }
  return result;
}
