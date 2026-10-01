import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, solveOptics, traceRay } from '../src/physics.js';
import { makeProjection, makeTarget } from '../src/projection.js';
import { COMPONENTS, GEOMETRY } from '../src/geometry.js';
import { lensDetail } from '../src/detail-model.js';
import { describeLensDetail } from '../src/detail-readouts.js';

const config = patch => ({ ...DEFAULT_CONFIG, ...patch });
const near = (actual, expected, tolerance = 1e-10) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected)
  && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}, tolerance ${tolerance}`);
const point = (horizontalMm, verticalMm) => ({ horizontalMm, verticalMm });
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
const finiteTree = value => typeof value === 'number' ? Number.isFinite(value) : value === null || typeof value !== 'object' || Object.values(value).every(finiteTree);
const flux = raster => raster.linear.reduce((sum, value) => sum + value, 0) * raster.physicalWidthMm * raster.physicalHeightMm / (raster.width * raster.height);

test('known conjugate exposes signed screen mapping, aperture area and a screen-position interval', () => {
  const d = lensDetail(config({}));
  near(d.aperture.areaMm2, 81 * Math.PI); near(d.aperture.fNumber, 25 / 3);
  assert.equal(d.bundle.kind, 'converging'); near(d.bundle.vergencePerMm, 1 / 300);
  assert.equal(d.image.distanceMm, 300); assert.equal(d.image.magnification, -1); assert.equal(d.image.realFocusOnRail, true);
  near(d.screen.centerScale, -1.2); near(d.screen.pupilScale, -.2); near(d.screen.blurRadiusMm, 1.8); near(d.screen.blurDiameterMm, 3.6);
  near(d.focusTolerance.forwardRangeMm.minMm, 890 / 3); near(d.focusTolerance.forwardRangeMm.maxMm, 910 / 3);
  near(d.focusTolerance.railWidthMm, 20 / 3); assert.equal(d.focusTolerance.containsScreen, false);
  assert.deepEqual(d.focusTolerance.forwardRangeMm, d.focusTolerance.railRangeMm);
});

test('independent principal and edge rays reconstruct signed C, B, convergence and blur across all focal lengths', () => {
  for (const f of [150, 225, 300]) for (const u of [100, 175, 450, 900]) for (const s of [100, 321.25, 900]) for (const diameter of [6, 18]) {
    const c = config({ focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: diameter }), d = lensDetail(c);
    const object = point(2, -3), center = traceRay(c, object, point(0, 0));
    near(center.screen.zMm / object.horizontalMm, d.screen.centerScale);
    near(center.screen.yMm / object.verticalMm, d.screen.centerScale);
    for (let index = 0; index < 12; index++) {
      const angle = index * Math.PI / 6, pupil = point(diameter / 2 * Math.cos(angle), diameter / 2 * Math.sin(angle));
      const ray = traceRay(c, object, pupil);
      near(ray.screen.zMm - center.screen.zMm, d.screen.pupilScale * pupil.horizontalMm);
      near(ray.screen.yMm - center.screen.yMm, d.screen.pupilScale * pupil.verticalMm);
      near(Math.hypot(ray.screen.zMm - center.screen.zMm, ray.screen.yMm - center.screen.yMm), d.screen.blurRadiusMm);
      near(ray.outgoingSlope.zPerX - center.outgoingSlope.zPerX, -d.bundle.vergencePerMm * pupil.horizontalMm);
    }
    assert.equal(d.bundle.kind, u > f ? 'converging' : u === f ? 'parallel' : 'diverging');
  }
});

test('tolerance endpoints satisfy independent ray separation, with inside and outside distinguished', () => {
  for (const f of [150, 225, 300]) for (const u of [f + .125, f * 1.2, f * 2, 900]) for (const diameter of [6, 13.25, 18]) {
    const c = config({ focalLengthMm: f, objectDistanceMm: u, apertureDiameterMm: diameter }), d = lensDetail(c);
    const ray = traceRay(c, point(0, 0), point(0, diameter / 2));
    const radiusAt = s => Math.abs(ray.pupil.yMm + s * ray.outgoingSlope.yPerX);
    const { minMm, maxMm } = d.focusTolerance.forwardRangeMm;
    near(radiusAt(minMm), .1, 1e-10); near(radiusAt(maxMm), .1, 1e-10);
    assert.ok(radiusAt((minMm + maxMm) / 2) < 1e-10);
    assert.ok(radiusAt(minMm - (maxMm - minMm) / 100) > .1);
    assert.ok(radiusAt(maxMm + (maxMm - minMm) / 100) > .1);
    if (d.focusTolerance.railRangeMm) {
      for (const boundary of Object.values(d.focusTolerance.railRangeMm)) {
        assert.equal(lensDetail({ ...c, screenDistanceMm: boundary }).focusTolerance.containsScreen, true);
      }
    }
  }
});

test('parallel bundles have finite separated screen footprints, while different target points have different directions', () => {
  for (const f of [150, 225, 300]) for (const s of [100, 900]) for (const diameter of [6, 18]) {
    const c = config({ focalLengthMm: f, objectDistanceMm: f, screenDistanceMm: s, apertureDiameterMm: diameter }), d = lensDetail(c);
    assert.equal(d.bundle.kind, 'parallel'); assert.equal(d.bundle.vergencePerMm, 0);
    assert.equal(d.image.distanceMm, null); assert.equal(d.image.magnification, null); assert.equal(d.image.realFocusOnRail, false);
    near(d.screen.blurRadiusMm, diameter / 2); near(d.screen.pupilScale, 1);
    assert.equal(d.focusTolerance.forwardRangeMm, null); assert.equal(d.focusTolerance.railRangeMm, null); assert.equal(d.focusTolerance.containsScreen, false);
    const center = traceRay(c, point(1, 2), point(0, 0)), edge = traceRay(c, point(1, 2), point(0, diameter / 2));
    near(center.outgoingSlope.yPerX, edge.outgoingSlope.yPerX);
    assert.notEqual(center.outgoingSlope.yPerX, traceRay(c, point(1, -2), point(0, 0)).outgoingSlope.yPerX);
  }
});

test('virtual onBench is not a reachable real focus, and screen center inversion is not virtual-image magnification', () => {
  const d = lensDetail(config({ objectDistanceMm: 100, screenDistanceMm: 300 }));
  assert.equal(d.image.onBench, true); assert.equal(d.image.realFocusOnRail, false);
  assert.equal(d.bundle.kind, 'diverging'); assert.equal(d.image.distanceMm, -300); assert.equal(d.image.magnification, 3);
  assert.equal(d.screen.centerScale, -3); assert.ok(d.screen.pupilScale > 1);
  assert.equal(d.focusTolerance.forwardRangeMm, null); assert.equal(d.focusTolerance.railRangeMm, null); assert.equal(d.focusTolerance.railWidthMm, 0);
  assert.ok(describeLensDetail('lens-glass', config({ objectDistanceMm: 150 })).facts.some(row => row.value === '무한대'));
});

test('rail intersection preserves off-rail conjugates and accepts a tolerance interval even when its exact focus lies beyond the rail', () => {
  const nearby = lensDetail(config({ objectDistanceMm: 179.9, screenDistanceMm: 900 }));
  assert.ok(nearby.image.distanceMm > 900); assert.equal(nearby.image.realFocusOnRail, false);
  assert.ok(nearby.focusTolerance.forwardRangeMm.maxMm > 900);
  assert.equal(nearby.focusTolerance.railRangeMm.maxMm, 900); assert.ok(nearby.focusTolerance.railRangeMm.minMm < 900);
  assert.equal(nearby.focusTolerance.containsScreen, true);
  const far = lensDetail(config({ objectDistanceMm: 175, screenDistanceMm: 900 }));
  assert.equal(far.image.distanceMm, 1050); assert.ok(far.focusTolerance.forwardRangeMm.minMm > 900);
  assert.equal(far.focusTolerance.railRangeMm, null); assert.equal(far.focusTolerance.containsScreen, false);
  const boundary = lensDetail(config({ objectDistanceMm: 180, screenDistanceMm: 900 }));
  assert.equal(boundary.image.distanceMm, 900); assert.equal(boundary.image.realFocusOnRail, true); assert.equal(boundary.focusTolerance.railRangeMm.maxMm, 900);
});

test('zero and deliberately large radius criteria obey the complete forward-half-axis inequality', () => {
  const sharp = lensDetail(config({ screenDistanceMm: 300 }), undefined, { blurRadiusLimitMm: 0 });
  assert.equal(sharp.focusTolerance.railWidthMm, 0); assert.equal(sharp.focusTolerance.containsScreen, true);
  near(sharp.focusTolerance.railRangeMm.minMm, 300); near(sharp.focusTolerance.railRangeMm.maxMm, 300);
  const parallel = lensDetail(config({ objectDistanceMm: 150 }), undefined, { blurRadiusLimitMm: 9 });
  assert.deepEqual(parallel.focusTolerance.forwardRangeMm, { minMm: 0, maxMm: null });
  assert.deepEqual(parallel.focusTolerance.railRangeMm, { minMm: 100, maxMm: 900 });
  assert.equal(parallel.focusTolerance.containsScreen, true);
  const virtual = lensDetail(config({ objectDistanceMm: 100, screenDistanceMm: 300 }), undefined, { blurRadiusLimitMm: 18 });
  near(virtual.focusTolerance.forwardRangeMm.maxMm, 300); assert.deepEqual(virtual.focusTolerance.railRangeMm, { minMm: 100, maxMm: 300 });
  assert.equal(virtual.focusTolerance.containsScreen, true);
  const lowerClipped = lensDetail(config({ objectDistanceMm: 900, apertureDiameterMm: 6 }), undefined, { blurRadiusLimitMm: 2 });
  near(lowerClipped.focusTolerance.forwardRangeMm.minMm, 60); assert.equal(lowerClipped.focusTolerance.railRangeMm.minMm, 100);
  assert.ok(finiteTree(lensDetail(config({}), undefined, { blurRadiusLimitMm: Number.MAX_VALUE })));
});

test('area, linear light and screen-position tolerance scale differently when aperture changes', () => {
  const full = lensDetail(config({})), small = lensDetail(config({ apertureDiameterMm: 6 }));
  near(full.aperture.areaMm2 / small.aperture.areaMm2, 9);
  near(small.aperture.fNumber / full.aperture.fNumber, 3);
  near(full.light.collectedRelative / small.light.collectedRelative, 9);
  near(full.light.irradianceScale / small.light.irradianceScale, 9);
  near(full.screen.blurRadiusMm / small.screen.blurRadiusMm, 3);
  near(small.focusTolerance.railWidthMm / full.focusTolerance.railWidthMm, 3);
  assert.deepEqual(full.image, small.image); assert.deepEqual(full.bundle, small.bundle);
  near(small.focusTolerance.railRangeMm.minMm, 290); near(small.focusTolerance.railRangeMm.maxMm, 310);
});

test('linear raster integrals support the reported light factors; finite-screen cropping never invents restored flux', () => {
  const targetArea = flux(makeTarget()); near(targetArea, 18, .004);
  for (const patch of [{ screenDistanceMm: 300 }, { screenDistanceMm: 300, apertureDiameterMm: 6 },
    { objectDistanceMm: 225, screenDistanceMm: 450, apertureDiameterMm: 12 }]) {
    const c = config(patch), d = lensDetail(c), projected = makeProjection(solveOptics(c));
    near(flux(projected), 18 * d.light.collectedRelative, .025);
    near(d.screen.centerScale ** 2 * d.light.irradianceScale, d.light.collectedRelative);
  }
  const c = config({ objectDistanceMm: 100, screenDistanceMm: 900 }), d = lensDetail(c), clipped = makeProjection(solveOptics(c));
  assert.ok(flux(clipped) > 0); assert.ok(flux(clipped) < 18 * d.light.collectedRelative * .7);
  const farther = lensDetail(config({ screenDistanceMm: 720 })), baseline = lensDetail(config({}));
  near(farther.light.collectedRelative, baseline.light.collectedRelative); near(farther.light.irradianceScale / baseline.light.irradianceScale, .25);
});

test('one-ULP neighbors of the focal distance retain their sign and true finite off-rail image, without NaN or Infinity', () => {
  for (const f of [150, 225, 300]) for (const sign of [-1, 1]) {
    const c = config({ focalLengthMm: f, objectDistanceMm: f + sign * f * Number.EPSILON }), d = lensDetail(c);
    assert.ok(finiteTree(d)); assert.ok(sign * d.bundle.vergencePerMm > 0); assert.ok(sign * d.image.distanceMm > 1e15);
    assert.equal(d.image.realFocusOnRail, false); assert.equal(d.focusTolerance.railRangeMm, null); assert.equal(d.focusTolerance.containsScreen, false);
    if (sign > 0) assert.ok(d.focusTolerance.forwardRangeMm.minMm > 1e15);
    else assert.equal(d.focusTolerance.forwardRangeMm, null);
  }
});

test('all 14 components have compact, finite, dimensioned facts while frozen source data remain identical', () => {
  assert.equal(COMPONENTS.length, 14);
  for (const patch of [{}, { objectDistanceMm: 150 }, { objectDistanceMm: 100 }, { objectDistanceMm: 179.9, screenDistanceMm: 900 }]) {
    const c = freeze(config(patch)), solution = freeze(solveOptics(c)), before = structuredClone({ c, solution });
    for (const part of COMPONENTS) {
      const description = describeLensDetail(part.id, c, solution);
      assert.ok(description.facts.length >= 1 && description.facts.length <= 6); assert.ok(description.note.length > 20);
      assert.equal(new Set(description.facts.map(row => row.label)).size, description.facts.length);
      for (const row of description.facts) {
        assert.ok(row.label && typeof row.unit === 'string'); assert.ok(Number.isInteger(row.digits));
        assert.ok(typeof row.value === 'string' || Number.isFinite(row.value));
      }
    }
    assert.deepEqual({ c, solution }, before);
  }
  const lens = describeLensDetail('lens-ring', config({}));
  near(lens.facts.find(row => row.label === '표시 렌즈 지름').value, GEOMETRY.lensRadius * 2000);
  assert.deepEqual(describeLensDetail('missing', config({})).facts, []);
});

test('derived observations reject stale or malformed inputs and do not share mutable source or range objects', () => {
  const c = freeze(config({})), solution = freeze(solveOptics(c)), d = lensDetail(c, solution);
  d.image.distanceMm = 9; d.focusTolerance.forwardRangeMm.minMm = 10;
  assert.equal(solution.image.distanceMm, 300); near(d.focusTolerance.railRangeMm.minMm, 890 / 3);
  assert.equal(lensDetail(c, solution).image.distanceMm, 300);
  for (const invalid of [null, {}, { ...c, extra: 1 }, { ...c, objectDistanceMm: 99 }, { ...c, focalLengthMm: 200 }]) assert.throws(() => lensDetail(invalid));
  for (const invalid of [null, {}, { ...solution, extra: 1 }, { ...solution, modelVersion: 'other' },
    solveOptics(config({ screenDistanceMm: 300 })), { ...solution, screen: { ...solution.screen, blurRadiusMm: 0 } }]) assert.throws(() => lensDetail(c, invalid));
  for (const options of [null, [], { extra: 1 }, { blurRadiusLimitMm: -1 }, { blurRadiusLimitMm: null },
    { blurRadiusLimitMm: undefined }, { blurRadiusLimitMm: Infinity }, { blurRadiusLimitMm: '0.1' }]) assert.throws(() => lensDetail(c, solution, options));
  assert.deepEqual(c, DEFAULT_CONFIG); assert.deepEqual(solution, solveOptics(c));
});
