// Audit descriptions deliberately read known model fields only. Connector
// credentials, arbitrary imported metadata, and complete models never enter
// an audit event through this module.
const MAX_DETAILS = 100;
const MAX_TEXT = 1000;
const text = value => typeof value === 'string' ? value : null;
const bounded = value => typeof value === 'string' ? value.slice(0, MAX_TEXT) : value;
const number = value => value === '' || value === null || value === undefined || typeof value === 'boolean' || !Number.isFinite(Number(value)) ? null : Number(value);
// Invalid readings remain editable drafts. Their actual entered text belongs
// in the change record, while numeric trend points still use number() only.
const enteredScalar = value => value === '' || value === null || value === undefined ? null : number(value) ?? text(value);
const scalar = value => typeof value === 'number' ? number(value) : typeof value === 'boolean' ? value : text(value);
const items = (model, collection) => new Map((model?.[collection] ?? []).map(item => [item.id, item]));
const meterType = stream => stream?.measured === true ? stream.meterType === 'virtual' ? 'virtual' : 'physical' : null;
const meterName = stream => text(stream?.meterName?.trim() || stream?.name || 'Unnamed meter');
const itemName = (item, kind) => kind === 'stream' && item?.measured ? meterName(item) : text(item?.name ?? 'Unnamed process unit');
const reading = stream => meterType(stream) === 'physical' ? number(stream.value) : null;
const context = (before, after, kind = 'stream') => ({
  itemId: text((after ?? before)?.id), itemName: bounded(itemName(after ?? before, kind)),
  unit: bounded(text(after?.unit)), previousUnit: bounded(text(before?.unit)),
  metric: bounded(text(after?.metric)), previousMetric: bounded(text(before?.metric)),
  meterType: meterType(after), previousMeterType: meterType(before)
});

// Kept separate from the chunked event details so a large model edit cannot
// silently lose its physical reading points. A removed meter ends its series
// with null, not its cached value.
export function describeReadingChanges(before, after) {
  const prior = items(before, 'streams'), next = items(after, 'streams'), changes = [];
  for (const id of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
    const oldStream = prior.get(id), newStream = next.get(id);
    if (meterType(oldStream) !== 'physical' && meterType(newStream) !== 'physical') continue;
    const oldValue = reading(oldStream), newValue = reading(newStream);
    const scaleChanged = text(oldStream?.unit) !== text(newStream?.unit) || text(oldStream?.metric) !== text(newStream?.metric);
    if (oldValue !== newValue || scaleChanged && (oldValue !== null || newValue !== null)) changes.push({ ...context(oldStream, newStream), field: 'value', before: oldValue, after: newValue });
  }
  return changes;
}

