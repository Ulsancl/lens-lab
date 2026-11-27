import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_CONFIG, normalizeConfig, solveOptics, targetGeometry, traceRay } from '../src/physics.js';
import { makeProjection, makeTarget } from '../src/projection.js';
import { createProject, parseProject, serializeProject } from '../src/project.js';

const point = (horizontalMm, verticalMm) => ({ horizontalMm, verticalMm });
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const focused = { ...DEFAULT_CONFIG, screenDistanceMm: 300 };

function horizontalMoment(raster) {
  const pitch = raster.physicalWidthMm / raster.width;
  let sum = 0, weightedX = 0;
  for (let index = 0; index < raster.linear.length; index++) {
    const intensity = raster.linear[index];
    const x = (index % raster.width + .5) * pitch - raster.physicalWidthMm / 2;
    sum += intensity;
    weightedX += intensity * x;
  }
  return { areaIntegral: sum * pitch ** 2, x: weightedX / sum };
}

test('resizing the target scales image area and the physical reference without changing focus', () => {
  const size = 18, config = { ...focused, targetSizeMm: size };
  const original = solveOptics(focused), enlarged = solveOptics(config);
  assert.deepEqual(enlarged.image, original.image);
  assert.deepEqual(enlarged.screen, original.screen);
  assert.deepEqual(enlarged.light, original.light);
  const base = horizontalMoment(makeProjection(original));
  const after = horizontalMoment(makeProjection(enlarged));
  near(after.areaIntegral / base.areaIntegral, (size / 12) ** 2, .006);
  near(after.x / base.x, size / 12, .02);
  const target = makeTarget({ targetSizeMm: size });
  assert.equal(target.physicalWidthMm, size);
  assert.equal(target.physicalHeightMm, size);
  assert.deepEqual(target.rgba, makeTarget().rgba);
  assert.throws(() => makeTarget({ targetSizeMm: 5 }), RangeError);
});

test('physical target coordinates translate the screen bundle in sharp and blurred cases', () => {
  for (const screenDistanceMm of [300, 360]) {
    const config = { ...focused, screenDistanceMm, targetSizeMm: 9, targetOffsetMm: 5 };
    const center = traceRay(config, point(5, 0), point(0, 0));
    assert.equal(center.object.zMm, 5);
    near(center.screen.zMm, -5 * screenDistanceMm / 300, 1e-12);
    assert.equal(traceRay(config, point(9.5, -4.5), point(0, 0)).object.yMm, -4.5);
    assert.throws(() => traceRay(config, point(.49, 0), point(0, 0)), RangeError);
    assert.throws(() => traceRay(config, point(5, 4.51), point(0, 0)), RangeError);
    const offset = horizontalMoment(makeProjection(solveOptics(config)));
    const base = horizontalMoment(makeProjection(solveOptics({ ...config, targetOffsetMm: 0 })));
    near(offset.x - base.x, center.screen.zMm, .003);
    near(offset.areaIntegral, base.areaIntegral, .003);
  }
});

test('a virtual image uses diverging forward rays and off-screen light stays clipped', () => {
  const config = { ...DEFAULT_CONFIG, objectDistanceMm: 100, screenDistanceMm: 900,
    apertureDiameterMm: 6, targetSizeMm: 6, targetOffsetMm: 8 };
  const solution = solveOptics(config);
  assert.deepEqual(solution.image, { kind: 'virtual', distanceMm: -300, magnification: 3, onBench: true });
  const center = traceRay(config, point(8, 0), point(0, 0));
  near(center.screen.zMm, -72, 1e-12);
  near(center.pupil.zMm + solution.image.distanceMm * center.outgoingSlope.zPerX, 24, 1e-12);
  const raster = makeProjection(solution, { size: 64 });
  assert.ok(raster.linear.every(value => value === 0));
  assert.ok(makeProjection(solveOptics({ ...config, targetOffsetMm: 0 }), { size: 64 }).linear.some(value => value > 0));
});

test('four-field legacy projects resolve the original target and new target states roundtrip exactly', () => {
  const legacy = createProject({ config: focused, comparison: { label: '기준', config: DEFAULT_CONFIG } });
  const legacyText = serializeProject(legacy);
  assert.deepEqual(parseProject(`\ufeff${legacyText}`), legacy);
  assert.equal(serializeProject(parseProject(legacyText)), legacyText);
  assert.deepEqual(targetGeometry(legacy.config), { sizeMm: 12, horizontalOffsetMm: 0, scale: 1 });
  assert.deepEqual(makeProjection(solveOptics(legacy.config), { size: 64 }),
    makeProjection(solveOptics({ ...legacy.config, targetSizeMm: 12, targetOffsetMm: 0 }), { size: 64 }));

  const config = { ...focused, targetSizeMm: 17.375, targetOffsetMm: -3.125 };
  const comparison = { label: '옮긴 표적', config: { ...DEFAULT_CONFIG, targetOffsetMm: 8 } };
  const saved = createProject({ config, comparison });
  assert.deepEqual(parseProject(serializeProject(saved)), saved);
  assert.deepEqual(normalizeConfig({ ...config, targetSizeMm: 12, targetOffsetMm: 0 }), focused);
  assert.deepEqual(normalizeConfig({ ...config, targetSizeMm: 19, targetOffsetMm: -10 }),
    { ...focused, targetSizeMm: 18, targetOffsetMm: -8 });
  for (const fields of [{ targetSizeMm: 5 }, { targetSizeMm: '12' }, { targetOffsetMm: 8.01 }, { targetOffsetMm: null }, { targetRotation: 1 }]) {
    for (const invalid of [{ ...saved, config: { ...config, ...fields } },
      { ...saved, comparison: { ...comparison, config: { ...comparison.config, ...fields } } }]) {
      assert.throws(() => parseProject(JSON.stringify(invalid)), error => error.code === 'INVALID_CONFIG' && error.preserveOriginal);
    }
  }
});
