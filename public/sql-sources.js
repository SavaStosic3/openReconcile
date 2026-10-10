import { getModelItemName } from './data-mapping.js';
import { isVirtualMeter } from './virtual-meters.js';
import { validateInputQuality } from './input-quality.js';

export const SQL_AGGREGATIONS = ['latest', 'sum', 'average', 'timeWeightedAverage', 'totalizerDelta'];
export const SQL_OUTPUT_COLUMNS = ['run_id', 'model_id', 'model_name', 'published_version', 'item_id', 'item_type', 'source_name', 'metric', 'value_kg', 'raw_kg', 'correction_kg', 'uncertainty_kg', 'status', 'batch_start', 'batch_end', 'finished_at'];
const safeId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value) && !['constructor', 'prototype', '__proto__'].includes(value);
export function isSqlIdentifier(value, { table = false } = {}) {
  return typeof value === 'string' && value.length <= 129 && value.split('.').length <= (table ? 2 : 1) && value.split('.').every(part => /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(part));
}

// Credentials and arbitrary queries never belong to the browser model registry.
export function validateSqlSource(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source) || ![Object.prototype, null].includes(Object.getPrototypeOf(source))) throw new Error('Choose a SQL source configuration.');
  const base = ['id', 'name', 'type', 'direction', 'connectionId', 'table'];
  const keys = source.direction === 'input' ? [...base, 'tagColumn', 'valueColumn', 'timestampColumn', 'aggregation', ...(Object.hasOwn(source, 'quality') ? ['quality'] : [])] : base;
  if (Object.keys(source).length !== keys.length || Object.keys(source).some(key => !keys.includes(key)) || keys.some(key => !Object.hasOwn(source, key))) throw new Error('The SQL source contains missing or unsupported fields.');
  if (!safeId(source.id) || !safeId(source.connectionId)) throw new Error('Choose a safe source and connection identifier of at most 128 characters.');
  if (source.type !== 'sql' || !['input', 'output'].includes(source.direction)) throw new Error('Choose an input or output SQL source.');
  if (typeof source.name !== 'string' || source.name !== source.name.trim() || !source.name || source.name.length > 160 || /[\u0000-\u001f\u007f]/.test(source.name)) throw new Error('Enter a source name of at most 160 characters.');
  if (!isSqlIdentifier(source.table, { table: true })) throw new Error('Use a table name with up to two simple identifier segments.');
  if (source.direction === 'input') {
    for (const column of ['tagColumn', 'valueColumn', 'timestampColumn']) if (!isSqlIdentifier(source[column])) throw new Error('Use simple SQL column identifiers of at most 64 characters.');
    if (new Set([source.tagColumn, source.valueColumn, source.timestampColumn]).size !== 3) throw new Error('Tag, value, and timestamp columns must be different.');
    if (!SQL_AGGREGATIONS.includes(source.aggregation)) throw new Error('Choose a supported SQL input aggregation.');
    if (Object.hasOwn(source, 'quality')) {
      source = { ...source, quality: validateInputQuality(source.quality) };
      if ([source.tagColumn, source.valueColumn, source.timestampColumn].includes(source.quality.qualityColumn)) throw new Error('The quality column must be different from the tag, value, and timestamp columns.');
    }
  }
  return Object.fromEntries(keys.map(key => [key, source[key]]));
}

export function getSqlInputMappings(model) {
  if (!Array.isArray(model?.streams)) throw new Error('Choose a valid model for SQL input.');
  const meters = model.streams.filter(stream => stream.measured && !isVirtualMeter(stream));
  if (!meters.length) throw new Error('Add at least one physical meter before using SQL input.');
  const names = new Set();
  return meters.map(stream => {
    const sourceName = stream.dataMapping?.sourceName;
    const modelName = getModelItemName(stream, 'stream');
    if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName !== sourceName.trim() || sourceName.length > 200) throw new Error(`${modelName}: set a Source Name in Data Mapping before using SQL input.`);
    if (names.has(sourceName)) throw new Error('Physical meters need distinct Source Names for SQL input.');
    names.add(sourceName);
    return { itemId: stream.id, modelName, sourceName, unit: stream.unit };
  });
}