export function describeModelChanges(before, after) {
  const grouped = new Map();
  function add(category, detail, field, oldValue, newValue) {
    if (oldValue === newValue) return;
    const group = grouped.get(category) ?? { category, action: 'updated', summary: '', changes: [], totalChanges: 0, truncated: false };
    group.totalChanges++;
    group.changes.push(Object.fromEntries(Object.entries({ ...detail, field, before: oldValue, after: newValue }).map(([key, value]) => {
      // Diagram IDs are references, rather than labels. Keep them exact so a
      // reading point can identify its event and topology changes stay distinct.
      const identifier = key === 'itemId' || (key === 'before' || key === 'after') && (field === 'source' || field === 'target');
      return [key, identifier ? value : bounded(value)];
    })));
    grouped.set(category, group);
  }
  const modelContext = { itemId: null, itemName: text(after?.name ?? before?.name ?? 'Model') };
  add('model', modelContext, 'name', text(before?.name), text(after?.name));
  add('model', modelContext, 'periodHours', number(before?.periodHours), number(after?.periodHours));
  for (const collection of ['nodes', 'streams']) {
    const kind = collection === 'nodes' ? 'node' : 'stream', prior = items(before, collection), next = items(after, collection);
    for (const id of [...new Set([...prior.keys(), ...next.keys()])].sort()) {
      const oldItem = prior.get(id), newItem = next.get(id), detail = context(oldItem, newItem, kind);
      add('model', detail, 'presence', Boolean(oldItem), Boolean(newItem));
      const modelFields = kind === 'node' ? ['name', 'kind', 'x', 'y'] : ['name', 'source', 'target', 'material', 'phase', 'temperature', 'pressure'];
      for (const field of modelFields) add('model', detail, field, scalar(oldItem?.[field]), scalar(newItem?.[field]));
      const oldMapping = text(oldItem?.dataMapping?.sourceName), newMapping = text(newItem?.dataMapping?.sourceName);
      add('mapping', detail, 'sourceName', oldMapping, newMapping);
      if (oldMapping !== null || newMapping !== null) add('mapping', detail, 'modelName', oldMapping === null ? null : itemName(oldItem, kind), newMapping === null ? null : itemName(newItem, kind));
      if (kind === 'node') {
        const oldInventory = oldItem?.inventory, newInventory = newItem?.inventory;
        const inventoryDetail = { ...detail, unit: text(newInventory?.unit), previousUnit: text(oldInventory?.unit), metric: text(newInventory?.basis), previousMetric: text(oldInventory?.basis) };
        add('measurement', inventoryDetail, 'inventory.presence', Boolean(oldInventory), Boolean(newInventory));
        for (const field of ['basis', 'unit', 'density', 'densityUncertainty', 'readingCorrelation', 'capacityMass']) {
          const normalize = ['basis', 'unit'].includes(field) ? text : number;
          add('measurement', inventoryDetail, `inventory.${field}`, normalize(oldInventory?.[field]), normalize(newInventory?.[field]));
        }
        for (const field of ['kind', 'diameter', 'area']) {
          const normalize = field === 'kind' ? text : number;
          add('measurement', inventoryDetail, `inventory.geometry.${field}`, normalize(oldInventory?.geometry?.[field]), normalize(newInventory?.geometry?.[field]));
        }
        const oldPoints = oldInventory?.geometry?.points ?? [], newPoints = newInventory?.geometry?.points ?? [];
        for (let index = 0; index < Math.max(oldPoints.length, newPoints.length); index++) {
          for (const field of ['level', 'volume']) add('measurement', inventoryDetail, `inventory.geometry.points[${index}].${field}`, number(oldPoints[index]?.[field]), number(newPoints[index]?.[field]));
        }
        for (const endpoint of ['opening', 'closing']) {
          const oldReading = oldInventory?.[endpoint], newReading = newInventory?.[endpoint];
          add('measurement', inventoryDetail, `inventory.${endpoint}.measured`, oldReading?.measured === true, newReading?.measured === true);
          add('measurement', inventoryDetail, `inventory.${endpoint}.value`, oldReading?.measured === true ? enteredScalar(oldReading.value) : null, newReading?.measured === true ? enteredScalar(newReading.value) : null);
          add('measurement', inventoryDetail, `inventory.${endpoint}.uncertainty`, enteredScalar(oldReading?.uncertainty), enteredScalar(newReading?.uncertainty));
          add('measurement', inventoryDetail, `inventory.${endpoint}.uncertaintyType`, text(oldReading?.uncertaintyType), text(newReading?.uncertaintyType));
          const oldSource = text(oldReading?.dataMapping?.sourceName), newSource = text(newReading?.dataMapping?.sourceName);
          add('mapping', inventoryDetail, `inventory.${endpoint}.sourceName`, oldSource, newSource);
          if (oldSource !== null || newSource !== null) add('mapping', inventoryDetail, `inventory.${endpoint}.modelName`, oldSource === null ? null : `${itemName(oldItem, kind)} · ${endpoint}`, newSource === null ? null : `${itemName(newItem, kind)} · ${endpoint}`);
        }
      }
      if (kind !== 'stream') continue;
      const oldType = meterType(oldItem), newType = meterType(newItem), metered = oldType !== null || newType !== null;
      add('measurement', detail, 'measured', oldType !== null, newType !== null);
      add('measurement', detail, 'meterType', oldType, newType);
      add('measurement', detail, 'meterName', oldType === null ? null : meterName(oldItem), newType === null ? null : meterName(newItem));
      if (oldType === 'physical' || newType === 'physical') add('measurement', detail, 'value', oldType === 'physical' ? enteredScalar(oldItem.value) : null, newType === 'physical' ? enteredScalar(newItem.value) : null);
      for (const field of ['metric', 'unit', 'uncertainty', 'uncertaintyType', 'density']) {
        const normalize = field === 'uncertainty' ? enteredScalar : field === 'density' ? number : text;
        add(metered ? 'measurement' : 'model', detail, field, normalize(oldItem?.[field]), normalize(newItem?.[field]));
      }
      add('measurement', detail, 'formula', oldType === 'virtual' ? text(oldItem?.formula ?? '') : null, newType === 'virtual' ? text(newItem?.formula ?? '') : null);
    }
  }
  const labels = { model: 'model', measurement: 'measurement', mapping: 'data mapping' };
  return ['measurement', 'mapping', 'model'].filter(category => grouped.has(category)).flatMap(category => {
    const event = grouped.get(category);
    const parts = Math.ceil(event.changes.length / MAX_DETAILS);
    return Array.from({ length: parts }, (_, index) => ({
      ...event, changes: event.changes.slice(index * MAX_DETAILS, (index + 1) * MAX_DETAILS), part: index + 1, parts,
      summary: `Updated ${event.totalChanges} ${labels[category]} field${event.totalChanges === 1 ? '' : 's'}${parts > 1 ? ` (changes ${index * MAX_DETAILS + 1}–${Math.min((index + 1) * MAX_DETAILS, event.totalChanges)} of ${event.totalChanges})` : ''}`
    }));
  });
}
