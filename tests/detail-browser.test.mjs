import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { DEFAULT_CONFIG } from '../src/physics.js';
import { COMPONENTS } from '../src/geometry.js';
import { createProject } from '../src/project.js';

const root = path.resolve(import.meta.dirname, '..'), output = path.join(root, 'output', 'detail-browser');
const version = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version, address = 'http://127.0.0.1:5255';
const checks = [], errors = [], externalRequests = [], evidence = [];
let server, browser, context, page;
const near = (actual, expected, tolerance = 1e-9) => assert.ok(Number.isFinite(actual) && Number.isFinite(expected) && Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`);
const vectorNear = (actual, expected, tolerance = 1e-9) => actual.forEach((value, index) => near(value, expected[index], tolerance));
const cameraNear = (actual, expected) => { for (const key of ['position', 'target']) vectorNear(actual[key], expected[key], 1e-10); near(actual.zoom ?? 1, expected.zoom ?? 1, 1e-10); };
const state = () => page.evaluate(() => window.lensLab.getState());
const project = () => page.evaluate(() => window.lensLab.project());
const debug = () => page.evaluate(() => window.lensLab.sceneDebug());
const camera = async () => (await project()).observation.camera;
const guide = () => page.evaluate(() => window.lensLab.guide());
const fresh = config => createProject({ config: { ...DEFAULT_CONFIG, ...config } });
const load = value => page.evaluate(value => window.lensLab.loadProject(JSON.stringify(value)), value);
const select = id => page.locator('#part-select').selectOption(id);
const paint = (target = page) => target.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
const facts = (focus = false) => page.locator(focus ? '#focus-detail-facts .detail-fact' : '#part-detail-facts .detail-fact').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.label, { value: node.dataset.value, unit: node.dataset.unit, text: node.querySelector('dd').textContent.trim() }])));
async function edit(id, value) { await page.locator(`#${id}`).fill(String(value)); await page.locator(`#${id}`).press('Tab'); await paint(); }
const rasterHash = (selector = '#screen-preview') => page.locator(selector).evaluate(canvas => {
  let hash = 2166136261; for (const value of canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data) hash = Math.imul(hash ^ value, 16777619) >>> 0;
  return hash.toString(16).padStart(8, '0');
});
const rendering = (target = page) => target.evaluate(() => {
  const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), info = gl?.getExtension('WEBGL_debug_renderer_info'), scene = window.lensLab?.sceneDebug();
  return { documentId: window.__detailDocumentId, readyState: document.readyState, contextLost: gl?.isContextLost() ?? true,
    renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl?.getParameter(gl.RENDERER), drawCalls: scene?.drawCalls, triangles: scene?.triangles };
});
async function ready(target = page, previousDocumentId = null) {
  await target.waitForFunction(previous => {
    if (document.readyState !== 'complete' || !window.__detailDocumentId || window.__detailDocumentId === previous || !window.lensLab) return false;
    const canvas = document.querySelector('#scene canvas'), gl = canvas?.getContext('webgl2'), scene = window.lensLab.sceneDebug();
    return !!gl && !gl.isContextLost() && canvas.width > 0 && canvas.height > 0 && scene.ready && scene.drawCalls > 0 && scene.triangles > 0;
  }, previousDocumentId, { polling: 100, timeout: 60000 });
}
async function instrument(targetContext) {
  await targetContext.exposeBinding('__reportDetailContextLoss', (_source, message) => errors.push({ kind: 'webgl', message }));
  await targetContext.addInitScript(() => { window.__detailDocumentId = crypto.randomUUID(); document.addEventListener('webglcontextlost', event => window.__reportDetailContextLoss(event.statusMessage || 'WebGL context lost'), true); });
}
function watch(target) {
  target.on('pageerror', error => errors.push({ kind: 'page', message: error.message }));
  target.on('console', message => { if (message.type() === 'error') errors.push({ kind: 'console', message: message.text() }); });
  target.on('requestfailed', request => errors.push({ kind: 'request', message: request.url() + ': ' + request.failure()?.errorText }));
  target.on('request', request => { if (/^https?:/.test(request.url()) && new URL(request.url()).hostname !== '127.0.0.1') externalRequests.push(request.url()); });
}
async function check(name, action) {
  try { await action(); checks.push({ name, passed: true }); console.log('PASS ' + name); }
  catch (error) { checks.push({ name, passed: false, error: error.message }); evidence.push({ failureRendering: await rendering().catch(() => null) }); await page?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true, timeout: 5000 }).catch(() => {}); throw error; }
}
function opticalClosure(current) {
  const { focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: D } = current.config, d = current.detail;
  const vergence = 1 / f - 1 / u, C = 1 - s * vergence, B = -s / u;
  near(d.aperture.diameterMm, D); near(d.aperture.radiusMm, D / 2); near(d.aperture.areaMm2, Math.PI * D * D / 4); near(d.aperture.fNumber, f / D);
  near(d.bundle.vergencePerMm, vergence); assert.equal(d.bundle.kind, u === f ? 'parallel' : u > f ? 'converging' : 'diverging');
  assert.equal(d.image.kind, u === f ? 'infinity' : u > f ? 'real' : 'virtual');
  if (u === f) { assert.equal(d.image.distanceMm, null); assert.equal(d.image.magnification, null); }
  else { const v = f * u / (u - f); near(d.image.distanceMm, v, Math.max(1e-8, Math.abs(v) * 1e-12)); near(d.image.magnification, -v / u, Math.max(1e-8, Math.abs(v / u) * 1e-12)); }
  near(d.screen.distanceMm, s); near(d.screen.pupilScale, C); near(d.screen.centerScale, B); near(d.screen.blurRadiusMm, D / 2 * Math.abs(C)); near(d.screen.blurDiameterMm, D * Math.abs(C));
  near(d.light.collectedRelative, D * D / 324 * (300 / u) ** 2); near(d.light.irradianceScale, D * D / 324 * (300 / s) ** 2);
  const tolerance = d.focusTolerance, limit = .1, q = 2 * limit / D;
  near(tolerance.blurRadiusLimitMm, limit); near(tolerance.pupilScaleLimit, q);
  let range = null, forward = null;
  if (vergence > 0) { forward = { minMm: (1 - q) / vergence, maxMm: (1 + q) / vergence }; const minMm = Math.max(100, forward.minMm), maxMm = Math.min(900, forward.maxMm); if (minMm <= maxMm) range = { minMm, maxMm }; }
  if (forward) { near(tolerance.forwardRangeMm.minMm, forward.minMm, Math.max(1e-8, Math.abs(forward.minMm) * 1e-8)); near(tolerance.forwardRangeMm.maxMm, forward.maxMm, Math.max(1e-8, Math.abs(forward.maxMm) * 1e-8)); }
  else assert.equal(tolerance.forwardRangeMm, null);
  if (range) { near(tolerance.railRangeMm.minMm, range.minMm, 1e-8); near(tolerance.railRangeMm.maxMm, range.maxMm, 1e-8); near(tolerance.railWidthMm, range.maxMm - range.minMm, 1e-8); }
  else { assert.equal(tolerance.railRangeMm, null); near(tolerance.railWidthMm, 0); }
  assert.equal(tolerance.containsScreen, D / 2 * Math.abs(C) <= limit + 1e-12);
}

