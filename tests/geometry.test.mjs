import test from 'node:test';
import assert from 'node:assert/strict';
import { GEOMETRY, DEFAULT_VIEW, COMPONENTS, opticalPointToWorld, carriagePositions, rasterPlane, rasterPixelPoint } from '../src/geometry.js';

test('fourteen stable physical parts and observation defaults are immutable renderer-free data', () => {
  assert.equal(COMPONENTS.length, 14); assert.equal(new Set(COMPONENTS.map(p => p.id)).size, 14);
  for (const part of COMPONENTS) { assert.ok(Object.isFrozen(part)); assert.ok(part.name && part.description && part.material); }
  assert.deepEqual(Object.keys(DEFAULT_VIEW).sort(), ['focus', 'labels', 'rays', 'selectedPart', 'structure']);
  assert.ok(Object.isFrozen(DEFAULT_VIEW) && Object.isFrozen(GEOMETRY.railX));
});

test('millimetre optical coordinates preserve both transverse signs in the metre scene', () => {
  assert.deepEqual(opticalPointToWorld({ xMm: -300, yMm: 3, zMm: -4 }), [-.3, .133, -.004]);
  assert.deepEqual(opticalPointToWorld({ xMm: 300, yMm: -3, zMm: 4 }), [.3, .127, .004]);
  for (const invalid of [NaN, Infinity, -Infinity, undefined]) assert.throws(() => opticalPointToWorld({ xMm: invalid, yMm: 0, zMm: 0 }));
});

test('both carriages remain on actual rail ends over the full supported travel', () => {
  for (const objectDistanceMm of [100, 300, 900]) for (const screenDistanceMm of [100, 360, 900]) {
    const p = carriagePositions({ objectDistanceMm, screenDistanceMm });
    assert.equal(p.targetX, -objectDistanceMm / 1000); assert.equal(p.screenX, screenDistanceMm / 1000); assert.equal(p.lensX, 0);
    assert.ok(p.targetX - .026 >= GEOMETRY.railX[0]); assert.ok(p.screenX + .026 <= GEOMETRY.railX[1]);
    assert.ok(p.screenX > 0 && p.targetX < 0);
  }
  for (const value of [99.9, 900.1, NaN, Infinity]) assert.throws(() => carriagePositions({ objectDistanceMm: value, screenDistanceMm: 300 }));
});

test('source and screen UVs place first row at physical top and columns toward positive Z', () => {
  for (const facing of [-1, 1]) {
    const g = rasterPlane(.048, .048, facing);
    assert.deepEqual(g.positions.slice(0, 3), [0, .024, -.024]); assert.deepEqual(g.uv.slice(0, 2), [0, 0]);
    assert.deepEqual(g.positions.slice(6, 9), [0, -.024, .024]); assert.deepEqual(g.uv.slice(4, 6), [1, 1]);
    const [a, b, c] = g.indices.slice(0, 3).map(i => g.positions.slice(i * 3, i * 3 + 3));
    const normalX = (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]);
    assert.equal(Math.sign(normalX), facing);
  }
  const source = { width: 2, height: 2, physicalWidthMm: 12, physicalHeightMm: 12 };
  assert.deepEqual(rasterPixelPoint(source, 0, 0), { horizontalMm: -3, verticalMm: 3 });
  assert.deepEqual(rasterPixelPoint(source, 1, 1), { horizontalMm: 3, verticalMm: -3 });
  assert.throws(() => rasterPlane(NaN, .048)); assert.throws(() => rasterPixelPoint(source, 2, 0));
});

test('glass, adjustable clear aperture and holder have distinct physical radial extents', () => {
  assert.ok(GEOMETRY.apertureDiameterMm[1] / 2000 < GEOMETRY.lensRadius);
  assert.ok(GEOMETRY.lensRadius < GEOMETRY.lensRingRadius);
  assert.ok(GEOMETRY.lensEdgeThickness > 0 && GEOMETRY.lensEdgeThickness < GEOMETRY.lensCenterThickness);
  assert.equal(GEOMETRY.targetWidth * 1000, 12); assert.equal(GEOMETRY.screenWidth * 1000, 48);
});
