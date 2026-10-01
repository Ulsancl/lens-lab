import test from 'node:test';
import assert from 'node:assert/strict';
import { createProject, parseProject, serializeProject, normalizeView, DEFAULT_VIEW, ProjectError } from '../src/project.js';
import { DEFAULT_CONFIG, MODEL_VERSION, solveOptics } from '../src/physics.js';
import { COMPONENTS } from '../src/geometry.js';

const roundtrip = value => parseProject(serializeProject(value));
const invalid = (edit, code) => {
  const project = createProject(); edit(project);
  const original = JSON.stringify(project);
  assert.throws(() => parseProject(original), error => error instanceof ProjectError && error.preserveOriginal && (!code || error.code === code));
  assert.equal(JSON.stringify(project), original);
};

test('static project defaults contain optical conditions and observations, without derived image or time', () => {
  const project = createProject();
  assert.deepEqual(project, { type: 'lens-lab-project', schemaVersion: 1, modelVersion: MODEL_VERSION,
    config: { ...DEFAULT_CONFIG }, comparison: null, observation: { view: { ...DEFAULT_VIEW }, camera: null } });
  assert.deepEqual(roundtrip(project), project);
  assert.deepEqual(normalizeView(null), DEFAULT_VIEW);
});

test('real, focal and virtual configurations roundtrip exactly and reproduce their original solutions', () => {
  for (const [u, kind, distance, magnification] of [[300, 'real', 300, -1], [225, 'real', 450, -2], [150, 'infinity', null, null], [100, 'virtual', -300, 3]]) {
    const config = { ...DEFAULT_CONFIG, objectDistanceMm: u, screenDistanceMm: 320.125, apertureDiameterMm: 7.25 };
    const project = createProject({ config, comparison: { label: '원래 초점 · 300 mm', config: { ...DEFAULT_CONFIG, screenDistanceMm: 300 } } });
    const saved = roundtrip(project);
    assert.deepEqual(saved, project); assert.deepEqual(solveOptics(saved.config), solveOptics(config));
    assert.deepEqual([solveOptics(saved.config).image.kind, solveOptics(saved.config).image.distanceMm, solveOptics(saved.config).image.magnification], [kind, distance, magnification]);
  }
});

test('all legal focal lengths, range endpoints and fractional distances remain exact', () => {
  for (const focalLengthMm of [150, 225, 300]) for (const objectDistanceMm of [100, 150.00000001, 225.125, 899.999999, 900]) {
    const config = { focalLengthMm, objectDistanceMm, screenDistanceMm: 100, apertureDiameterMm: 6 };
    assert.deepEqual(roundtrip(createProject({ config })).config, config);
    config.screenDistanceMm = 900; config.apertureDiameterMm = 18;
    assert.deepEqual(roundtrip(createProject({ config })).config, config);
  }
});

test('every supported selected part and flag combination survives observation persistence', () => {
  assert.equal(COMPONENTS.length, 14);
  for (const { id } of COMPONENTS) {
    const view = { rays: false, focus: true, structure: true, labels: false, selectedPart: id };
    assert.deepEqual(roundtrip(createProject({ view })).observation.view, view);
  }
});

test('camera endpoints, optional zoom and manual vectors persist without rounding', () => {
  for (const camera of [null, { position: [.05, 0, 0], target: [0, 0, 0] },
    { position: [100, 100, 100], target: [90, 100, 100], zoom: .25 },
    { position: [.712345678901, .38, 1.27], target: [.03, .13, -.12], zoom: 4 }]) {
    assert.deepEqual(roundtrip(createProject({ camera })).observation.camera, camera);
  }
});

test('live creation normalizes invalid controls while strict imports refuse to repair them', () => {
  const project = createProject({ config: { focalLengthMm: 190, objectDistanceMm: 2, screenDistanceMm: 2000, apertureDiameterMm: '9' },
    view: { rays: 1, selectedPart: 'unknown-part', labels: false }, comparison: { label: '', config: DEFAULT_CONFIG },
    camera: { position: [0, 0, 0], target: [0, 0, 0] } });
  assert.deepEqual(project.config, { focalLengthMm: 225, objectDistanceMm: 100, screenDistanceMm: 900, apertureDiameterMm: 18 });
  assert.equal(project.observation.view.rays, DEFAULT_VIEW.rays); assert.equal(project.observation.view.labels, false);
  assert.equal(project.observation.view.selectedPart, DEFAULT_VIEW.selectedPart); assert.equal(project.comparison, null); assert.equal(project.observation.camera, null);
  for (const [key, value] of [['focalLengthMm', 190], ['objectDistanceMm', 99], ['objectDistanceMm', 900.1], ['screenDistanceMm', '300'], ['apertureDiameterMm', 5.999], ['apertureDiameterMm', 18.01]]) {
    invalid(project => { project.config[key] = value; }, 'INVALID_CONFIG');
  }
  const nonfinite = createProject(); nonfinite.config.screenDistanceMm = Infinity;
  assert.throws(() => serializeProject(nonfinite), ProjectError);
});