try {
  await mkdir(output, { recursive: true }); await rm(path.join(output, 'failure.png'), { force: true });
  server = await createServer({ root, server: { host: '127.0.0.1', port: 5255, strictPort: true, hmr: false, watch: null } }); await server.listen();
  browser = await chromium.launch({ headless: true });
  context = await browser.newContext({ viewport: { width: 1600, height: 1100 }, deviceScaleFactor: 1, acceptDownloads: true }); await instrument(context);
  page = await context.newPage(); page.setDefaultTimeout(30000); watch(page);
  await page.goto(address, { waitUntil: 'commit', timeout: 60000 }); await ready(); evidence.push({ initialRendering: await rendering() });

  await check('Every optical component has live facts while ordinary selection preserves optics, projection and camera', async () => {
    const before = await state(), beforeCamera = await camera(), beforeRaster = await rasterHash();
    assert.equal(COMPONENTS.length, 14); assert.equal((await debug()).componentCount, 14); assert.equal(await page.locator('#play').count(), 0);
    for (const part of COMPONENTS) {
      await select(part.id); const current = await state(), rows = await facts(); assert.equal(current.view.selectedPart, part.id);
      assert.deepEqual(current.config, before.config); assert.deepEqual(current.solution, before.solution); assert.deepEqual(current.comparison, before.comparison); cameraNear(await camera(), beforeCamera); assert.equal(await rasterHash(), beforeRaster);
      assert.ok(Object.keys(rows).length > 0 && Object.keys(rows).length <= 6, part.id);
      for (const row of Object.values(rows)) { assert.ok(row.text, part.id); assert.doesNotMatch(row.text, /NaN|Infinity|undefined/); }
      assert.ok((await page.locator('#part-detail-note').textContent()).trim(), part.id);
    }
  });

  await check('Physical aperture, conjugate image and finite screen bundle stay distinct on both sides of focus', async () => {
    for (const f of [150, 225, 300]) for (const u of [100, f, f + .0005, 2 * f]) {
      await load(fresh({ focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: 360, apertureDiameterMm: 12 })); opticalClosure(await state());
      const scene = await debug(); assert.ok(scene.rays.flat(2).every(Number.isFinite)); assert.equal(scene.screenTexture.checksum, await rasterHash());
    }
    await load(fresh({ objectDistanceMm: 149.9995 })); opticalClosure(await state()); assert.equal((await state()).detail.image.onBench, false);
    await load(fresh({ objectDistanceMm: 225, screenDistanceMm: 320 })); const d = (await state()).detail; near(d.image.magnification, -2); near(d.screen.centerScale, -320 / 225); assert.notEqual(d.image.magnification, d.screen.centerScale);
  });

  await check('The 0.10 mm blur-radius tolerance is the exact supported screen interval rather than an image classification', async () => {
    for (const config of [{ objectDistanceMm: 300, screenDistanceMm: 300, apertureDiameterMm: 18 }, { objectDistanceMm: 300, screenDistanceMm: 310, apertureDiameterMm: 6 }, { focalLengthMm: 300, objectDistanceMm: 450, screenDistanceMm: 900 }, { focalLengthMm: 300, objectDistanceMm: 449, screenDistanceMm: 900 }, { objectDistanceMm: 150 }, { objectDistanceMm: 100 }]) {
      await load(fresh(config)); opticalClosure(await state());
      assert.doesNotMatch(await page.locator('#focus-tolerance-status').textContent(), /NaN|Infinity|undefined/); assert.doesNotMatch(await page.locator('#focus-tolerance-range').textContent(), /NaN|Infinity|undefined/);
      const d = (await state()).detail, range = d.focusTolerance.railRangeMm, node = page.locator('#focus-tolerance-range');
      assert.equal(await node.getAttribute('data-empty'), String(range === null)); near(Number(await node.getAttribute('data-width-mm')), d.focusTolerance.railWidthMm);
      if (range) { near(Number(await node.getAttribute('data-min-mm')), range.minMm); near(Number(await node.getAttribute('data-max-mm')), range.maxMm); }
      else { assert.equal(await node.getAttribute('data-min-mm'), null); assert.equal(await node.getAttribute('data-max-mm'), null); }
      assert.equal(await page.locator('#focus-tolerance-status').getAttribute('data-within'), String(d.focusTolerance.containsScreen));
      const plot = page.locator('#tolerance-plot'), actualS = (await state()).config.screenDistanceMm;
      near(Number(await plot.getAttribute('data-screen-mm')), actualS); near(Number(await plot.getAttribute('data-limit-mm')), .1);
      const lo = Number(await plot.getAttribute('data-domain-min-mm')), hi = Number(await plot.getAttribute('data-domain-max-mm')), yMax = Number(await plot.getAttribute('data-y-max-mm'));
      assert.ok(lo >= 100 && hi <= 900 && lo < hi && actualS >= lo && actualS <= hi && yMax > 0);
      near(Number(await page.locator('#tolerance-current').getAttribute('cx')), 48 + (actualS - lo) / (hi - lo) * 578);
      near(Number(await page.locator('#tolerance-current').getAttribute('cy')), 172 - d.screen.blurRadiusMm / yMax * 147);
      near(Number(await page.locator('#tolerance-threshold').getAttribute('data-value')), .1);
      assert.equal(await page.locator('#tolerance-band').count(), range ? 1 : 0);
      const curve = await page.locator('#tolerance-curve').getAttribute('d'); assert.doesNotMatch(curve, /NaN|Infinity|undefined/);
      const coordinates = curve.match(/[-+]?(?:\d*\.)?\d+(?:e[-+]?\d+)?/gi).map(Number), applied = (await state()).config;
      assert.equal(coordinates.length, d.image.kind === 'real' && d.image.distanceMm >= lo && d.image.distanceMm <= hi ? 6 : 4);
      for (let i = 0; i < coordinates.length; i += 2) {
        const distance = lo + (coordinates[i] - 48) / 578 * (hi - lo), radius = applied.apertureDiameterMm / 2 * Math.abs(1 + distance / applied.objectDistanceMm - distance / applied.focalLengthMm);
        near(coordinates[i + 1], 172 - radius / yMax * 147, 1e-8);
      }
    }
  });

  await check('Reducing the pupil changes area and defocus width without rewriting the fixed-exposure comparison', async () => {
    await load(fresh({ screenDistanceMm: 320 })); await page.locator('#pin-comparison').click(); const before = await state(), savedRaster = await rasterHash();
    await edit('aperture', 6); const after = await state(); opticalClosure(after);
    near(before.detail.aperture.areaMm2 / after.detail.aperture.areaMm2, 9); near(before.detail.screen.blurRadiusMm / after.detail.screen.blurRadiusMm, 3);
    near(before.detail.light.collectedRelative / after.detail.light.collectedRelative, 9); assert.deepEqual(after.detail.image, before.detail.image); assert.deepEqual(after.comparison.config, before.config);
    const currentRaster = await rasterHash(), d = after.detail, currentCamera = await camera(); assert.notEqual(currentRaster, savedRaster);
    await page.locator('#show-saved').click(); assert.equal(await rasterHash('#comparison-preview'), savedRaster); assert.deepEqual((await state()).detail, d); assert.equal((await debug()).screenTexture.checksum, currentRaster);
    await select('iris'); cameraNear(await camera(), currentCamera); assert.deepEqual((await state()).comparison, before.comparison); assert.equal(await rasterHash('#comparison-preview'), savedRaster);
    await edit('screen-distance', 300); assert.equal(await page.locator('#screen-preview').isVisible(), true); near((await state()).detail.screen.blurRadiusMm, 0); assert.equal(await rasterHash('#comparison-preview'), savedRaster);
  });

  await check('Fractional saved controls and pending carriage edits retain their exact applied optical conditions', async () => {
    const config = { focalLengthMm: 150, objectDistanceMm: 150.0005, screenDistanceMm: 300.125, apertureDiameterMm: 7.25 };
    await load(fresh(config));
    for (const [key, id] of [['objectDistanceMm', 'object-distance'], ['screenDistanceMm', 'screen-distance'], ['apertureDiameterMm', 'aperture']]) {
      near(Number(await page.locator(`#${id}`).inputValue()), config[key]); near(Number(await page.locator(`[data-range="${key}"]`).inputValue()), config[key]);
    }
    opticalClosure(await state()); const saved = await project(); await load(saved); assert.deepEqual((await state()).config, config);
    for (const [key, sequence] of [['screenDistanceMm', [['ArrowRight', 301.125], ['Shift+ArrowLeft', 301.025], ['PageUp', 311.025], ['Home', 100], ['End', 900]]], ['apertureDiameterMm', [['ArrowRight', 7.35], ['Shift+ArrowDown', 7.34], ['PageDown', 6.34], ['Home', 6], ['End', 18]]]]) {
      await load(saved); const slider = page.locator(`[data-range="${key}"]`); await slider.focus();
      for (const [pressed, expected] of sequence) { await page.keyboard.press(pressed); await paint(); near((await state()).config[key], expected); near(Number(await slider.inputValue()), expected); opticalClosure(await state()); }
    }
    await load(saved);
    for (const submit of [false, true]) {
      await page.evaluate(submit => { const range = document.querySelector('[data-range="screenDistanceMm"]'), number = document.querySelector('#screen-distance'); range.value = '320'; range.dispatchEvent(new Event('input', { bubbles: true })); number.value = '500.125'; if (submit) document.querySelector('#settings-form').requestSubmit(); else number.dispatchEvent(new Event('change', { bubbles: true })); }, submit);
      await paint(); near((await state()).config.screenDistanceMm, 500.125); near((await state()).detail.screen.distanceMm, 500.125); opticalClosure(await state());
    }
  });

  await check('Lens, pupil and screen facts use the actual optical units and keep infinite-image quantities explicit', async () => {
    await load(fresh({ objectDistanceMm: 225, screenDistanceMm: 320, apertureDiameterMm: 9 })); const d = (await state()).detail;
    for (const [id, expected] of [['detail-aperture-area', d.aperture.areaMm2], ['detail-fnumber', d.aperture.fNumber], ['detail-center-scale', d.screen.centerScale], ['detail-image-scale', d.image.magnification], ['detail-pupil-scale', d.screen.pupilScale], ['detail-blur-diameter', d.screen.blurDiameterMm], ['detail-irradiance', d.light.irradianceScale], ['detail-collected', d.light.collectedRelative]]) near(Number(await page.locator(`#${id}`).getAttribute('data-value')), expected);
    await select('lens-glass'); let rows = await facts(); near(Number(rows['초점거리 f'].value), 150); assert.equal(rows['초점거리 f'].unit, 'mm');
    near(Number(rows['출사 광선 수렴도 q'].value), 1 / 150 - 1 / 225); assert.equal(rows['출사 광선 수렴도 q'].unit, 'mm⁻¹'); near(Number(rows['이상 상의 위치 · 렌즈 기준'].value), 450); near(Number(rows['이상 상의 배율 m'].value), -2);
    await select('iris'); rows = await facts(); near(Number(rows['열린 원형 면적'].value), Math.PI * 4.5 ** 2); assert.equal(rows['열린 원형 면적'].unit, 'mm²'); near(Number(rows['명목 f/D'].value), 150 / 9); assert.match(await page.locator('#part-detail-note').textContent(), /회절/);
    await select('screen-surface'); rows = await facts(); near(Number(rows['현재 스크린 중심 배율 B'].value), -320 / 225); near(Number(rows['동공 좌표 배율 C'].value), 1 + 320 / 225 - 320 / 150);
    near(Number(rows['한 점의 흐림 반지름'].value), d.screen.blurRadiusMm); assert.equal(rows['한 점의 흐림 반지름'].unit, 'mm'); assert.match(await page.locator('#part-detail-note').textContent(), /피사계심도가 아니/);
    await edit('object-distance', 150); await select('lens-glass'); rows = await facts(); assert.equal(rows['이상 상의 위치 · 렌즈 기준'].value, '무한대'); assert.equal(rows['이상 상의 배율 m'].value, '유한값 없음'); assert.equal(await page.locator('#detail-image-scale').getAttribute('data-value'), 'null');
    await select('power-cable'); rows = await facts(); assert.equal(rows['전기 회로 계산'].value, '없음'); assert.match(await page.locator('#part-detail-note').textContent(), /와트 출력을 계산하지/);
  });

  await check('Detail observation, download, import and reload preserve the saved camera and independent comparison', async () => {
    await load(fresh({ objectDistanceMm: 325.125, screenDistanceMm: 318.25, apertureDiameterMm: 11.25 })); await page.locator('#pin-comparison').click(); await edit('screen-distance', 350.125);
    const before = await state(), initialCamera = await camera();
    await page.locator('#scene canvas').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' })); const box = await page.locator('#scene canvas').boundingBox();
    await page.mouse.move(box.x + box.width * .45, box.y + box.height * .03); await page.mouse.down(); await page.mouse.move(box.x + box.width * .57, box.y + box.height * .09, { steps: 6 }); await page.mouse.up(); await paint();
    const manualCamera = await camera(); assert.notDeepEqual(manualCamera, initialCamera);
    await select('iris'); cameraNear(await camera(), manualCamera); assert.deepEqual((await state()).config, before.config); assert.deepEqual((await state()).comparison, before.comparison);
    await page.locator('#focus-part').click(); const focusedCamera = await camera(); assert.notDeepEqual(focusedCamera, manualCamera);
    const saved = await project(), savedDetail = (await state()).detail, download = page.waitForEvent('download'); await page.locator('#save-project').click();
    const filename = path.join(output, 'detail-observation.lens.json'); await (await download).saveAs(filename); assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), saved);
    assert.deepEqual(Object.keys(saved).sort(), ['comparison', 'config', 'modelVersion', 'observation', 'schemaVersion', 'type']);
    await page.locator('#new-project').click(); await page.locator('#project-file').setInputFiles(filename); await page.waitForFunction(expected => JSON.stringify(window.lensLab.project()) === JSON.stringify(expected), saved);
    assert.deepEqual((await state()).detail, savedDetail); cameraNear(await camera(), focusedCamera);
    const oldDocument = await page.evaluate(() => window.__detailDocumentId); await page.reload({ waitUntil: 'commit', timeout: 60000 }); await ready(page, oldDocument);
    assert.deepEqual(await project(), saved); assert.deepEqual((await state()).detail, savedDetail); cameraNear(await camera(), focusedCamera); evidence.push({ reloadRendering: await rendering(), previousDocumentId: oldDocument });
  });

  await check('Completed guided evidence stays fixed while detail observations and new-experiment undo remain live', async () => {
    await page.locator('[data-lesson="focus"]').click();
    for (const s of [303.33333333333337, 296.66666666666663]) {
      await edit('screen-distance', s); assert.equal((await state()).detail.focusTolerance.containsScreen, true); assert.equal(await page.locator('#guide-next').isEnabled(), true);
      assert.equal(await page.locator('#focus-tolerance-status').getAttribute('data-within'), 'true'); assert.match(await page.locator('#screen-explanation').textContent(), /초점 근처/);
    }
    await edit('screen-distance', 303.33334); assert.equal((await state()).detail.focusTolerance.containsScreen, false); assert.equal(await page.locator('#guide-next').isEnabled(), false);
    assert.equal(await page.locator('#focus-tolerance-status').getAttribute('data-within'), 'false'); assert.doesNotMatch(await page.locator('#screen-explanation').textContent(), /초점 근처/);
    await edit('screen-distance', 300); assert.equal((await state()).detail.focusTolerance.containsScreen, true); await page.locator('#guide-next').click();
    const completed = await guide(), resultText = await page.locator('#guide-result').textContent(); assert.equal(completed.status, 'completed');
    await select('screen-surface'); await page.locator('#focus-part').click(); await edit('screen-distance', 390); assert.equal((await state()).detail.focusTolerance.containsScreen, false);
    assert.deepEqual(await guide(), completed); assert.equal(await page.locator('#guide-result').textContent(), resultText);
    const saved = await project(), details = (await state()).detail; await page.locator('#new-project').click(); await page.locator('#undo-new').click();
    assert.deepEqual(await project(), saved); assert.deepEqual(await guide(), completed); assert.deepEqual((await state()).detail, details);
  });

  await check('Narrow focused facts and the static optical plot remain readable without introducing a hidden clock', async () => {
    await load(fresh({ objectDistanceMm: 225, screenDistanceMm: 450, apertureDiameterMm: 9 })); await page.setViewportSize({ width: 390, height: 844 }); await paint();
    await page.locator('#focus').click(); const disclosure = page.locator('.focus-detail-panel details'); assert.equal(await disclosure.evaluate(node => node.open), true);
    const before = await state(), beforeCamera = await camera(); await page.locator('#focus-part-select').selectOption('iris'); cameraNear(await camera(), beforeCamera); assert.deepEqual((await state()).config, before.config);
    await disclosure.locator('summary').focus(); await page.keyboard.press('Space'); assert.equal(await disclosure.evaluate(node => node.open), false);
    await page.keyboard.press('Space'); assert.equal(await disclosure.evaluate(node => node.open), true);
    assert.deepEqual(await facts(true), await facts()); assert.equal(await page.locator('#focus-detail-note').textContent(), await page.locator('#part-detail-note').textContent()); assert.equal(await page.locator('#focus-detail-reference').textContent(), await page.locator('#detail-reference').textContent());
    await page.locator('#focus-part-inline').click(); assert.notDeepEqual(await camera(), beforeCamera);
    const layout = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, height: document.querySelector('#scene').getBoundingClientRect().height }));
    assert.ok(layout.scroll <= layout.width + 1 && layout.height >= 280, JSON.stringify(layout));
    await page.locator('#focus').click(); await edit('aperture', 6); assert.deepEqual(await facts(true), await facts());
    await page.setViewportSize({ width: 1600, height: 1100 }); await paint(); await page.waitForTimeout(300); const stable = await debug(), stableState = await state();
    await page.waitForTimeout(200); assert.equal((await debug()).renderFrame, stable.renderFrame); assert.deepEqual(await state(), stableState); evidence.push({ narrowLayout: layout });
  });

  await check('Actual ruler datums, sliding contacts and optical assembly geometry agree with the millimetre model', async () => {
    const angles = [];
    for (const [u, s, D] of [[100, 100, 6], [300.125, 450.25, 12], [900, 900, 18]]) {
      await load(fresh({ objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: D })); const scene = await debug();
      assert.equal(scene.ruler.ticks.length, 181);
      for (const tick of scene.ruler.ticks) near(tick.worldXM, tick.nominalMm / 1000, 1e-7);
      const expectedPointers = { 'target-carriage': -u / 1000, 'lens-carriage': 0, 'screen-carriage': s / 1000 };
      assert.equal(scene.ruler.pointers.length, 3);
      for (const pointer of scene.ruler.pointers) { near(pointer.worldXM, expectedPointers[pointer.id], 1e-8); near(pointer.uv, .5 + expectedPointers[pointer.id] / 1.84); }
      const { physicalIris: iris, calculationPupil: pupil, seats } = scene.opticalAssembly;
      near(iris.planeXM, -.003); vectorNear(iris.throatXRangeM, [-.0034, -.0026], 1e-8); near(iris.radiusM, D / 2000, 1e-8);
      near(pupil.planeXM, 0); near(pupil.radiusM, D / 2000); assert.equal(pupil.visible, false); assert.equal(seats.length, 2);
      for (const seat of seats) { assert.ok(seat.innerRadiusM > .011 && seat.innerRadiusM < .0125); near(seat.outerRadiusM, .013, 1e-8); }
      angles.push(scene.opticalAssembly.adjustmentAngleRad);
      assert.equal(scene.rayDisplay.clipIntersection, true); vectorNear(scene.rayDisplay.clipIntervalM, [-.0041, .0041]); assert.equal(scene.rayDisplay.planes.length, 2);
      const clipped = x => scene.rayDisplay.planes.every(plane => plane.normal[0] * x + plane.constant < 0);
      for (const x of [-.004, -.003, 0, .003, .004]) assert.equal(clipped(x), true);
      for (const x of [-.0042, .0042, -.9, .9]) assert.equal(clipped(x), false);
      for (const ray of scene.rays) {
        near(ray[0][0], -u / 1000, 1e-7); near(ray[1][0], 0); near(ray[2][0], s / 1000, 1e-7);
        for (const axis of [1, 2]) { const offset = axis === 1 ? .13 : 0, a = ray[1][axis] - offset, source = ray[0][axis] - offset; near(ray[2][axis] - offset, a + s / 1000 * ((a - source) / (u / 1000) - a / .15), 1e-7); }
      }
      near(scene.supports.railToSupportGapM, 0, 1e-8); near(scene.supports.supportToBaseGapM, 0, 1e-8);
      for (const carriage of scene.supports.carriages) { near(carriage.guideClearanceM, .0003, 1e-8); for (const gap of carriage.shoeContactGapsM) near(gap, 0, 1e-8); }
      const backing = scene.supports.screenBacking; near(backing.frontXM, s / 1000, 1e-8); near(backing.rearXM - backing.frontXM, .002, 1e-8); near(backing.widthM, .048, 1e-8); near(backing.heightM, .048, 1e-8);
    }
    assert.ok(angles[0] < angles[1] && angles[1] < angles[2]); near(angles[1], 0); near(angles[0], -angles[2]);
    const before = await state(), rays = (await debug()).rays, pixels = await rasterHash(), beforeCamera = await camera();
    await page.locator('[data-view="structure"]').check(); assert.equal((await debug()).opticalAssembly.calculationPupil.visible, true); assert.deepEqual((await debug()).rays, rays);
    assert.equal(await rasterHash(), pixels); assert.deepEqual((await state()).detail, before.detail); cameraNear(await camera(), beforeCamera); assert.match(await page.locator('.lens-scene-note').textContent(), /계산 구경.*실제 조리개/);
    evidence.push({ mechanical: await debug() }); await page.locator('[data-view="structure"]').uncheck();
  });

  await check('Actual rendered lens, iris, scale and screen closeups show the physical apparatus and the new observations', async () => {
    await load(fresh({ objectDistanceMm: 300, screenDistanceMm: 320, apertureDiameterMm: 18 })); await select('lens-glass'); await page.locator('#reset-camera').click(); await paint();
    await page.screenshot({ path: path.join(output, 'lens-detail-overview.png'), fullPage: true });
    for (const [id, filename] of [['lens-glass', 'lens-closeup'], ['iris', 'iris-small-closeup'], ['rail-scale', 'scale-closeup'], ['screen-surface', 'screen-closeup']]) {
      if (id === 'iris') await edit('aperture', 6); if (id === 'screen-surface') await edit('screen-distance', 300);
      await select(id); await page.locator('#focus-part').click(); await paint();
      await page.locator('#scene').evaluate(node => node.scrollIntoView({ behavior: 'instant', block: 'center' })); const clip = await page.locator('#scene').boundingBox(); assert.ok(clip.width > 0 && clip.height > 0);
      await page.screenshot({ path: path.join(output, `${filename}.png`), clip });
    }
    await page.setViewportSize({ width: 390, height: 844 }); await page.locator('#focus').click(); await page.locator('#focus-part-select').selectOption('iris'); await page.locator('#focus-part-inline').click();
    const disclosure = page.locator('.focus-detail-panel details'); if (!await disclosure.evaluate(node => node.open)) await disclosure.locator('summary').click(); await paint();
    await page.screenshot({ path: path.join(output, 'narrow-iris-detail.png'), fullPage: true });
    await page.locator('#focus').click(); await page.setViewportSize({ width: 1600, height: 1100 });
  });

  assert.deepEqual(errors, []); assert.deepEqual(externalRequests, []);
} finally {
  await mkdir(output, { recursive: true });
  await writeFile(path.join(output, 'detail-browser-results.json'), JSON.stringify({ version, renderer: 'Headless Chromium default backend; actual renderer recorded in evidence. Static optical model with live browser clock.', checks, evidence, errors, externalRequests }, null, 2));
  await context?.close(); await browser?.close(); await server?.close();
}
