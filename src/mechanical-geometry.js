import * as THREE from 'three';
import { GEOMETRY as G } from './geometry.js';

export const MECHANICAL = Object.freeze({
  rulerLengthM: 1.84, rulerPixels: 8192, rulerWidthM: .023,
  railBottomY: .024, baseTopY: .02325, railGuideTopY: .03775,
  carriageRoofBottomY: .03805, carriageTopY: .0525,
  shoeTopY: .0342, shoeBottomY: .034, shoeCenterZM: .024, shoeWidthM: .003,
  irisPlaneXM: -.003, irisThicknessM: .0008, rayClipHalfLengthM: .0041,
  barrelBoreRadiusM: .013, seatInnerRadiusM: G.lensRadius * 60 / 64,
  seatBackXM: .0024, seatEdgeXM: .0005, glassRadialSegments: 64, angularSegments: 128,
  screenBackingThicknessM: .002,
});
export const rulerWorldToUv = worldXM => .5 + worldXM / MECHANICAL.rulerLengthM;
export const rulerUvToWorld = u => (u - .5) * MECHANICAL.rulerLengthM;
export const rulerTickPixel = mm => rulerWorldToUv(mm / 1000) * MECHANICAL.rulerPixels;
export function glassHalfThicknessM(r) {
  return (G.lensEdgeThickness + (G.lensCenterThickness - G.lensEdgeThickness) * (1 - (r / G.lensRadius) ** 2)) / 2;
}

// Closed X-axis surfaces. Smooth rotational normals; each profile edge keeps
// its own meridian normal unless both endpoints belong to one smooth surface.
export function revolvedGeometry(profile, segments = MECHANICAL.angularSegments, radiusAt = null) {
  const position = [], normal = [], uv = [], minX = Math.min(...profile.map(p => p.x));
  const spanX = Math.max(...profile.map(p => p.x)) - minX, tau = 2 * Math.PI;
  const point = (p, a) => { const r = radiusAt ? radiusAt(p, a) : p.r; return new THREE.Vector3(p.x, r * Math.cos(a), r * Math.sin(a)); };
  for (let j = 0; j < profile.length; j++) {
    const a = profile[j], b = profile[(j + 1) % profile.length], dx = b.x - a.x, dr = b.r - a.r, norm = Math.hypot(dx, dr);
    for (let i = 0; i < segments; i++) {
      const t0 = tau * i / segments, t1 = tau * (i + 1) / segments;
      for (const triangle of [[[a, t0], [b, t1], [b, t0]], [[a, t0], [a, t1], [b, t1]]]) {
        const points = triangle.map(([p, t]) => point(p, t)), cross = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
        if (cross.lengthSq() < 1e-30) continue; // True pole fans, no collapsed triangles.
        cross.normalize();
        triangle.forEach(([p, t], index) => {
          const n = a.surface && a.surface === b.surface ? p.normal : [-dr / norm, dx / norm];
          position.push(...points[index].toArray());
          normal.push(...(radiusAt ? cross.toArray() : [n[0], n[1] * Math.cos(t), n[1] * Math.sin(t)]));
          uv.push(t / tau, (p.x - minX) / spanX);
        });
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normal, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geometry.computeBoundingBox(); geometry.computeBoundingSphere(); return geometry;
}

export function glassProfile() {
  const result = [];
  for (const sign of [-1, 1]) for (let i = 0; i <= MECHANICAL.glassRadialSegments; i++) {
    const r = G.lensRadius * (sign < 0 ? i : MECHANICAL.glassRadialSegments - i) / MECHANICAL.glassRadialSegments;
    const slope = (G.lensCenterThickness - G.lensEdgeThickness) * r / (G.lensRadius ** 2), norm = Math.hypot(1, slope);
    result.push({ x: sign * glassHalfThicknessM(r), r, normal: [sign / norm, slope / norm], surface: `glass-${sign}` });
  }
  return result;
}
export function glassGeometry() { return revolvedGeometry(glassProfile()); }

export function seatProfile(side = -1) {
  if (![-1, 1].includes(side)) throw new RangeError('Seat side must be -1 or 1');
  const m = MECHANICAL, p = (x, r) => ({ x, r });
  const result = [p(-m.seatBackXM, m.seatInnerRadiusM), p(-m.seatBackXM, m.barrelBoreRadiusM),
    p(-m.seatEdgeXM, m.barrelBoreRadiusM), p(-m.seatEdgeXM, G.lensRadius)];
  for (let i = 64; i >= 60; i--) {
    const r = G.lensRadius * i / 64; result.push(p(-glassHalfThicknessM(r), r));
  }
  return side < 0 ? result : result.map(p => ({ x: -p.x, r: p.r })).reverse();
}
export function seatGeometry(side) { return revolvedGeometry(seatProfile(side)); }

export function finishedRingGeometry(inner, outer, thickness, bevel = .00015) {
  const c = Math.min(bevel, (outer - inner) / 4, thickness / 4), h = thickness / 2;
  return revolvedGeometry([{ x: -h, r: inner + c }, { x: -h, r: outer - c }, { x: -h + c, r: outer },
    { x: h - c, r: outer }, { x: h, r: outer - c }, { x: h, r: inner + c }, { x: h - c, r: inner }, { x: -h + c, r: inner }]);
}
export function knurledRingGeometry(inner, outer, thickness, teeth = 48) {
  const h = thickness / 2, depth = .00018, bevel = .00015;
  const profile = [{ x: -h, r: inner }, { x: -h, r: outer - bevel, knurl: true },
    { x: -h + bevel, r: outer, knurl: true }, { x: h - bevel, r: outer, knurl: true },
    { x: h, r: outer - bevel, knurl: true }, { x: h, r: inner }];
  return revolvedGeometry(profile, teeth * 2, (p, angle) => p.r - (p.knurl ? depth * (1 - Math.cos(teeth * angle)) / 2 : 0));
}

// Display-only adjustment travel. It is not a solved blade linkage.
export function apertureControlAngle(diameterMm) {
  return (-35 + 70 * (diameterMm - G.apertureDiameterMm[0]) / (G.apertureDiameterMm[1] - G.apertureDiameterMm[0])) * Math.PI / 180;
}
export function screenBackingGeometry() {
  const geometry = new THREE.BoxGeometry(MECHANICAL.screenBackingThicknessM, G.screenHeight, G.screenWidth);
  geometry.translate(MECHANICAL.screenBackingThicknessM / 2, 0, 0);
  const indices = [], index = geometry.index, normal = geometry.attributes.normal;
  // The existing optical raster is the front face. Avoid a coplanar opaque face.
  for (let i = 0; i < index.count; i += 3) if (normal.getX(index.getX(i)) > -.5) indices.push(index.getX(i), index.getX(i + 1), index.getX(i + 2));
  geometry.setIndex(indices); geometry.clearGroups(); geometry.computeBoundingBox(); return geometry;
}
export function rayDisplayClipPlanes() {
  // Three.js clipIntersection discards points negative to ALL listed planes.
  // That intersection is exactly the open slab −h < X < +h.
  const h = MECHANICAL.rayClipHalfLengthM;
  return [new THREE.Plane(new THREE.Vector3(-1, 0, 0), -h), new THREE.Plane(new THREE.Vector3(1, 0, 0), -h)];
}
