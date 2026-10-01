import { MODEL_VERSION, normalizeConfig, assertConfig } from './physics.js';
import { DEFAULT_VIEW, COMPONENTS } from './geometry.js';

export { DEFAULT_VIEW };
export const projectType = 'lens-lab-project';
export const projectVersion = 1;
export const projectModelVersion = MODEL_VERSION;
const MAX_BYTES = 10 * 1024 * 1024;
const configKeys = ['focalLengthMm', 'objectDistanceMm', 'screenDistanceMm', 'apertureDiameterMm'];
const flagKeys = ['rays', 'focus', 'structure', 'labels'];
const partIds = new Set(COMPONENTS.map(part => part.id));
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const copy = value => structuredClone(value);

export class ProjectError extends Error {
  constructor(message, code = 'INVALID_PROJECT') {
    super(`${message} 원본 파일은 변경하지 않습니다.`);
    this.name = 'ProjectError'; this.code = code; this.preserveOriginal = true;
    this.futureVersion = code === 'FUTURE_SCHEMA' || code === 'FUTURE_MODEL';
  }
}
const fail = (message, code) => { throw new ProjectError(message, code); };
function shape(value, required, label, optional = []) {
  if (!record(value) || required.some(key => !Object.hasOwn(value, key))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) {
    fail(`${label}에 누락되거나 지원하지 않는 항목이 있습니다.`);
  }
}
function numeric(value, label, low, high) {
  if (!finite(value) || Object.is(value, -0) || value < low || value > high) fail(`${label} 수치가 올바르지 않습니다.`);
}
function modelVersion(value) {
  if (value === MODEL_VERSION) return;
  const candidate = typeof value === 'string' ? /^thin-lens-paraxial-(\d+)$/.exec(value) : null;
  fail('이 광학 모형 버전의 원래 기록을 보호합니다.', candidate && Number(candidate[1]) > 1 ? 'FUTURE_MODEL' : 'UNSUPPORTED_MODEL');
}
export function normalizeView(input) {
  const value = record(input) ? input : {};
  return { ...Object.fromEntries(flagKeys.map(key => [key, typeof value[key] === 'boolean' ? value[key] : DEFAULT_VIEW[key]])),
    selectedPart: partIds.has(value.selectedPart) ? value.selectedPart : DEFAULT_VIEW.selectedPart };
}
function savedView(value) {
  shape(value, [...flagKeys, 'selectedPart'], '관찰 화면');
  if (!partIds.has(value.selectedPart)) fail('지원하지 않는 관찰 부품입니다.');
  if (flagKeys.some(key => typeof value[key] !== 'boolean')) fail('관찰 표시 상태가 올바르지 않습니다.');
  return normalizeView(value);
}
function savedCamera(value) {
  if (value === null) return null;
  shape(value, ['position', 'target'], '카메라', ['zoom']);
  for (const key of ['position', 'target']) {
    if (!Array.isArray(value[key]) || value[key].length !== 3) fail('카메라 좌표는 세 개의 수치여야 합니다.');
    for (const coordinate of value[key]) numeric(coordinate, '카메라 좌표', -100, 100);
  }
  const distance = Math.hypot(...value.position.map((coordinate, index) => coordinate - value.target[index]));
  numeric(distance, '카메라 거리', .05 - 1e-10, 10 + 1e-10);
  if (Object.hasOwn(value, 'zoom')) numeric(value.zoom, '카메라 확대', .25, 4);
  return copy(value);
}
function savedConfig(value) {
  shape(value, configKeys, '광학 설정');
  try { assertConfig(value); }
  catch (error) {
    if (!(error instanceof TypeError) && !(error instanceof RangeError)) throw error;
    fail(`광학 설정이 모형의 수치 범위와 맞지 않습니다. ${error.message}`, 'INVALID_CONFIG');
  }
  return copy(value);
}
function savedComparison(value) {
  if (value === null) return null;
  shape(value, ['label', 'config'], '비교 기록');
  if (typeof value.label !== 'string' || value.label.length < 1 || value.label.length > 80 || !value.label.trim()
    || /[\u0000-\u001f\u007f]/.test(value.label)) fail('비교 이름은 제어 문자 없는 1~80자여야 합니다.');
  return { label: value.label, config: savedConfig(value.config) };
}
function validateProject(value) {
  if (!record(value) || value.type !== projectType) fail('지원하지 않는 렌즈 실험 파일입니다.', 'UNSUPPORTED_FORMAT');
  if (Number.isInteger(value.schemaVersion) && value.schemaVersion > projectVersion) fail('새로운 저장 형식을 보호합니다.', 'FUTURE_SCHEMA');
  if (value.schemaVersion !== projectVersion) fail('지원하지 않는 저장 형식 버전입니다.', 'UNSUPPORTED_SCHEMA');
  modelVersion(value.modelVersion);
  shape(value, ['type', 'schemaVersion', 'modelVersion', 'config', 'comparison', 'observation'], '렌즈 실험 파일');
  shape(value.observation, ['view', 'camera'], '관찰 기록');
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION,
    config: savedConfig(value.config), comparison: savedComparison(value.comparison),
    observation: { view: savedView(value.observation.view), camera: savedCamera(value.observation.camera) } };
}
export function createProject(input = {}) {
  const value = record(input) ? input : {};
  let config;
  try { config = savedConfig(value.config); }
  catch (error) { if (!(error instanceof ProjectError)) throw error; config = normalizeConfig(value.config); }
  let comparison = null, camera = null;
  if (value.comparison !== undefined) try { comparison = savedComparison(value.comparison); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  if (value.camera !== undefined) try { camera = savedCamera(value.camera); } catch (error) { if (!(error instanceof ProjectError)) throw error; }
  return { type: projectType, schemaVersion: projectVersion, modelVersion: MODEL_VERSION, config, comparison,
    observation: { view: normalizeView(value.view), camera } };
}
export function parseProject(text) {
  if (typeof text !== 'string') fail('실험 파일은 JSON 텍스트여야 합니다.', 'INVALID_JSON');
  if (text.length > MAX_BYTES || new TextEncoder().encode(text).byteLength > MAX_BYTES) fail('실험 파일은 10 MiB 이하여야 합니다.', 'PROJECT_TOO_LARGE');
  let value;
  try { value = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
  catch { fail('JSON 실험 파일을 읽을 수 없습니다.', 'INVALID_JSON'); }
  return validateProject(value);
}
export function serializeProject(project) { return JSON.stringify(validateProject(project), null, 2); }
