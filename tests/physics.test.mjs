import test from 'node:test';
import assert from 'node:assert/strict';
import { MODEL_VERSION, DEFAULT_CONFIG, CONFIG_BOUNDS, normalizeConfig, assertConfig, solveOptics, traceRay } from '../src/physics.js';

const config = patch => ({ ...DEFAULT_CONFIG, ...patch });
const near = (actual, expected, tolerance = 1e-11) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const point = (horizontalMm, verticalMm) => ({ horizontalMm, verticalMm });
const finiteTree = value => typeof value === 'number' ? Number.isFinite(value) : value === null || typeof value !== 'object' || Object.values(value).every(finiteTree);

test('public SI-free mm config contract is fixed and immutable', () => {
  assert.equal(MODEL_VERSION, 'thin-lens-paraxial-1');
  assert.deepEqual(DEFAULT_CONFIG, { focalLengthMm: 150, objectDistanceMm: 300, screenDistanceMm: 360, apertureDiameterMm: 18 });
  assert.deepEqual(CONFIG_BOUNDS.focalLengthMm.values, [150, 225, 300]);
  assert.ok(Object.isFrozen(DEFAULT_CONFIG) && Object.isFrozen(CONFIG_BOUNDS.focalLengthMm.values));
});

test('normalization is for live controls; strict imported configs reject malformed and unsupported values', () => {
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig({ focalLengthMm: 200, objectDistanceMm: 0, screenDistanceMm: Infinity, apertureDiameterMm: 50 }), config({ focalLengthMm: 225, objectDistanceMm: 100, apertureDiameterMm: 18 }));
  assert.equal(normalizeConfig({ focalLengthMm: 187.5 }).focalLengthMm, 150);
  assert.equal(normalizeConfig({ objectDistanceMm: '450' }).objectDistanceMm, 300);
  for (const patch of [{ focalLengthMm: 200 }, { objectDistanceMm: 99 }, { screenDistanceMm: 901 },
    { apertureDiameterMm: 5.999 }, { objectDistanceMm: '300' }, { focalLengthMm: NaN }, { apertureDiameterMm: Infinity }, { extra: 1 }]) {
    const invalid = config(patch), original = structuredClone(invalid);
    assert.throws(() => assertConfig(invalid), error => error instanceof TypeError || error instanceof RangeError);
    assert.deepEqual(invalid, original);
  }
  const missing = config({}); delete missing.objectDistanceMm;
  for (const invalid of [missing, null, [], 150]) assert.throws(() => assertConfig(invalid), TypeError);
  const valid = Object.freeze(config({ objectDistanceMm: 225.125 })); assert.equal(assertConfig(valid), valid);
});

test('four independently known conjugates distinguish real, infinity and upright virtual images', () => {
  for (const [u, kind, distance, magnification] of [
    [300, 'real', 300, -1], [225, 'real', 450, -2], [150, 'infinity', null, null], [100, 'virtual', -300, 3],
  ]) {
    const solution = solveOptics(config({ objectDistanceMm: u }));
    assert.deepEqual(solution.image, { kind, distanceMm: distance, magnification, onBench: distance !== null });
  }
});

test('all three focal lengths satisfy reciprocal lens and magnification relations away from the singularity', () => {
  for (const f of [150, 225, 300]) for (const u of [100, 175, 400, 900]) {
    if (u === f) continue;
    const solution = solveOptics(config({ focalLengthMm: f, objectDistanceMm: u }));
    near(1 / f, 1 / u + 1 / solution.image.distanceMm);
    near(solution.image.magnification, -solution.image.distanceMm / u);
  }
});

test('near-focus images remain honestly off-bench while actual rays stay finite', () => {
  for (const f of [150, 225, 300]) {
    for (const delta of [-1e-10, 0, 1e-10]) {
      const c = config({ focalLengthMm: f, objectDistanceMm: f + delta, screenDistanceMm: 900 });
      const solution = solveOptics(c);
      assert.equal(solution.image.kind, delta < 0 ? 'virtual' : delta > 0 ? 'real' : 'infinity');
      assert.equal(solution.image.onBench, false); assert.ok(finiteTree(solution));
      const ray = traceRay(c, point(4, -3), point(6, 3)); assert.ok(finiteTree(ray));
      assert.ok(Math.abs(ray.screen.yMm) < 100 && Math.abs(ray.screen.zMm) < 100);
    }
  }
  assert.equal(solveOptics(config({ objectDistanceMm: 180 })).image.onBench, true);
  assert.equal(solveOptics(config({ objectDistanceMm: 179 })).image.onBench, false);
});

