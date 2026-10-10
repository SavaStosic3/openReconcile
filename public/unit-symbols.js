const NS = 'http://www.w3.org/2000/svg';
const primitive = (tag, attrs) => ({ tag, attrs });
const path = d => primitive('path', { d, fill: 'none' });
const circle = (r, attrs = {}) => primitive('circle', { cx: 0, cy: 0, r, ...attrs });
const leads = halfWidth => path(`M -56 0 H -${halfWidth} M ${halfWidth} 0 H 56`);

// These are compact diagram glyphs, not a claim of compliance with a P&ID standard.
// All internal units use the same two connection positions, independent of the glyph.
export const UNIT_SYMBOLS = {
  tank: {
    label: 'Tank',
    description: 'Liquid inventory & accumulation',
    primitives: [
      leads(29),
      primitive('path', { d: 'M -29 -24 V 24 C -29 38 29 38 29 24 V -24 Z' }),
      primitive('ellipse', { cx: 0, cy: -24, rx: 29, ry: 10 }),
      path('M -29 10 C -20 18 20 18 29 10 M -15 -2 H 15'),
    ],
  },
  bulkStorage: {
    label: 'Storage silo',
    description: 'Bulk inventory & accumulation',
    primitives: [
      leads(27),
      primitive('polygon', { points: '-27,-22 0,-34 27,-22 27,13 10,31 -10,31 -27,13' }),
      path('M -27 -22 H 27 M -27 13 H 27 M -10 31 V 36 H 10 V 31 M -17 1 H 17'),
    ],
  },
  process: {
    label: 'Process unit',
    description: 'Any balanced operation',
    primitives: [
      leads(32),
      primitive('polygon', { points: '-32,0 -20,-28 20,-28 32,0 20,28 -20,28' }),
      path('M -11 -10 H 11 M -11 0 H 11 M -11 10 H 11'),
    ],
  },
  mixer: {
    label: 'Mixer',
    description: 'Combine streams',
    primitives: [
      leads(28), circle(28),
      path('M -18 -13 L 3 0 H 18 M -18 13 L 3 0'),
      circle(3, { cx: 3, fill: 'stroke', stroke: 'none' }),
    ],
  },
  splitter: {
    label: 'Splitter',
    description: 'Divide streams',
    primitives: [
      leads(28), circle(28),
      path('M -18 0 H -3 L 18 -13 M -3 0 L 18 13'),
      circle(3, { cx: -3, fill: 'stroke', stroke: 'none' }),
    ],
  },
  pump: {
    label: 'Pump',
    description: 'Move liquids',
    primitives: [
      leads(28), circle(28),
      primitive('polygon', { points: '-11,-15 15,0 -11,15' }),
      path('M -17 23 L -21 33 H 21 L 17 23'),
    ],
  },
  compressor: {
    label: 'Compressor',
    description: 'Compress gases',
    primitives: [
      leads(28), circle(28),
      primitive('polygon', { points: '-12,-17 13,-9 13,9 -12,17' }),
      path('M -17 23 L -21 33 H 21 L 17 23'),
    ],
  },
  valve: {
    label: 'Valve',
    description: 'Regulate flow',
    primitives: [
      leads(27),
      primitive('polygon', { points: '-27,-20 0,0 -27,20' }),
      primitive('polygon', { points: '27,-20 0,0 27,20' }),
      path('M 0 0 V -31 M -10 -31 H 10'),
    ],
  },
  heatExchanger: {
    label: 'Heat exchanger',
    description: 'Transfer heat',
    primitives: [
      leads(29), circle(29),
      path('M -21 0 H -15 L -9 -13 L -3 13 L 3 -13 L 9 13 L 15 0 H 21'),
    ],
  },
  filter: {
    label: 'Filter',
    description: 'Separate solids',
    primitives: [
      leads(32),
      primitive('rect', { x: -32, y: -26, width: 64, height: 52, rx: 2 }),
      path('M -20 -16 L 12 16 M -8 -16 L 20 12 M -20 -4 L 0 16 M -20 16 L 12 -16 M -8 16 L 20 -12 M -20 4 L 0 -16'),
    ],
  },
  cyclone: {
    label: 'Cyclone',
    description: 'Separate particles',
    primitives: [
      leads(22),
      primitive('polygon', { points: '-26,-29 26,-29 26,-8 8,27 -8,27 -26,-8' }),
      path('M -26 -8 H 26 M -8 27 V 34 H 8 V 27 M -11 -20 H 11'),
    ],
  },
  conveyor: {
    label: 'Conveyor',
    description: 'Move bulk solids',
    primitives: [
      leads(44),
      primitive('path', { d: 'M -32 -12 H 32 A 12 12 0 0 1 32 12 H -32 A 12 12 0 0 1 -32 -12 Z' }),
      circle(6, { cx: -28 }), circle(6), circle(6, { cx: 28 }),
      path('M -13 -22 H 13 M 8 -27 L 13 -22 L 8 -17'),
    ],
  },
};

const glyphSize = {
  tank: [29, 35], bulkStorage: [27, 36],
  process: [32, 28], mixer: [28, 28], splitter: [28, 28],
  pump: [28, 33], compressor: [28, 33], valve: [27, 31],
  heatExchanger: [29, 29], filter: [32, 26], cyclone: [26, 34], conveyor: [44, 27],
};
const boundary = kind => kind === 'inlet' || kind === 'outlet';

export function getUnitGeometry(kind) {
  if (boundary(kind)) {
    return {
      portHalfWidth: 27, bodyHalfWidth: 27, bodyHalfHeight: 25,
      labelY: 48, typeY: 64,
      bounds: { left: -88, right: 88, top: -38, bottom: 72 },
    };
  }
  const [bodyHalfWidth, bodyHalfHeight] = glyphSize[kind] || glyphSize.process;
  return {
    portHalfWidth: 56, bodyHalfWidth, bodyHalfHeight,
    labelY: 54, typeY: 70,
    bounds: { left: -88, right: 88, top: -40, bottom: 78 },
  };
}

export function portPosition(node, type) {
  const { portHalfWidth } = getUnitGeometry(node.kind);
  return { x: node.x + (type === 'out' ? portHalfWidth : -portHalfWidth), y: node.y };
}

export function unitBounds(node) {
  const { bounds } = getUnitGeometry(node.kind);
  return {
    left: node.x + bounds.left, right: node.x + bounds.right,
    top: node.y + bounds.top, bottom: node.y + bounds.bottom,
  };
}

export function appendUnitSymbol(kind, parent, { stroke = '#243a54', fill = '#fff', strokeWidth = 2 } = {}) {
  const symbol = UNIT_SYMBOLS[kind] || UNIT_SYMBOLS.process;
  for (const { tag, attrs } of symbol.primitives) {
    const item = document.createElementNS(NS, tag);
    const values = {
      stroke, fill, 'stroke-width': strokeWidth,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round', ...attrs,
    };
    if (values.fill === 'stroke') values.fill = stroke;
    for (const [name, value] of Object.entries(values)) item.setAttribute(name, String(value));
    parent.append(item);
  }
  return parent;
}
