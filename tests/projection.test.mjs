import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { DEFAULT_CONFIG, solveOptics } from '../src/physics.js';
import { makeTarget, makeProjection } from '../src/projection.js';

const solution = patch => solveOptics({ ...DEFAULT_CONFIG, ...patch });
const near = (actual, expected, tolerance) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}, tolerance ${tolerance}`);
function moments(raster) {
  const pitch = raster.physicalWidthMm / raster.width;
  let sum = 0, x = 0, y = 0, xx = 0, yy = 0;
  for (let row = 0; row < raster.height; row++) for (let col = 0; col < raster.width; col++) {
    const weight = raster.linear[row * raster.width + col];
    const horizontal = (col + .5) * pitch - raster.physicalWidthMm / 2;
    const vertical = raster.physicalHeightMm / 2 - (row + .5) * pitch;
    sum += weight; x += weight * horizontal; y += weight * vertical; xx += weight * horizontal ** 2; yy += weight * vertical ** 2;
  }
  return { flux: sum * pitch ** 2, x: x / sum, y: y / sum, varX: xx / sum - (x / sum) ** 2, varY: yy / sum - (y / sum) ** 2 };
}
function indexAt(raster, horizontal, vertical) {
  return Math.floor((raster.physicalHeightMm / 2 - vertical) / raster.physicalHeightMm * raster.height) * raster.width +
    Math.floor((horizontal + raster.physicalWidthMm / 2) / raster.physicalWidthMm * raster.width);
}
const mask = (x, y) => (x >= -.75 && x <= .75 && y >= -4 && y <= .5) ||
  (y >= .5 && y <= 4.5 && x >= -(4.5 - y) * 9 / 16 && x <= (4.5 - y) * 9 / 16) ||
  (x >= 2.5 && x <= 4 && y >= 1.5 && y <= 3);

test('original arrow and offset-square area/centroid match independently summed shapes', () => {
  const target = makeTarget(), result = moments(target);
  assert.equal(target.width, 192); assert.equal(target.physicalWidthMm, 12);
  // Rectangle 6.75 mm² + triangle 9 mm² + registration square 2.25 mm².
  near(result.flux, 18, .004);
  near(result.x, 2.25 * 3.25 / 18, .002);
  near(result.y, (6.75 * -1.75 + 9 * (11 / 6) + 2.25 * 2.25) / 18, .002);
  assert.equal(target.linear[indexAt(target, 3.25, 2.25)], 1);
  assert.equal(target.linear[indexAt(target, -3.25, -2.25)], 0);
});

test('real-image focus reverses both texture axes and has unit size without inventing a rotation', () => {
  const raster = makeProjection(solution({ screenDistanceMm: 300 })), result = moments(raster);
  assert.equal(raster.physicalWidthMm, 48); assert.equal(raster.physicalHeightMm, 48);
  near(result.flux, 18, .01); near(result.x, -.40625, .01); near(result.y, -13 / 24, .01);
  assert.equal(raster.linear[indexAt(raster, -3.25, -2.25)], 1);
  assert.equal(raster.linear[indexAt(raster, 3.25, 2.25)], 0);
  assert.ok(raster.linear.some(value => value > 0 && value < 1), 'sharp mask still has pixel antialiasing');
});

test('magnified focus has predicted centroid/size and independently conserved collected flux', () => {
  const raster = makeProjection(solution({ objectDistanceMm: 225, screenDistanceMm: 450 })), m = moments(raster);
  near(m.flux, 32, .02); near(m.x, -.8125, .008); near(m.y, -13 / 12, .008);
  // Independent uniform-shape second moments, scaled by magnification squared.
  near(m.varX, 4 * (1.8359375 - .40625 ** 2), .02);
  near(m.varY, 4 * (4.5625 - (13 / 24) ** 2), .02);
});

test('aperture reduction has nine times less linear flux and stays visibly dimmer under one exposure', () => {
  const full = makeProjection(solution({ screenDistanceMm: 300 }));
  const small = makeProjection(solution({ screenDistanceMm: 300, apertureDiameterMm: 6 }));
  near(moments(full).flux / moments(small).flux, 9, 1e-6);
  const i = indexAt(full, 0, 2);
  near(full.linear[i] / small.linear[i], 9, 1e-6);
  assert.ok(full.rgba[i * 4] > small.rgba[i * 4] + 80);
  assert.ok(small.rgba[i * 4] > 0);
  for (let k = 0; k < full.linear.length; k++) near(full.linear[k] / 9, small.linear[k], 5e-9);
});

test('defocus blur independently adds disk variance and conserves nine-to-one flux', () => {
  const fullSolution = solution({ screenDistanceMm: 320 }), smallSolution = solution({ screenDistanceMm: 320, apertureDiameterMm: 6 });
  const full = moments(makeProjection(fullSolution)), small = moments(makeProjection(smallSolution));
  near(full.flux, 18, .005); near(small.flux, 2, .002); near(full.flux / small.flux, 9, .005);
  near(full.x, -(320 / 300) * .40625, .003); near(full.y, -(320 / 300) * 13 / 24, .003);
  // For a uniform circle of radius r, each independent-axis variance is r²/4.
  near(full.varX - small.varX, (.6 ** 2 - .2 ** 2) / 4, .004);
  near(full.varY - small.varY, (.6 ** 2 - .2 ** 2) / 4, .004);
});

test('infinity and virtual images still project only the finite real ray distribution', () => {
  const infinite = solution({ objectDistanceMm: 150, screenDistanceMm: 300 });
  const virtual = solution({ objectDistanceMm: 100, screenDistanceMm: 100 });
  const a = moments(makeProjection(infinite)), b = moments(makeProjection(virtual));
  assert.equal(infinite.image.distanceMm, null); assert.equal(virtual.image.magnification, 3);
  near(a.flux, 72, .02); near(a.x, -.8125, .003); near(a.y, -13 / 12, .003);
  near(b.flux, 162, .025); near(b.x, -.40625, .003); near(b.y, -13 / 24, .003);
  near(b.varX, 1.8359375 - .40625 ** 2 + 12 ** 2 / 4, .02);
  assert.ok(b.varX > 20, 'virtual image was not pasted sharply onto the real screen');
});

test('crossing object focus changes image classification without a discontinuity or nonfinite raster', () => {
  const rasters = [-1e-9, 0, 1e-9].map(delta => makeProjection(solution({ objectDistanceMm: 150 + delta })));
  for (const raster of rasters) assert.ok(raster.linear.every(Number.isFinite));
  for (let index = 0; index < rasters[0].linear.length; index++) {
    near(rasters[0].linear[index], rasters[1].linear[index], 1e-6);
    near(rasters[2].linear[index], rasters[1].linear[index], 1e-6);
  }
});

test('analytic disk clipping agrees with an independent area-uniform pupil quadrature at partial edges', () => {
  const c = { ...DEFAULT_CONFIG, screenDistanceMm: 320 }, optics = solveOptics(c), raster = makeProjection(optics);
  const radialCount = 100, angleCount = 256, pupil = [];
  for (let radial = 0; radial < radialCount; radial++) for (let angle = 0; angle < angleCount; angle++) {
    const r = c.apertureDiameterMm / 2 * Math.sqrt((radial + .5) / radialCount), phi = (angle + .5) / angleCount * 2 * Math.PI;
    pupil.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  for (const [horizontal, vertical] of [[.875, 2.125], [-2.125, -1.125], [-3.125, -1.375], [0, -4.625]]) {
    const index = indexAt(raster, horizontal, vertical), row = Math.floor(index / raster.width), col = index % raster.width;
    let sum = 0;
    for (const dy of [.25, .75]) for (const dx of [.25, .75]) {
      const x = (col + dx) * .25 - 24, y = 24 - (row + dy) * .25;
      for (const [aX, aY] of pupil) {
        // Solve the two straight-line segments backward for the emitting point.
        const objectX = ((1 + 320 / 300 - 320 / 150) * aX - x) * 300 / 320;
        const objectY = ((1 + 320 / 300 - 320 / 150) * aY - y) * 300 / 320;
        if (mask(objectX, objectY)) sum++;
      }
    }
    const expected = (300 / 320) ** 2 * sum / (4 * pupil.length);
    near(raster.linear[index], expected, .0012);
  }
});

test('screen clipping loses flux according to independently forward-traced source/pupil rays', () => {
  const c = { focalLengthMm: 300, objectDistanceMm: 100, screenDistanceMm: 900, apertureDiameterMm: 18 };
  const raster = makeProjection(solveOptics(c)), pupil = [];
  for (let radius = 0; radius < 12; radius++) for (let angle = 0; angle < 64; angle++) {
    const r = 9 * Math.sqrt((radius + .5) / 12), phi = (angle + .5) * 2 * Math.PI / 64;
    pupil.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  let hits = 0, rays = 0;
  for (let row = 0; row < 144; row++) for (let col = 0; col < 144; col++) {
    const x = (col + .5) / 12 - 6, y = 6 - (row + .5) / 12;
    if (!mask(x, y)) continue;
    for (const [ax, ay] of pupil) {
      const sx = ax + 900 * ((ax - x) / 100 - ax / 300);
      const sy = ay + 900 * ((ay - y) / 100 - ay / 300);
      if (Math.abs(sx) <= 24 && Math.abs(sy) <= 24) hits++;
      rays++;
    }
  }
  const expectedCapturedFlux = 18 * 9 * hits / rays, actualFlux = moments(raster).flux;
  near(actualFlux, expectedCapturedFlux, .4);
  assert.ok(actualFlux < 18 * 9 * .25, 'clipped photons were incorrectly renormalized back onto the screen');
});

test('determinism, independent buffers and finite fixed-tone ranges hold without DOM or Three', () => {
  const optics = solution({ screenDistanceMm: 300 });
  const before = structuredClone(optics), a = makeProjection(optics, { size: 64 }), b = makeProjection(optics, { size: 64 });
  assert.deepEqual(a, b); assert.deepEqual(optics, before);
  assert.ok(a.linear instanceof Float32Array && a.rgba instanceof Uint8ClampedArray);
  assert.ok(a.linear.every(value => Number.isFinite(value) && value >= 0));
  assert.ok(a.rgba.every((value, index) => index % 4 !== 3 || value === 255));
  a.linear[0] = 123; a.rgba[0] = 123; assert.notEqual(b.linear[0], 123); assert.notEqual(b.rgba[0], 123);
  for (const size of [0, 15, 513, 64.5, NaN, Infinity]) assert.throws(() => makeTarget({ size }), RangeError);
  const forged = structuredClone(optics); forged.screen.blurRadiusMm = 0.1;
  assert.throws(() => makeProjection(forged), RangeError);
});

test('192-pixel CPU timing samples cover sharp, defocused, infinite and virtual configurations', t => {
  const records = [];
  for (const [name, patch] of [['sharp', { screenDistanceMm: 300 }], ['defocus', { screenDistanceMm: 320 }],
    ['infinity', { objectDistanceMm: 150 }], ['virtual', { objectDistanceMm: 100 }]]) {
    const start = performance.now(), raster = makeProjection(solution(patch));
    const elapsedMs = performance.now() - start;
    records.push({ name, elapsedMs: Number(elapsedMs.toFixed(3)) });
    assert.equal(raster.width, 192); assert.ok(raster.linear.some(value => value > 0));
  }
  t.diagnostic(`CPU timing observations, not a cross-machine performance guarantee: ${JSON.stringify(records)}`);
});
