import { MODEL_VERSION, solveOptics } from './physics.js';

const TARGET_MM = 12, SCREEN_MM = 48;
const EXPOSURE = 1.2;
// Original, disjoint mask pieces, counterclockwise in horizontal/vertical mm.
// An upward arrow and an upper-right registration square show both-axis inversion.
const targetPolygons = [
  [[-.75, -4], [.75, -4], [.75, .5], [-.75, .5]],
  [[-2.25, .5], [2.25, .5], [0, 4.5]],
  [[2.5, 1.5], [4, 1.5], [4, 3], [2.5, 3]],
];

function rasterSize(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) || Object.keys(options).some(key => key !== 'size')) throw new TypeError('raster options must contain only size');
  const size = options.size ?? 192;
  if (!Number.isInteger(size) || size < 16 || size > 512) throw new RangeError('raster size must be an integer in 16..512');
  return size;
}

function targetMask(x, y) {
  return (Math.abs(x) <= .75 && y >= -4 && y <= .5) ||
    (y >= .5 && y <= 4.5 && Math.abs(x) <= (4.5 - y) * .5625) ||
    (x >= 2.5 && x <= 4 && y >= 1.5 && y <= 3);
}

function tone(linear) {
  // A fixed exposure and fixed display transfer; no image min/max or histogram.
  const exposed = -Math.expm1(-EXPOSURE * Math.max(0, linear));
  const srgb = exposed <= .0031308 ? 12.92 * exposed : 1.055 * exposed ** (1 / 2.4) - .055;
  return Math.round(255 * srgb);
}

function result(size, physicalMm, linear) {
  const rgba = new Uint8ClampedArray(size * size * 4);
  for (let index = 0; index < linear.length; index++) {
    const level = tone(linear[index]);
    rgba[index * 4] = level; rgba[index * 4 + 1] = level; rgba[index * 4 + 2] = level; rgba[index * 4 + 3] = 255;
  }
  return { width: size, height: size, physicalWidthMm: physicalMm, physicalHeightMm: physicalMm, linear, rgba };
}

export function makeTarget(options = {}) {
  const size = rasterSize(options), pitch = TARGET_MM / size;
  const linear = new Float32Array(size * size);
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let coverage = 0;
    for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
      if (targetMask((col + dx) * pitch - TARGET_MM / 2, TARGET_MM / 2 - (row + dy) * pitch)) coverage += .25;
    }
    linear[row * size + col] = coverage;
  }
  return result(size, TARGET_MM, linear);
}

function polygonData(vertices) {
  let twiceArea = 0;
  const edges = vertices.map((start, index) => {
    const end = vertices[(index + 1) % vertices.length];
    const dx = end[0] - start[0], dy = end[1] - start[1];
    twiceArea += start[0] * end[1] - start[1] * end[0];
    return { start, end, dx, dy, length: Math.hypot(dx, dy), squaredLength: dx * dx + dy * dy };
  });
  return {
    vertices, edges, area: twiceArea / 2,
    minX: Math.min(...vertices.map(point => point[0])), maxX: Math.max(...vertices.map(point => point[0])),
    minY: Math.min(...vertices.map(point => point[1])), maxY: Math.max(...vertices.map(point => point[1])),
  };
}

function diskIntersection(polygon, x, y, radius, radiusSquared, diskArea) {
  if (x + radius <= polygon.minX || x - radius >= polygon.maxX || y + radius <= polygon.minY || y - radius >= polygon.maxY) return 0;
  if (polygon.vertices.every(p => (p[0] - x) ** 2 + (p[1] - y) ** 2 <= radiusSquared)) return polygon.area;
  if (polygon.edges.every(e => e.dx * (y - e.start[1]) - e.dy * (x - e.start[0]) >= radius * e.length)) return diskArea;
  // Green's theorem: split each oriented edge at the circle intersections.
  // An inside segment contributes its triangle; outside contributes its sector.
  let area = 0;
  for (const edge of polygon.edges) {
    const ax = edge.start[0] - x, ay = edge.start[1] - y;
    const b = 2 * (ax * edge.dx + ay * edge.dy);
    const c = ax * ax + ay * ay - radiusSquared;
    const discriminant = b * b - 4 * edge.squaredLength * c;
    const cuts = [0];
    if (discriminant > 0) {
      const root = Math.sqrt(discriminant);
      const first = (-b - root) / (2 * edge.squaredLength), second = (-b + root) / (2 * edge.squaredLength);
      if (first > 0 && first < 1) cuts.push(first);
      if (second > 0 && second < 1) cuts.push(second);
    }
    cuts.push(1);
    for (let index = 0; index < cuts.length - 1; index++) {
      const t0 = cuts[index], t1 = cuts[index + 1], tm = (t0 + t1) / 2;
      const x0 = ax + t0 * edge.dx, y0 = ay + t0 * edge.dy;
      const x1 = ax + t1 * edge.dx, y1 = ay + t1 * edge.dy;
      const xm = ax + tm * edge.dx, ym = ay + tm * edge.dy;
      const cross = x0 * y1 - y0 * x1;
      area += xm * xm + ym * ym <= radiusSquared
        ? cross / 2 : radiusSquared * Math.atan2(cross, x0 * x1 + y0 * y1) / 2;
    }
  }
  // Only remove floating-point cancellation at the zero/full-area boundaries.
  return Math.min(polygon.area, diskArea, Math.max(0, area));
}

function checkedSolution(solution) {
  if (!solution || solution.modelVersion !== MODEL_VERSION) throw new TypeError('A current solveOptics result is required');
  const expected = solveOptics(solution.config);
  for (const key of Object.keys(expected.screen)) if (solution.screen?.[key] !== expected.screen[key]) throw new RangeError(`Inconsistent optical solution.screen.${key}`);
  for (const key of Object.keys(expected.image)) if (solution.image?.[key] !== expected.image[key]) throw new RangeError(`Inconsistent optical solution.image.${key}`);
  if (solution.light?.collectedRelative !== expected.light.collectedRelative) throw new RangeError('Inconsistent optical solution.light');
  return expected;
}

export function makeProjection(solution, options = {}) {
  const size = rasterSize(options), optics = checkedSolution(solution);
  const pitch = SCREEN_MM / size, scale = optics.screen.objectScale, radius = optics.screen.blurRadiusMm;
  const linear = new Float32Array(size * size);
  const polygons = targetPolygons.map(vertices => polygonData(vertices.map(([x, y]) => [scale * x, scale * y])));
  const radiusSquared = radius * radius, diskArea = Math.PI * radiusSquared;
  // Below this subpixel threshold, finite blur cannot be meaningfully resolved
  // by the pixel quadrature; avoid division by a numerically vanishing disk.
  const sharp = radius < pitch * 1e-5;
  for (let row = 0; row < size; row++) for (let col = 0; col < size; col++) {
    let coverage = 0;
    for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
      const x = (col + dx) * pitch - SCREEN_MM / 2, y = SCREEN_MM / 2 - (row + dy) * pitch;
      if (sharp) coverage += targetMask(x / scale, y / scale) ? .25 : 0;
      else {
        let area = 0;
        for (const polygon of polygons) area += diskIntersection(polygon, x, y, radius, radiusSquared, diskArea);
        coverage += .25 * Math.min(1, Math.max(0, area / diskArea));
      }
    }
    linear[row * size + col] = optics.screen.irradianceScale * coverage;
  }
  return result(size, SCREEN_MM, linear);
}
