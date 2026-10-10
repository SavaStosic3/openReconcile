import { portPosition, unitBounds } from './unit-symbols.js';

const EPSILON = 1e-7;
const BRIDGE_RADIUS = 7;
const coordinate = value => Number(value.toFixed(6));
const pointKey = point => `${coordinate(point.x)},${coordinate(point.y)}`;

function compactPoints(points) {
  const compact = [];
  for (const point of points) {
    const previous = compact.at(-1);
    if (!previous || previous.x !== point.x || previous.y !== point.y) compact.push(point);
  }
  return compact;
}

function segments(route) {
  return route.points.slice(1).map((end, index) => {
    const start = route.points[index];
    return { route, index, start, end, horizontal: start.y === end.y, left: Math.min(start.x, end.x), right: Math.max(start.x, end.x), top: Math.min(start.y, end.y), bottom: Math.max(start.y, end.y) };
  });
}

/** Orthogonal routes retain their lanes when unrelated streams are hidden. */
export function routeStream(model, stream) {
  const source = model.nodes.find(node => node.id === stream.source);
  const target = model.nodes.find(node => node.id === stream.target);
  if (!source || !target) return null;
  const start = portPosition(source, 'out'), end = portPosition(target, 'in');
  const parallel = model.streams.filter(edge => edge.source === stream.source && edge.target === stream.target)
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const index = parallel.findIndex(edge => edge.id === stream.id);
  const lane = (index - (parallel.length - 1) / 2) * 32;
  let points, label;
  if (end.x - start.x > 85) {
    const middle = (start.x + end.x) / 2 + lane;
    if (Math.abs(start.y - end.y) < 6 && parallel.length > 1) {
      const y = start.y + lane;
      points = [start, { x: start.x + 34, y: start.y }, { x: start.x + 34, y }, { x: end.x - 34, y }, { x: end.x - 34, y: end.y }, end];
      label = { x: (start.x + end.x) / 2, y };
    } else {
      points = [start, { x: middle, y: start.y }, { x: middle, y: end.y }, end];
      label = { x: middle, y: (start.y + end.y) / 2 };
    }
  } else {
    const bottom = Math.max(unitBounds(source).bottom, unitBounds(target).bottom) + 65 + index * 32;
    points = [start, { x: start.x + 42, y: start.y }, { x: start.x + 42, y: bottom }, { x: end.x - 42, y: bottom }, { x: end.x - 42, y: end.y }, end];
    label = { x: (start.x + end.x) / 2, y: bottom };
  }
  return { id: stream.id, points: compactPoints(points), label };
}

function boundsFor(points, bridges) {
  return {
    left: Math.min(...points.map(point => point.x)), right: Math.max(...points.map(point => point.x)),
    top: Math.min(...points.map(point => point.y), ...bridges.map(bridge => bridge.y - bridge.radius)),
    bottom: Math.max(...points.map(point => point.y))
  };
}

/**
 * Only strict perpendicular crossings get bridges. Endpoints, bends, shared
 * ports, and collinear segments keep their actual connection geometry.
 * Horizontal paths always pass above vertical paths, independent of draw order.
 */
export function addCrossingBridges(routes) {
  const allSegments = routes.flatMap(segments);
  const vertical = allSegments.filter(segment => !segment.horizontal && segment.start.x === segment.end.x)
    .sort((a, b) => a.start.x - b.start.x);
  const endpoints = new Map(routes.map(route => [route.id, new Set([pointKey(route.points[0]), pointKey(route.points.at(-1))])]));
  const byRoute = new Map(routes.map(route => [route.id, new Map()]));
  for (const horizontal of allSegments.filter(segment => segment.horizontal)) {
    const crossings = [];
    for (const other of vertical) {
      const x = other.start.x, y = horizontal.start.y;
      if (x >= horizontal.right - EPSILON) break;
      if (x <= horizontal.left + EPSILON || other.route.id === horizontal.route.id || y <= other.top + EPSILON || y >= other.bottom - EPSILON) continue;
      const key = pointKey({ x, y });
      if (endpoints.get(horizontal.route.id).has(key) || endpoints.get(other.route.id).has(key)) continue;
      if (!crossings.some(value => Math.abs(value - x) < EPSILON)) crossings.push(x);
    }
    const bridges = crossings.sort((a, b) => a - b).map((x, index) => {
      // Shrink near corners and close neighbors instead of producing arcs that
      // overlap, reverse the path, or run beyond the segment's endpoints.
      const radius = Math.min(BRIDGE_RADIUS, (x - horizontal.left) * 0.8, (horizontal.right - x) * 0.8,
        index > 0 ? (x - crossings[index - 1]) * 0.4 : Infinity,
        index < crossings.length - 1 ? (crossings[index + 1] - x) * 0.4 : Infinity);
      return { x, y: horizontal.start.y, radius };
    }).filter(bridge => bridge.radius > EPSILON);
    byRoute.get(horizontal.route.id).set(horizontal.index, bridges);
  }
  return routes.map(route => {
    const routeSegments = segments(route), bridges = [];
    let d = `M ${coordinate(route.points[0].x)} ${coordinate(route.points[0].y)}`;
    for (const segment of routeSegments) {
      if (!segment.horizontal) { d += ` V ${coordinate(segment.end.y)}`; continue; }
      const direction = segment.end.x >= segment.start.x ? 1 : -1;
      const crossings = [...(byRoute.get(route.id).get(segment.index) || [])].sort((a, b) => direction * (a.x - b.x));
      for (const crossing of crossings) {
        const startX = crossing.x - direction * crossing.radius, endX = crossing.x + direction * crossing.radius;
        const arc = `A ${coordinate(crossing.radius)} ${coordinate(crossing.radius)} 0 0 ${direction > 0 ? 1 : 0} ${coordinate(endX)} ${coordinate(crossing.y)}`;
        d += ` H ${coordinate(startX)} ${arc}`;
        bridges.push({ ...crossing, d: `M ${coordinate(startX)} ${coordinate(crossing.y)} ${arc}` });
      }
      d += ` H ${coordinate(segment.end.x)}`;
    }
    // Lift both rows clear of the arch: the published value sits 12 px below
    // this anchor, with glyph descenders and its background outline beneath it.
    const label = { ...route.label };
    if (bridges.some(bridge => Math.abs(bridge.y - label.y) < EPSILON && Math.abs(bridge.x - label.x) < 80)) label.y -= 30;
    return { ...route, label, d, bridges, bounds: boundsFor(route.points, bridges) };
  });
}

export function getStreamRoutes(model, { hiddenIds = [], showHidden = false } = {}) {
  const hidden = new Set(hiddenIds);
  const routes = model.streams.filter(stream => showHidden || !hidden.has(stream.id)).map(stream => routeStream(model, stream)).filter(Boolean);
  return new Map(addCrossingBridges(routes).map(route => [route.id, route]));
}
