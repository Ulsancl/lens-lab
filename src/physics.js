// A single ideal, converging, paraxial thin lens. All public lengths are mm.
export const MODEL_VERSION = 'thin-lens-paraxial-1';
export const CONFIG_BOUNDS = Object.freeze({
  focalLengthMm: Object.freeze({ min: 150, max: 300, values: Object.freeze([150, 225, 300]) }),
  objectDistanceMm: Object.freeze({ min: 100, max: 900 }),
  screenDistanceMm: Object.freeze({ min: 100, max: 900 }),
  apertureDiameterMm: Object.freeze({ min: 6, max: 18 }),
});
export const DEFAULT_CONFIG = Object.freeze({ focalLengthMm: 150, objectDistanceMm: 300, screenDistanceMm: 360, apertureDiameterMm: 18 });
const keys = Object.keys(DEFAULT_CONFIG);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const zero = value => Object.is(value, -0) ? 0 : value;
function record(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError(`${label}: an object is required`);
}
function shape(value, expected, label) {
  record(value, label);
  const actual = Object.keys(value);
  if (actual.length !== expected.length || actual.some(key => !expected.includes(key))) throw new TypeError(`${label}: missing or unknown field`);
}

/** For live controls only. Saved configs must use assertConfig. */
export function normalizeConfig(input) {
  const value = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  return Object.fromEntries(keys.map(key => {
    const bounds = CONFIG_BOUNDS[key];
    let normalized = finite(value[key]) ? Math.min(bounds.max, Math.max(bounds.min, value[key])) : DEFAULT_CONFIG[key];
    if (bounds.values && !bounds.values.includes(normalized)) {
      normalized = bounds.values.reduce((best, candidate) => Math.abs(candidate - normalized) < Math.abs(best - normalized) ? candidate : best);
    }
    return [key, normalized];
  }));
}

/** Exact imported values are validated without clamping or mutation. */
export function assertConfig(config) {
  shape(config, keys, 'config');
  for (const key of keys) {
    const value = config[key], bounds = CONFIG_BOUNDS[key];
    if (!finite(value)) throw new TypeError(`config.${key}: a finite number is required`);
    if (value < bounds.min || value > bounds.max || (bounds.values && !bounds.values.includes(value))) throw new RangeError(`config.${key}: outside supported values`);
  }
  return config;
}

export function solveOptics(config) {
  assertConfig(config);
  const { focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: diameter } = config;
  const atFocus = u === f;
  const distanceMm = atFocus ? null : f * u / (u - f);
  const pupilScale = zero(1 + s / u - s / f);
  return {
    modelVersion: MODEL_VERSION,
    config: { ...config },
    image: {
      kind: atFocus ? 'infinity' : distanceMm > 0 ? 'real' : 'virtual',
      distanceMm,
      magnification: atFocus ? null : -distanceMm / u,
      onBench: !atFocus && Math.abs(distanceMm) <= 900,
    },
    screen: {
      pupilScale,
      objectScale: -s / u,
      blurRadiusMm: diameter / 2 * Math.abs(pupilScale),
      irradianceScale: (diameter / 18) ** 2 * (300 / s) ** 2,
    },
    light: { collectedRelative: (diameter / 18) ** 2 * (300 / u) ** 2 },
  };
}

function point(value, label) {
  shape(value, ['horizontalMm', 'verticalMm'], label);
  if (!finite(value.horizontalMm) || !finite(value.verticalMm)) throw new TypeError(`${label}: finite coordinates are required`);
}

export function traceRay(config, objectPoint, pupilPoint) {
  assertConfig(config); point(objectPoint, 'objectPoint'); point(pupilPoint, 'pupilPoint');
  if (Math.abs(objectPoint.horizontalMm) > 6 || Math.abs(objectPoint.verticalMm) > 6) throw new RangeError('objectPoint: outside the 12 mm target');
  const { focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: diameter } = config;
  const radius = diameter / 2, pupilRadius = Math.hypot(pupilPoint.horizontalMm, pupilPoint.verticalMm);
  if (pupilRadius > radius + 1e-10) throw new RangeError('pupilPoint: outside the aperture');
  // Roundoff at the circular edge cannot put the returned ray outside it.
  const edgeScale = pupilRadius > radius ? radius / pupilRadius : 1;
  const aY = zero(pupilPoint.verticalMm * edgeScale), aZ = zero(pupilPoint.horizontalMm * edgeScale);
  const yPerX = zero((aY - objectPoint.verticalMm) / u - aY / f);
  const zPerX = zero((aZ - objectPoint.horizontalMm) / u - aZ / f);
  return {
    object: { xMm: -u, yMm: zero(objectPoint.verticalMm), zMm: zero(objectPoint.horizontalMm) },
    pupil: { xMm: 0, yMm: aY, zMm: aZ },
    screen: { xMm: s, yMm: zero(aY + s * yPerX), zMm: zero(aZ + s * zPerX) },
    outgoingSlope: { yPerX, zPerX },
  };
}
