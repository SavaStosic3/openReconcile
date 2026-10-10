import { getMeterName } from './virtual-meters.js';

// Mapping targets are the existing diagram item IDs. Display names stay derived
// from the item, so renaming a unit or meter cannot leave a stale target name.
export function getModelItemName(item, kind) {
  return kind === 'stream' && item.measured ? getMeterName(item) : item.name;
}

export function validateDataMapping(mapping, label = 'Item') {
  if (mapping === undefined) return;
  const plain = mapping !== null && typeof mapping === 'object' && !Array.isArray(mapping)
    && [Object.prototype, null].includes(Object.getPrototypeOf(mapping));
  if (!plain || Reflect.ownKeys(mapping).length !== 1 || !Object.hasOwn(mapping, 'sourceName')) {
    throw new Error(`${label}: data mapping must contain only Source Name.`);
  }
  const { sourceName } = mapping;
  if (typeof sourceName !== 'string' || !sourceName.trim() || sourceName !== sourceName.trim() || sourceName.length > 200) {
    throw new Error(`${label}: Source Name must be a nonempty, trimmed text value of at most 200 characters.`);
  }
}

export function getDataMapping(item) {
  validateDataMapping(item.dataMapping, getModelItemName(item, item.measured === undefined ? 'node' : 'stream'));
  return item.dataMapping === undefined ? null : { sourceName: item.dataMapping.sourceName };
}

// This helper changes metadata only. It never fetches a source or overwrites a
// reading, and returns a detached model for the normal permission-checked save.
export function setItemDataMapping(model, { kind, id, sourceName }) {
  const collection = kind === 'node' ? 'nodes' : kind === 'stream' ? 'streams' : null;
  if (!collection || !Array.isArray(model?.[collection])) throw new Error('Choose a process unit or flow connection to map.');
  if (typeof id !== 'string' || !model[collection].some(item => item.id === id)) throw new Error('That diagram item no longer exists.');
  if (typeof sourceName !== 'string') throw new Error('Source Name must be text.');
  const normalized = sourceName.trim();
  const mapping = normalized ? { sourceName: normalized } : undefined;
  const target = model[collection].find(item => item.id === id);
  validateDataMapping(mapping, getModelItemName(target, kind));
  const next = structuredClone(model), item = next[collection].find(item => item.id === id);
  if (mapping) item.dataMapping = mapping;
  else delete item.dataMapping;
  return next;
}
