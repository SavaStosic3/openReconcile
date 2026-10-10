// Diagram visibility is a personal browser preference, separate from plant data.
const MAX_SCOPES = 100;
const MAX_STREAMS = 500;
const MAX_AVAILABLE_STREAMS = 1_000;
const MAX_STORED_LENGTH = 2_000_000;
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
const scopeKey = (accountId, modelId) => JSON.stringify([accountId, modelId]);

export function createLineVisibility(options = {}) {
  let storage;
  try { storage = Object.hasOwn(options, 'storage') ? options.storage : globalThis.localStorage; } catch { storage = null; }
  const key = typeof options.key === 'string' && options.key ? options.key : 'massflow-line-visibility-v1';
  const scopes = new Map();
  let current = null;
  let streamIds = new Set();
  let lastSerialized = null;

  try {
    const raw = storage?.getItem(key);
    const saved = typeof raw === 'string' && raw.length <= MAX_STORED_LENGTH ? JSON.parse(raw) : null;
    if (saved?.version === 1 && Array.isArray(saved.scopes)) {
      lastSerialized = raw;
      for (const entry of saved.scopes.slice(-MAX_SCOPES)) {
        if (!entry || !validId(entry.accountId) || !validId(entry.modelId) || !Array.isArray(entry.hiddenIds)) continue;
        scopes.set(scopeKey(entry.accountId, entry.modelId), {
          accountId: entry.accountId,
          modelId: entry.modelId,
          hiddenIds: new Set(entry.hiddenIds.slice(0, MAX_STREAMS).filter(validId)),
          showHidden: entry.showHidden === true
        });
      }
    }
  } catch { /* Disabled storage or invalid saved preferences start with visible lines. */ }

  function snapshot() {
    return { hiddenIds: current ? [...current.hiddenIds].sort() : [], showHidden: current?.showHidden ?? false };
  }

  function persist() {
    try {
      const serialized = JSON.stringify({ version: 1, scopes: [...scopes.values()].map(entry => ({
        accountId: entry.accountId, modelId: entry.modelId,
        hiddenIds: [...entry.hiddenIds].sort(), showHidden: entry.showHidden
      })) });
      if (serialized !== lastSerialized) {
        lastSerialized = serialized;
        storage?.setItem(key, serialized);
      }
    } catch { /* Keep session preferences usable when storage is full or unavailable. */ }
    return snapshot();
  }

  return {
    scope(accountId, modelId, streams = []) {
      streamIds = new Set();
      if (Array.isArray(streams)) {
        for (const stream of streams) {
          const id = typeof stream === 'string' ? stream : stream?.id;
          if (validId(id)) streamIds.add(id);
          if (streamIds.size >= MAX_AVAILABLE_STREAMS) break;
        }
      }
      if (!validId(accountId) || !validId(modelId)) { current = null; return snapshot(); }
      const id = scopeKey(accountId, modelId);
      current = scopes.get(id) ?? { accountId, modelId, hiddenIds: new Set(), showHidden: false };
      current.hiddenIds = new Set([...current.hiddenIds].filter(hiddenId => streamIds.has(hiddenId)));
      // Retain the most recently visited models within a bounded preference store.
      scopes.delete(id);
      scopes.set(id, current);
      while (scopes.size > MAX_SCOPES) scopes.delete(scopes.keys().next().value);
      return persist();
    },
    snapshot,
    hide(id) {
      if (!current || !streamIds.has(id) || current.hiddenIds.has(id) || current.hiddenIds.size >= MAX_STREAMS) return snapshot();
      current.hiddenIds.add(id);
      return persist();
    },
    show(id) {
      if (!current || !current.hiddenIds.delete(id)) return snapshot();
      return persist();
    },
    setShowHidden(value) {
      if (!current) return snapshot();
      current.showHidden = value === true;
      return persist();
    },
    showAll() {
      if (!current) return snapshot();
      current.hiddenIds.clear();
      current.showHidden = false;
      return persist();
    }
  };
}
