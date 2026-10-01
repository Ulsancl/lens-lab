import { assertConfig, CONFIG_BOUNDS, solveOptics } from './physics.js';

const zero = value => Object.is(value, -0) ? 0 : value;
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function sameSolution(actual, expected) {
  if (!record(expected)) return actual === expected;
  return record(actual) && Object.keys(actual).length === Object.keys(expected).length
    && Object.keys(expected).every(key => Object.hasOwn(actual, key) && sameSolution(actual[key], expected[key]));
}

function checkedLimit(options) {
  if (!record(options) || Object.keys(options).some(key => key !== 'blurRadiusLimitMm')) throw new TypeError('Detail options must contain only blurRadiusLimitMm');
  const limit = Object.hasOwn(options, 'blurRadiusLimitMm') ? options.blurRadiusLimitMm : .1;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) throw new TypeError('Blur radius limit must be finite');
  if (limit < 0) throw new RangeError('Blur radius limit must be nonnegative');
  return zero(limit);
}

// Solve |1 - q*s| <= epsilon on the forward half-axis s >= 0. A null
// maximum denotes an unbounded interval; a null interval denotes no solution.
function forwardRange(q, epsilon) {
  if (q === 0) return epsilon >= 1 ? { minMm: 0, maxMm: null } : null;
  if (q < 0 && epsilon < 1) return null;
  const low = q > 0 ? Math.max(0, (1 - epsilon) / q) : 0;
  const high = q > 0 ? (1 + epsilon) / q : (epsilon - 1) / -q;
  return { minMm: zero(low), maxMm: Number.isFinite(high) ? zero(high) : null };
}

/** Additional observations of the existing ideal thin-lens solution, in mm.
 * No optical state, projection buffer, or project schema is changed.
 */
export function lensDetail(config, solution = solveOptics(config), options = {}) {
  assertConfig(config);
  const expected = solveOptics(config);
  if (!sameSolution(solution, expected)) throw new RangeError('Detail requires the solveOptics result for this exact config');
  const limit = checkedLimit(options);
  const { focalLengthMm: f, objectDistanceMm: u, screenDistanceMm: s, apertureDiameterMm: diameter } = config;
  const radius = diameter / 2;
  // Equivalent to 1/f - 1/u, without subtracting nearly equal reciprocals.
  const q = zero((u - f) / (f * u));
  const epsilon = 2 * (limit / diameter);
  const forward = forwardRange(q, epsilon), rail = CONFIG_BOUNDS.screenDistanceMm;
  let railRange = null;
  if (forward) {
    const minMm = Math.max(rail.min, forward.minMm), maxMm = Math.min(rail.max, forward.maxMm ?? Infinity);
    if (minMm <= maxMm) railRange = { minMm, maxMm };
  }
  // The existing solver evaluates C as 1+s/u-s/f. Retain that exact value,
  // allowing only its floating-point cancellation at the acceptance boundary.
  const rounding = 16 * Number.EPSILON * radius * Math.max(1, Math.abs(s / u), Math.abs(s / f));
  return {
    aperture: { diameterMm: diameter, radiusMm: radius, areaMm2: Math.PI * radius ** 2, fNumber: f / diameter },
    bundle: { kind: q > 0 ? 'converging' : q < 0 ? 'diverging' : 'parallel', vergencePerMm: q },
    image: { ...expected.image, realFocusOnRail: expected.image.kind === 'real'
      && expected.image.distanceMm >= rail.min && expected.image.distanceMm <= rail.max },
    screen: { distanceMm: s, pupilScale: expected.screen.pupilScale, centerScale: expected.screen.objectScale,
      blurRadiusMm: expected.screen.blurRadiusMm, blurDiameterMm: 2 * expected.screen.blurRadiusMm },
    light: { collectedRelative: expected.light.collectedRelative, irradianceScale: expected.screen.irradianceScale },
    focusTolerance: { blurRadiusLimitMm: limit, pupilScaleLimit: epsilon, forwardRangeMm: forward,
      railRangeMm: railRange, railWidthMm: railRange ? railRange.maxMm - railRange.minMm : 0,
      containsScreen: expected.screen.blurRadiusMm <= limit + rounding },
  };
}