test('unknown and missing fields, old motion data and invalid types are rejected at each boundary', () => {
  for (const edit of [p => { p.state = {}; }, p => { p.solution = solveOptics(p.config); }, p => { p.timeS = 0; },
    p => { delete p.comparison; }, p => { p.config.unit = 'mm'; }, p => { delete p.config.focalLengthMm; },
    p => { p.observation.playbackRate = 1; }, p => { p.observation.view.rays = 1; }, p => { p.observation.view.selectedPart = 'armature-core'; },
    p => { p.observation.view.layers = {}; }, p => { delete p.observation.camera; }, p => { p.config = []; }]) invalid(edit);
  assert.throws(() => parseProject('[]'), ProjectError);
});

test('comparison is a named independent optical configuration, never an unvalidated derived result', () => {
  for (const label of ['', ' '.repeat(2), 'x'.repeat(81), 'line\nbreak', 'tab\there']) invalid(p => { p.comparison = { label, config: p.config }; });
  invalid(p => { p.comparison = { label: '원본', config: { ...p.config, focalLengthMm: 12 } }; });
  invalid(p => { p.comparison = { label: '원본', config: p.config, image: {} }; });
  const project = createProject({ comparison: { label: ' a '.padEnd(80, '가'), config: { ...DEFAULT_CONFIG, apertureDiameterMm: 6 } } });
  assert.equal(roundtrip(project).comparison.label, project.comparison.label);
});

test('invalid camera geometry and extra data cannot enter saved files', () => {
  for (const camera of [{ position: [0, 0, 0], target: [0, 0, 0] },
    { position: [.049, 0, 0], target: [0, 0, 0] }, { position: [10.01, 0, 0], target: [0, 0, 0] },
    { position: [101, 0, 0], target: [99, 0, 0] }, { position: [1, 0], target: [0, 0, 0] },
    { position: [1, 0, 0], target: [0, 0, 0], zoom: .24 }, { position: [1, 0, 0], target: [0, 0, 0], roll: 0 }]) {
    invalid(p => { p.observation.camera = camera; });
  }
  const project = createProject(); project.observation.camera = { position: [1, -0, 0], target: [0, 0, 0] };
  assert.throws(() => serializeProject(project), ProjectError);
});

test('create, parse and serialize never alias or mutate the original config and comparison', () => {
  const config = { ...DEFAULT_CONFIG }, view = { ...DEFAULT_VIEW }, comparison = { label: '기준', config: { ...DEFAULT_CONFIG, screenDistanceMm: 300 } };
  const camera = { position: [1, 1, 1], target: [0, 0, 0], zoom: 1.2 };
  const input = { config, view, comparison, camera }, original = structuredClone(input), project = createProject(input);
  project.config.screenDistanceMm = 700; project.comparison.config.screenDistanceMm = 800;
  project.observation.camera.position[0] = 2; project.observation.view.rays = false;
  assert.deepEqual(input, original);
  const text = serializeProject(project), restored = parseProject(text);
  restored.config.screenDistanceMm = 100;
  assert.equal(project.config.screenDistanceMm, 700); assert.equal(serializeProject(project), text);
});

test('future schema and model errors identify originals that the UI must protect', () => {
  for (const [key, value, code] of [['schemaVersion', 2, 'FUTURE_SCHEMA'], ['modelVersion', 'thin-lens-paraxial-2', 'FUTURE_MODEL']]) {
    const original = JSON.stringify({ ...createProject(), [key]: value });
    assert.throws(() => parseProject(original), e => e instanceof ProjectError && e.code === code && e.futureVersion && e.preserveOriginal);
  }
  invalid(p => { p.modelVersion = 'motor-dc-average-1'; }, 'UNSUPPORTED_MODEL');
  invalid(p => { p.schemaVersion = '1'; }, 'UNSUPPORTED_SCHEMA');
});

test('one UTF-8 BOM is accepted, malformed and oversized originals are rejected without rewrite', () => {
  const project = createProject(), text = serializeProject(project);
  assert.deepEqual(parseProject('\ufeff' + text), project);
  assert.throws(() => parseProject('\ufeff\ufeff' + text), e => e.code === 'INVALID_JSON');
  for (const input of [null, 12, '{원본\r\n']) assert.throws(() => parseProject(input), e => e.code === 'INVALID_JSON');
  assert.throws(() => parseProject(' '.repeat(10 * 1024 * 1024 + 1)), e => e.code === 'PROJECT_TOO_LARGE');
  // UTF-8 byte size, not only JavaScript character count, enforces the limit.
  assert.throws(() => parseProject('가'.repeat(4 * 1024 * 1024)), e => e.code === 'PROJECT_TOO_LARGE');
});
