import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { makeProjection, makeTarget } from '../src/projection.js';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'output/consumer-scene');
const hardware = process.env.LENS_BROWSER_HARDWARE === '1';
const checks = [], errors = [], evidence = [];
let server, browser, page, gpu, failure;
const hash = data => { let h = 2166136261; for (const n of data) h = Math.imul(h ^ n, 16777619); return (h >>> 0).toString(16).padStart(8, '0'); };
const near = (a, b, tolerance = 3e-8) => assert.ok(Math.abs(a - b) <= tolerance, `${a} != ${b}`);
const debug = () => page.evaluate(() => window.lensLab.sceneDebug());
const state = () => page.evaluate(() => window.lensLab.getState());
const paint = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const check = async (name, fn) => { await fn(); checks.push(name); console.log(`PASS ${name}`); };
async function capture(name) {
  await paint(); await page.locator('#scene').screenshot({ path: path.join(output, `${name}.png`) });
  evidence.push({ name, debug: await debug() });
}
async function edit(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); await paint(); }
async function labelBounds({ association = false } = {}) {
  const { labels } = await debug(), rect = await page.locator('#scene').boundingBox();
  assert.ok(labels.length >= 3, 'core part labels remain visible');
  for (const label of labels) {
    const element = page.locator(`.lens-part-label[data-part-id="${label.id}"]`);
    const actual = await element.boundingBox(); assert.ok(actual);
    near(actual.x - rect.x, label.left, .1); near(actual.y - rect.y, label.top, .1);
    assert.ok(label.left >= 9 && label.left + label.width <= rect.width - 9, `${label.id} outside horizontal bounds`);
    assert.ok(label.top >= 53 && label.top + label.height <= rect.height - 70, `${label.id} overlaps reserved UI`);
    if (association) {
      const center = [label.left + label.width / 2, label.top + label.height / 2];
      const distance = point => Math.hypot(center[0] - point[0], center[1] - point[1]);
      for (const other of labels) if (other.id !== label.id) assert.ok(distance(label.anchor) <= distance(other.anchor) + 1, `${label.id} appears closer to ${other.id}`);
    }
  }
  for (let i = 0; i < labels.length; i++) for (const b of labels.slice(i + 1)) {
    const a = labels[i];
    assert.ok(a.left + a.width <= b.left || b.left + b.width <= a.left || a.top + a.height <= b.top || b.top + b.height <= a.top, `${a.id} overlaps ${b.id}`);
  }
}

