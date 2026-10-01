import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { GEOMETRY as G } from '../src/geometry.js';
import { traceRay } from '../src/physics.js';
import { MECHANICAL as M, rulerWorldToUv, rulerUvToWorld, rulerTickPixel, glassHalfThicknessM,
  glassProfile, glassGeometry, seatProfile, seatGeometry, finishedRingGeometry, knurledRingGeometry, apertureControlAngle, screenBackingGeometry, rayDisplayClipPlanes } from '../src/mechanical-geometry.js';

const near = (a, b, tolerance = 1e-11) => assert.ok(Number.isFinite(a) && Math.abs(a - b) <= tolerance, `${a} != ${b}`);
function closedOutward(geometry) {
  const p = geometry.attributes.position, n = geometry.attributes.normal, edges = new Map();
  const key = v => v.toArray().map(n => Math.round(n * 1e9)).join(','); let volume6 = 0;
  for (let i = 0; i < p.count; i += 3) {
    const points = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, i + j));
    const cross = points[1].clone().sub(points[0]).cross(points[2].clone().sub(points[0]));
    assert.ok(cross.lengthSq() > 1e-28, 'collapsed triangle'); volume6 += points[0].dot(points[1].clone().cross(points[2]));
    for (let j = 0; j < 3; j++) {
      const normal = new THREE.Vector3().fromBufferAttribute(n, i + j); near(normal.length(), 1, 7e-8);
      assert.ok(cross.dot(normal) > 0, 'inward shading normal');
      const a = key(points[j]), b = key(points[(j + 1) % 3]), edge = [a, b].sort().join('|'), list = edges.get(edge) ?? [];
      list.push(a < b ? 1 : -1); edges.set(edge, list);
    }
  }
  for (const list of edges.values()) { assert.equal(list.length, 2, 'open or multiply connected edge'); assert.equal(list[0] + list[1], 0); }
  assert.ok(volume6 > 0); assert.ok([...p.array].every(Number.isFinite)); geometry.dispose(); return volume6 / 6;
}

test('every labelled ruler tick maps to its world millimetre without inset scaling', () => {
  for (let mm = -900; mm <= 900; mm += 10) {
    const pixel = rulerTickPixel(mm), uv = pixel / M.rulerPixels;
    near((uv - .5) * M.rulerLengthM, mm / 1000);
    near(rulerUvToWorld(rulerWorldToUv(mm / 1000)), mm / 1000);
    assert.ok(pixel > 0 && pixel < M.rulerPixels);
  }
  near(rulerTickPixel(0), M.rulerPixels / 2);
  near(rulerUvToWorld(1) - rulerUvToWorld(0), 1.84);
  // Guard the original 64-pixel margin/1800 mm stretch regression.
  assert.ok(Math.abs((64 / 8192 - .5) * 1.84 + .9) > .005);
});

test('glass pole fans, matched seats, finished rings and knurl surfaces have outward closed topology', () => {
  closedOutward(glassGeometry());
  near(closedOutward(seatGeometry(-1)), closedOutward(seatGeometry(1)), 1e-15);
  closedOutward(finishedRingGeometry(.013, .022, .006));
  closedOutward(knurledRingGeometry(.003, .008, .009));
});

test('glass silhouette retains the original diameter, center thickness and edge thickness', () => {
  const profile = glassProfile();
  near(Math.max(...profile.map(p => p.r)), G.lensRadius);
  near(Math.max(...profile.map(p => p.x)) - Math.min(...profile.map(p => p.x)), G.lensCenterThickness);
  near(glassHalfThicknessM(G.lensRadius) * 2, G.lensEdgeThickness);
  for (const p of profile) near(Math.abs(p.x), glassHalfThicknessM(p.r));
});

test('retainers contact the same finite glass meridian samples and leave the maximum optical pupil free', () => {
  const glass = glassProfile(), seats = [-1, 1].map(seatProfile);
  for (const [index, seat] of seats.entries()) {
    const side = index ? 1 : -1;
    assert.ok(Math.min(...seat.map(p => p.r)) > G.apertureDiameterMm[1] / 2000 + .002);
    near(Math.max(...seat.map(p => p.r)), M.barrelBoreRadiusM);
    for (const p of seat) if (p.r <= G.lensRadius && Math.abs(p.x) >= G.lensEdgeThickness / 2) {
      assert.ok(side * p.x >= glassHalfThicknessM(p.r) - 1e-15, 'retainer intrudes into glass');
    }
    const contact = seat.filter(p => Math.abs(Math.abs(p.x) - glassHalfThicknessM(p.r)) < 1e-12);
    assert.equal(contact.length, 5);
    for (const p of contact) assert.ok(glass.some(g => Math.abs(g.x - p.x) < 1e-14 && Math.abs(g.r - p.r) < 1e-14));
  }
  // Front retainer ends before the closest face of the physical iris.
  assert.ok(-M.seatBackXM - (M.irisPlaneXM + M.irisThicknessM / 2) >= .0002 - 1e-15);
});

