// SI display geometry. Optical calculations live exclusively in physics.js.
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
export const GEOMETRY = freeze({
  axisY: .130, railX: [-.950, .950], railTopY: .034, railWidth: .052,
  baseY: .011, baseWidth: .190, carriageY: .045, carriageWidth: .088,
  lensRadius: .0125, lensRingRadius: .022, lensEdgeThickness: .0012, lensCenterThickness: .004,
  targetWidth: .012, targetHeight: .012, targetHousingWidth: .050, targetHousingHeight: .060,
  screenWidth: .048, screenHeight: .048, screenFrameWidth: .066, screenFrameHeight: .066,
  objectDistanceMm: [100, 900], screenDistanceMm: [100, 900], apertureDiameterMm: [6, 18],
});
export const DEFAULT_VIEW = freeze({ rays: true, focus: true, structure: false, labels: true, selectedPart: 'lens-glass' });
const entries = [
  ['bench-base', '광학 시험대', '세 캐리지와 레일을 지지하는 원본 시험대입니다.', '도장 강철 · 고무 받침'],
  ['rail', '직선 광학 레일', '렌즈 중심을 기준으로 표적과 스크린을 같은 광축 위에서 이동시킵니다.', '양극산화 알루미늄'],
  ['rail-scale', '거리 눈금', '렌즈 중심 0에서 양쪽으로 거리를 읽습니다. 표시 단위는 mm입니다.', '레이저 각인 눈금'],
  ['target-housing', '발광 표적 하우징', '뒤쪽 광원과 비대칭 표적을 담는 대표 하우징입니다. 광원 출력을 임의 자동 보정하지 않습니다.', '도장 금속 · 확산판'],
  ['target-pattern', '비대칭 발광 표적', '12 × 12 mm 범위의 자체 제작 무늬입니다. 위아래와 좌우를 구분해 상의 방향을 관찰합니다.', '발광 표적'],
  ['target-carriage', '표적 이동대', '표적이나 이동대를 광축 방향으로 끌면 물체거리가 바뀝니다. 숫자 입력과 같은 값을 조절합니다.', '알루미늄 · 황동 잠금 손잡이'],
  ['lens-glass', '볼록렌즈', '곡면 유리는 구조 표현입니다. 실제 광선 계산은 중심 평면에서 방향이 바뀌는 얇은 렌즈 모형입니다.', '광학 유리 표현'],
  ['lens-ring', '렌즈 고정 링', '렌즈와 조리개를 광축에 맞추어 고정합니다.', '검정 양극산화 알루미늄'],
  ['lens-carriage', '렌즈 지지대', '렌즈 중심을 레일의 0 mm에 고정합니다. 렌즈 교환은 초점거리 설정으로 표현합니다.', '강철 포스트 · 알루미늄 이동대'],
  ['iris', '원형 조리개', '실제 표시 구멍 지름을 6–18 mm로 바꿉니다. 광선과 투영은 같은 구경 설정을 사용합니다.', '무광 금속 조리개'],
  ['screen-surface', '투영 스크린', '48 × 48 mm 화면에 공통 계산 결과를 고정 노출로 표시합니다. 선명한 허상을 임의로 붙이지 않습니다.', '무광 투영면'],
  ['screen-frame', '스크린 프레임', '투영면의 가장자리와 48 mm 실제 범위를 표시합니다.', '도장 금속 프레임'],
  ['screen-carriage', '스크린 이동대', '스크린이나 이동대를 끌어 실제 스크린거리를 바꿉니다. 초점 밖 위치도 그대로 표시합니다.', '알루미늄 · 황동 잠금 손잡이'],
  ['power-cable', '광원 전원선', '표적 하우징 뒤쪽에 연결된 대표 저전압 전원선입니다. 전기 회로를 별도로 계산하지 않습니다.', '절연 케이블'],
];
export const COMPONENTS = freeze(entries.map(([id, name, description, material]) => ({ id, name, description, material })));
export function opticalPointToWorld(point) {
  const coordinates = [point?.xMm, point?.yMm, point?.zMm];
  if (!coordinates.every(Number.isFinite)) throw new TypeError('Optical point must be finite');
  return [coordinates[0] / 1000, GEOMETRY.axisY + coordinates[1] / 1000, coordinates[2] / 1000];
}
export function carriagePositions(config) {
  const u = config?.objectDistanceMm, s = config?.screenDistanceMm;
  if (!Number.isFinite(u) || !Number.isFinite(s) || u < 100 || u > 900 || s < 100 || s > 900) throw new RangeError('Carriage position outside the optical rail');
  return { targetX: -u / 1000, lensX: 0, screenX: s / 1000 };
}
// The first raster row is +Y and increasing columns are +Z. DataTexture.flipY
// stays false; UV v=0 is deliberately attached to the physical upper edge.
export function rasterPlane(width, height, facing = -1) {
  if (![width, height].every(n => Number.isFinite(n) && n > 0) || ![-1, 1].includes(facing)) throw new RangeError('Invalid raster plane');
  return {
    positions: [0, height / 2, -width / 2, 0, -height / 2, -width / 2, 0, -height / 2, width / 2, 0, height / 2, width / 2],
    uv: [0, 0, 0, 1, 1, 1, 1, 0], indices: facing < 0 ? [0, 1, 2, 0, 2, 3] : [0, 2, 1, 0, 3, 2],
  };
}
export function rasterPixelPoint(raster, column, row) {
  if (!raster || !Number.isInteger(column) || !Number.isInteger(row) || column < 0 || column >= raster.width || row < 0 || row >= raster.height) throw new RangeError('Pixel outside raster');
  return { horizontalMm: ((column + .5) / raster.width - .5) * raster.physicalWidthMm,
    verticalMm: (.5 - (row + .5) / raster.height) * raster.physicalHeightMm };
}