test('optical-center ray is undeviated and both transverse axes reverse at a real image', () => {
  const c = config({ screenDistanceMm: 300 });
  const ray = traceRay(c, point(2, 3), point(0, 0));
  assert.deepEqual(ray.object, { xMm: -300, yMm: 3, zMm: 2 });
  assert.deepEqual(ray.pupil, { xMm: 0, yMm: 0, zMm: 0 });
  near(ray.outgoingSlope.yPerX, -3 / 300); near(ray.outgoingSlope.zPerX, -2 / 300);
  assert.deepEqual(ray.screen, { xMm: 300, yMm: -3, zMm: -2 });
});

test('parallel incident rays pass the rear focal point and front-focal rays exit parallel', () => {
  const c = config({ screenDistanceMm: 150 });
  const parallel = traceRay(c, point(2, 3), point(2, 3));
  near(parallel.screen.yMm, 0); near(parallel.screen.zMm, 0);
  const collimated = traceRay(c, point(2, 3), point(-2, -3));
  near(collimated.outgoingSlope.yPerX, 0); near(collimated.outgoingSlope.zPerX, 0);
  near(collimated.screen.yMm, -3); near(collimated.screen.zMm, -2);
});

test('rays from a focal-plane object point have the same outgoing direction at every pupil point', () => {
  const c = config({ objectDistanceMm: 150 });
  const rays = [point(0, 0), point(9, 0), point(0, -9), point(-6, 6)].map(p => traceRay(c, point(2, 3), p));
  for (const ray of rays) { near(ray.outgoingSlope.yPerX, -.02); near(ray.outgoingSlope.zPerX, -2 / 150); }
  assert.notEqual(rays[0].screen.zMm, rays[1].screen.zMm);
});

test('virtual image is an intersection of backward extensions, never a sharp real-screen projection', () => {
  const c = config({ objectDistanceMm: 100, screenDistanceMm: 300 });
  const rays = [point(0, 0), point(9, 0), point(0, 9)].map(p => traceRay(c, point(1, 2), p));
  for (const ray of rays) {
    near(ray.pupil.yMm - 300 * ray.outgoingSlope.yPerX, 6);
    near(ray.pupil.zMm - 300 * ray.outgoingSlope.zPerX, 3);
  }
  assert.notEqual(rays[0].screen.zMm, rays[1].screen.zMm);
  assert.equal(solveOptics(c).screen.objectScale, -3);
  assert.equal(solveOptics(c).image.magnification, 3);
});

test('aperture circle maps to the predicted blur circle, centered on the independent principal ray', () => {
  for (const diameter of [6, 18]) {
    const c = config({ screenDistanceMm: 320, apertureDiameterMm: diameter });
    const solution = solveOptics(c), center = traceRay(c, point(2, -1), point(0, 0)).screen;
    near(solution.screen.blurRadiusMm, diameter === 18 ? .6 : .2);
    for (let index = 0; index < 24; index++) {
      const angle = index * Math.PI / 12;
      const ray = traceRay(c, point(2, -1), point(diameter / 2 * Math.cos(angle), diameter / 2 * Math.sin(angle)));
      near(Math.hypot(ray.screen.yMm - center.yMm, ray.screen.zMm - center.zMm), solution.screen.blurRadiusMm);
    }
  }
});

test('collected light scales with aperture area and inverse object distance, not focus classification', () => {
  const full = solveOptics(config({ screenDistanceMm: 320 }));
  const small = solveOptics(config({ screenDistanceMm: 320, apertureDiameterMm: 6 }));
  near(full.light.collectedRelative / small.light.collectedRelative, 9);
  near(full.screen.irradianceScale / small.screen.irradianceScale, 9);
  near(solveOptics(config({ objectDistanceMm: 600 })).light.collectedRelative, .25);
  assert.equal(solveOptics(config({ screenDistanceMm: 900 })).light.collectedRelative, full.light.collectedRelative);
  assert.deepEqual(small.image, full.image);
});

test('pupil/object limits reject invalid rays and all functions preserve frozen inputs', () => {
  const c = Object.freeze(config({})), o = Object.freeze(point(2, 3)), p = Object.freeze(point(0, 9));
  const ray = traceRay(c, o, p); assert.equal(ray.pupil.yMm, 9);
  const result = solveOptics(c); result.config.objectDistanceMm = 500; assert.equal(c.objectDistanceMm, 300);
  for (const pupil of [point(9.001, 0), point(7, 7), point(NaN, 0), { horizontalMm: 1 }]) assert.throws(() => traceRay(c, o, pupil));
  for (const object of [point(6.001, 0), point(0, Infinity), { ...o, extra: 1 }]) assert.throws(() => traceRay(c, object, p));
  assert.ok(Math.hypot(traceRay(c, o, point(9 + 1e-12, 0)).pupil.zMm, 0) <= 9);
  assert.deepEqual(c, DEFAULT_CONFIG); assert.deepEqual(o, point(2, 3)); assert.deepEqual(p, point(0, 9));
});