test('rail support spans the original gap and sliding shoes clear guide tracks through the full travel', () => {
  near(M.railBottomY - M.baseTopY, .00075);
  near(M.carriageRoofBottomY - M.railGuideTopY, .0003);
  near(M.shoeBottomY, G.railTopY); assert.ok(M.shoeTopY > M.shoeBottomY);
  assert.ok(M.shoeCenterZM - M.shoeWidthM / 2 > .019 + .005 / 2);
  assert.ok(M.shoeCenterZM + M.shoeWidthM / 2 < G.railWidth / 2);
  for (let mm = 100; mm <= 900; mm++) for (const sign of [-1, 1]) {
    const x = sign * mm / 1000; assert.ok(x - .026 >= G.railX[0] && x + .026 <= G.railX[1]);
  }
  near(M.screenBackingThicknessM, .003 - .002 / 2);
});

test('drawing-only ray clipping removes precisely the internal slab and preserves all model vertices', () => {
  const planes = rayDisplayClipPlanes(), clipped = p => planes.every(plane => plane.distanceToPoint(new THREE.Vector3(...p)) < 0);
  for (const x of [-.004099, -.003, 0, .003, .004099]) assert.ok(clipped([x, G.axisY, 0]));
  for (const x of [-.9, -.004101, .004101, .9]) assert.equal(clipped([x, G.axisY, 0]), false);
  const ray = traceRay({ focalLengthMm: 150, objectDistanceMm: 100, screenDistanceMm: 300, apertureDiameterMm: 6 },
    { horizontalMm: 3.25, verticalMm: 2.25 }, { horizontalMm: 2.4, verticalMm: 1.8 });
  const before = structuredClone(ray), t = (-3 - ray.object.xMm) / (ray.pupil.xMm - ray.object.xMm);
  const y = ray.object.yMm + t * (ray.pupil.yMm - ray.object.yMm), z = ray.object.zMm + t * (ray.pupil.zMm - ray.object.zMm);
  assert.ok(Math.hypot(y, z) > 3, 'regression fixture must cross symbolic offset iris rim');
  assert.ok(clipped([-.003, G.axisY + y / 1000, z / 1000])); assert.deepEqual(ray, before);
  near(Math.hypot(ray.pupil.yMm, ray.pupil.zMm), 3); near(ray.pupil.xMm, 0);
});

test('aperture adjustment indication is finite, reversible and monotone without redefining the pupil', () => {
  let previous = -Infinity;
  for (let diameter = 6; diameter <= 18; diameter += .1) { const angle = apertureControlAngle(diameter); assert.ok(angle > previous); previous = angle; }
  near(apertureControlAngle(12), 0); near(apertureControlAngle(6), -apertureControlAngle(18));
  const geometry = knurledRingGeometry(.003, .008, .009), p = geometry.attributes.position;
  for (let i = 0; i < p.count; i++) { assert.ok(Math.abs(p.getX(i)) <= .0045 + 1e-9); assert.ok(Math.hypot(p.getY(i), p.getZ(i)) <= .008 + 1e-9); }
  geometry.dispose();
});

test('the 48 mm screen backing meets the rear frame without a duplicate front raster face', () => {
  const geometry = screenBackingGeometry(), b = geometry.boundingBox, p = geometry.attributes.position;
  near(b.min.x, 0, 1e-9); near(b.max.x, .002, 1e-9); near(b.max.y - b.min.y, .048, 1e-9); near(b.max.z - b.min.z, .048, 1e-9);
  assert.equal(geometry.index.count, 30);
  for (let i = 0; i < geometry.index.count; i += 3) {
    const vertices = [0, 1, 2].map(j => new THREE.Vector3().fromBufferAttribute(p, geometry.index.getX(i + j)));
    const normal = vertices[1].sub(vertices[0]).cross(vertices[2].sub(vertices[0])).normalize();
    assert.ok(normal.x > -.5, 'opaque face would z-fight with the optical raster');
  }
  geometry.dispose();
});