await fs.mkdir(output, { recursive: true });
try {
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5222, strictPort: true, hmr: false } });
  await server.listen();
  browser = await chromium.launch({ headless: true, ...(hardware ? { args: ['--enable-gpu', '--use-angle=d3d11', '--ignore-gpu-blocklist'] } : {}) });
  page = await browser.newPage({ viewport: { width: 1600, height: 1100 } }); page.setDefaultTimeout(20000);
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:5222/'); await page.waitForFunction(() => window.lensLab?.sceneDebug()?.ready);
  await check('fourteen parts use an actual WebGL renderer', async () => {
    gpu = await page.locator('#scene canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl2'); if (!gl) return null;
      const extension = gl.getExtension('WEBGL_debug_renderer_info');
      return gl.getParameter(extension ? extension.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
    });
    assert.ok(gpu); if (hardware) assert.match(gpu, /RTX 5080.*D3D11|D3D11.*RTX 5080/);
    assert.equal((await debug()).componentCount, 14);
  });
  await check('whole and side labels identify the closest core part without overlaps', async () => {
    for (const preset of ['iso', 'side']) {
      await page.locator(`[data-camera="${preset}"]`).click(); await paint();
      await labelBounds({ association: true }); await capture(`labels-${preset}`);
    }
    const camera = (await debug()).camera;
    await page.locator('.lens-part-label[data-part-id="screen-surface"]').click();
    assert.equal((await state()).view.selectedPart, 'screen-surface'); assert.deepEqual((await debug()).camera, camera);
    await page.locator('#part-select').selectOption('lens-glass'); assert.deepEqual((await debug()).camera, camera);
  });
  await check('actual texture bytes and mesh axes preserve two-axis real-image inversion', async () => {
    await edit('screen-distance', 300); await page.locator('[data-camera="screen"]').click(); await capture('screen-sharp');
    const s = await state(), d = await debug(), screen = makeProjection(s.solution, { size: 192 }), target = makeTarget({ size: 192 });
    assert.equal(d.screenTexture.checksum, hash(screen.rgba)); assert.equal(d.targetTexture.checksum, hash(target.rgba));
    for (const [texture, uv, corners, x, half] of [[d.screenTexture, d.screenUv, d.screenCorners, .3, .024], [d.targetTexture, d.targetUv, d.targetCorners, -.3, .006]]) {
      assert.equal(texture.flipY, false); assert.deepEqual(uv, [0, 0, 0, 1, 1, 1, 1, 0]);
      [[.13 + half, -half], [.13 - half, -half], [.13 - half, half], [.13 + half, half]].forEach(([y, z], i) => { near(corners[i][0], x); near(corners[i][1], y); near(corners[i][2], z); });
    }
    // The asymmetric square is upper-right at the source and lower-left at -1 magnification.
    const pixel = (raster, horizontalMm, verticalMm) => {
      const col = Math.floor((horizontalMm / raster.physicalWidthMm + .5) * raster.width);
      const row = Math.floor((.5 - verticalMm / raster.physicalHeightMm) * raster.height);
      return raster.rgba[(row * raster.width + col) * 4];
    };
    assert.ok(pixel(target, 3.25, 2.25) > 100); assert.equal(pixel(target, -3.25, -2.25), 0);
    assert.ok(pixel(screen, -3.25, -2.25) > 100); assert.equal(pixel(screen, 3.25, 2.25), 0);
    await page.locator('#part-select').selectOption('target-pattern'); await page.locator('#focus-part').click(); await capture('source-pattern');
  });
  await check('real target and screen drags update shared config while preserving the camera', async () => {
    await page.locator('[data-camera="iso"]').click(); const camera = (await debug()).camera;
    for (const kind of ['target', 'screen']) {
      await page.locator('#scene').scrollIntoViewIfNeeded(); const bounds = await page.locator('#scene').boundingBox();
      const handle = (await debug()).dragHandles.find(h => h.kind === kind), before = (await state()).config;
      await page.mouse.move(bounds.x + handle.x, bounds.y + handle.y); await page.mouse.down();
      assert.equal((await debug()).dragging, kind); assert.equal((await debug()).orbitEnabled, false);
      await page.mouse.move(bounds.x + handle.x + 32, bounds.y + handle.y, { steps: 5 }); await paint(); await page.mouse.up(); await paint();
      const key = kind === 'target' ? 'objectDistanceMm' : 'screenDistanceMm';
      assert.notEqual((await state()).config[key], before[key]); assert.equal((await debug()).orbitEnabled, true); assert.equal((await debug()).dragging, null); assert.deepEqual((await debug()).camera, camera);
    }
  });
  await check('pointer cancellation restores orbit and releases the dragged carriage', async () => {
    await page.locator('#scene').scrollIntoViewIfNeeded(); const rect = await page.locator('#scene').boundingBox(), handle = (await debug()).dragHandles[0];
    await page.mouse.move(rect.x + handle.x, rect.y + handle.y); await page.mouse.down(); assert.equal((await debug()).dragging, 'target');
    await page.locator('#scene canvas').dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse', isPrimary: true, bubbles: true }); await page.mouse.up();
    assert.equal((await debug()).orbitEnabled, true); assert.equal((await debug()).dragging, null);
  });
  await check('parallel and virtual rays, the iris and resize retain finite scene state', async () => {
    await edit('object-distance', 150); await page.locator('[data-camera="iso"]').click(); await capture('infinity'); assert.equal((await debug()).focus.markerVisible, false);
    await edit('object-distance', 100); await page.locator('[data-camera="side"]').click(); await capture('virtual'); assert.equal((await debug()).focus.kind, 'virtual');
    await edit('object-distance', 300); await edit('screen-distance', 320); await edit('aperture', 6);
    await page.locator('#part-select').selectOption('iris'); await page.locator('#focus-part').click(); await capture('iris-small'); assert.equal((await debug()).apertureRadiusM, .003);
    const before = (await debug()).camera; await page.setViewportSize({ width: 390, height: 844 }); await paint(); assert.deepEqual((await debug()).camera, before);
  });
  await check('narrow and medium whole views keep readable, bounded core labels', async () => {
    await page.locator('#part-select').selectOption('lens-glass');
    for (const width of [390, 1024]) {
      const before = (await debug()).camera; await page.setViewportSize({ width, height: 844 }); await paint(); assert.deepEqual((await debug()).camera, before);
      await page.locator('#reset-camera').click(); await paint(); await labelBounds({ association: true }); await capture(`labels-${width}`);
      if (width === 1024) {
        await page.screenshot({ path: path.join(output, 'workspace-1024.png'), fullPage: true });
        await page.locator('#aperture').scrollIntoViewIfNeeded(); await paint();
        await page.screenshot({ path: path.join(output, 'controls-1024.png') });
      }
    }
  });
  await check('static scene stops drawing and has no browser errors', async () => {
    await paint(); const frame = (await debug()).renderFrame; await page.waitForTimeout(180); assert.equal((await debug()).renderFrame, frame); assert.deepEqual(errors, []);
  });
} catch (error) {
  failure = { message: error.message, stack: error.stack }; console.error(error.stack);
  await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true }).catch(() => {});
} finally {
  await browser?.close(); await server?.close();
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify({ status: failure ? 'FAILED' : 'PASS', hardware, checks, gpu, errors, evidence, failure }, null, 2));
}
console.log(JSON.stringify({ status: failure ? 'FAILED' : 'PASS', checks, gpu, errors }));
if (failure) process.exitCode = 1;
