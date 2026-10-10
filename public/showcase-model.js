const node = (id, kind, name, x, y) => ({ id, kind, name, x, y });
const stream = (id, source, target, name, material, overrides = {}) => ({
  id, source, target, name, material, phase: 'Slurry', density: 1100,
  temperature: 25, pressure: 300, measured: false, metric: 'massFlow',
  unit: 'kg/h', value: '', uncertainty: 10, uncertaintyType: 'absolute',
  dataMapping: { sourceName: `FILTRATION.${id.toUpperCase().replaceAll('-', '_')}` },
  ...overrides,
});
const physical = (meterName, value, uncertainty = 10) => ({
  measured: true, meterType: 'physical', meterName, value, uncertainty,
});

// The downstream feed meter reads 10 kg/h above the upstream meter sum.
// Known uncertainties make the resulting adjustments independently checkable;
// the three unmetered streams are uniquely determined by conservation.
const SHOWCASE_MODEL = {
  version: 1, name: 'Slurry filtration with recycle', periodHours: 1,
  nodes: [
    node('raw-feed', 'inlet', 'Raw slurry', 70, 260),
    node('feed-pump', 'pump', 'Feed pump', 240, 260),
    node('wash-water', 'inlet', 'Wash water', 240, 70),
    node('feed-mixer', 'mixer', 'Feed mixer', 460, 260),
    node('slurry-heater', 'heatExchanger', 'Slurry heater', 680, 260),
    node('pressure-filter', 'filter', 'Pressure filter', 900, 260),
    node('product-split', 'splitter', 'Product split', 1120, 260),
    node('product', 'outlet', 'Product', 1300, 260),
    node('filter-cake', 'outlet', 'Filter cake', 1120, 460),
  ],
  streams: [
    stream('raw-feed-flow', 'raw-feed', 'feed-pump', 'F-01 · Raw feed', 'Aqueous process slurry', physical('RAW FEED', 800)),
    stream('pump-discharge', 'feed-pump', 'feed-mixer', 'F-02 · Pump discharge', 'Aqueous process slurry'),
    stream('wash-water-flow', 'wash-water', 'feed-mixer', 'F-03 · Wash water', 'Wash water', { ...physical('WASH WATER', 200, 5), phase: 'Liquid', density: 1000, pressure: 200 }),
    stream('mixed-feed', 'feed-mixer', 'slurry-heater', 'F-04 · Mixed feed', 'Diluted process slurry', { measured: true, meterType: 'virtual', meterName: 'MIXED FEED', formula: '[RAW FEED] + [WASH WATER] + [RECYCLE]', uncertainty: 5 }),
    stream('conditioned-feed', 'slurry-heater', 'pressure-filter', 'F-05 · Filter feed', 'Heated process slurry', { ...physical('FILTER FEED', 1060), temperature: 45 }),
    stream('filtrate', 'pressure-filter', 'product-split', 'F-06 · Filtrate', 'Filtered process liquid', { phase: 'Liquid', density: 1050, temperature: 45 }),
    stream('filter-cake-flow', 'pressure-filter', 'filter-cake', 'F-07 · Filter cake', 'Wet filter cake', { phase: 'Solid', density: 1400, temperature: 45 }),
    stream('product-flow', 'product-split', 'product', 'F-08 · Product', 'Filtered process liquid', { ...physical('PRODUCT', 900), phase: 'Liquid', density: 1050, temperature: 45 }),
    stream('recycle', 'product-split', 'feed-mixer', 'F-09 · Recycle', 'Recycled process liquid', { ...physical('RECYCLE', 50, 5), phase: 'Liquid', density: 1050, temperature: 45 }),
  ],
};

export function showcaseModel() { return structuredClone(SHOWCASE_MODEL); }
