import { lensDetail } from './detail-model.js';
import { COMPONENTS, GEOMETRY as G } from './geometry.js';

const fact = (label, value, unit = '', digits = 2) => ({ label, value, unit, digits });
const rangeText = range => range ? `${range.minMm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })}–${range.maxMm.toLocaleString('ko-KR', { maximumFractionDigits: 3 })} mm` : '레일 안에 없음';
const kindText = { converging: '수렴 · 렌즈 뒤 실상', parallel: '평행 · 유한 초점 없음', diverging: '발산 · 역연장 허상' };
const imageText = { real: '실상', infinity: '무한대', virtual: '허상' };

/** Compact component observations, with the same fixed 0.1 mm radius criterion
 * as the live detail panel. Labels describe model quantities, not measurements.
 */
export function describeLensDetail(partId, config, solution) {
  const d = lensDetail(config, solution);
  const { aperture: a, screen: s, image: i, light, focusTolerance: t } = d;
  const u = config.objectDistanceMm, f = config.focalLengthMm;
  const collected = () => fact('상대 수집 광량', light.collectedRelative, '배', 4);
  const range = () => fact('허용 스크린 위치 · 레일 안', rangeText(t.railRangeMm));
  const distance = () => fact('이상 상의 위치 · 렌즈 기준', i.distanceMm ?? '무한대', i.distanceMm === null ? '' : 'mm', 3);
  const magnification = () => fact('이상 상의 배율 m', i.magnification ?? '유한값 없음', i.magnification === null ? '' : '배', 4);
  const blur = () => fact('한 점의 흐림 반지름', s.blurRadiusMm, 'mm', 4);
  const toleranceNote = '현재 물체거리·초점거리·조리개를 고정하고, 한 점의 기하학적 흐림 반지름이 0.1 mm 이하인 스크린 위치만 표시합니다. 물체거리의 피사계심도가 아니며 회절은 계산하지 않습니다.';
  let facts, note;
  switch (partId) {
    case 'bench-base':
    case 'rail':
    case 'rail-scale':
      facts = [fact('표적 위치 · 렌즈 기준', -u, 'mm', 3), fact('스크린 위치 · 렌즈 기준', s.distanceMm, 'mm', 3),
        distance(), fact('실상 초점이 스크린 레일 안', i.realFocusOnRail ? '예' : '아니요'), range(), fact('허용 위치 폭 · 레일 안', t.railWidthMm, 'mm', 3)];
      note = `렌즈 중심이 0 mm이며 스크린 이동 범위는 +100–+900 mm입니다. 레일 밖 상의 위치를 끝점으로 바꾸지 않습니다. ${toleranceNote}`;
      break;
    case 'target-housing':
    case 'target-pattern':
    case 'target-carriage':
      facts = [fact('물체거리 u', u, 'mm', 3), fact('표적 가로 범위', G.targetWidth * 1000, 'mm'),
        fact('표적 세로 범위', G.targetHeight * 1000, 'mm'), fact('현재 스크린 중심 배율 B', s.centerScale, '배', 4), magnification(), collected()];
      note = '표적의 각 점이 만드는 흐림 원 중심은 현재 스크린에서 B = −s/u로 이동합니다. 이 값은 이상 상의 배율 m = −v/u와 다르며 실상 초점면에서만 일치합니다. 상대 광량은 일정한 발광 표적을 가정합니다.';
      break;
    case 'lens-glass':
      facts = [fact('초점거리 f', f, 'mm'), fact('한 표적점의 출사 광선', kindText[d.bundle.kind]),
        fact('출사 광선 수렴도 q', d.bundle.vergencePerMm, 'mm⁻¹', 7), distance(), magnification(), fact('명목 f/D', a.fNumber, '', 3)];
      note = 'q = 1/f − 1/u이며 양수는 수렴, 0은 한 표적점의 평행 광선, 음수는 발산입니다. 서로 다른 표적점의 평행 광선 방향은 서로 다릅니다. 유리의 곡면·두께는 표시용이며 면별 굴절이나 실제 유리 재질을 풀지 않습니다.';
      break;
    case 'lens-ring':
    case 'lens-carriage':
      facts = [fact('렌즈 중심 위치', 0, 'mm'), fact('광축 높이', G.axisY * 1000, 'mm'),
        fact('표시 렌즈 지름', G.lensRadius * 2000, 'mm'), fact('계산 조리개 지름', a.diameterMm, 'mm'),
        fact('명목 f/D', a.fNumber, '', 3), fact('상의 종류', imageText[i.kind])];
      note = '렌즈 지지는 광축 중심과 렌즈의 표시 외형을 정합니다. 투영에 쓰는 유효 원형 동공은 설정한 조리개 지름이며, 표시 유리 지름이나 고정 링 면적을 광학 구경으로 대신하지 않습니다.';
      break;
    case 'iris':
      facts = [fact('조리개 지름 D', a.diameterMm, 'mm'), fact('열린 원형 면적', a.areaMm2, 'mm²', 3),
        fact('명목 f/D', a.fNumber, '', 3), collected(), blur(), fact('허용 위치 폭 · 레일 안', t.railWidthMm, 'mm', 3)];
      note = '같은 물체거리에서 상대 수집 광량은 열린 면적에 비례합니다. 명목 f/D만으로 현재 스크린 밝기를 정하지 않습니다. 이 모형은 기하학적 흐림만 다루며 작은 구경의 회절·실제 해상도·수치개구를 계산하지 않습니다.';
      break;
    case 'screen-surface':
      facts = [fact('스크린거리 s', s.distanceMm, 'mm', 3), fact('현재 스크린 중심 배율 B', s.centerScale, '배', 4),
        fact('동공 좌표 배율 C', s.pupilScale, '배', 5), blur(),
        fact('선형 영상 배율 인자', light.irradianceScale, '배', 4), range()];
      note = `스크린 좌표는 C·동공점 + B·표적점입니다. 선형 영상 배율 인자는 표적 마스크와 흐림 원판의 합성곱에 곱하는 값으로, 실제 조도나 픽셀 밝기 자체가 아닙니다. ${toleranceNote}`;
      break;
    case 'screen-frame':
    case 'screen-carriage':
      facts = [fact('스크린거리 s', s.distanceMm, 'mm', 3), fact('투영면 가로', G.screenWidth * 1000, 'mm'),
        fact('투영면 세로', G.screenHeight * 1000, 'mm'), fact('한 점의 흐림 지름', s.blurDiameterMm, 'mm', 4),
        range(), fact('현재 위치의 반지름 기준', t.containsScreen ? '0.1 mm 이하' : '0.1 mm 초과')];
      note = `48 mm 투영면 밖으로 나간 빛은 잘리며 남은 화면을 다시 밝게 정규화하지 않습니다. ${toleranceNote}`;
      break;
    case 'power-cable':
      facts = [fact('광원 모형', '일정한 표적 휘도'), collected(),
        fact('선형 영상 배율 인자', light.irradianceScale, '배', 4), fact('전기 회로 계산', '없음')];
      note = '케이블은 구조 표현입니다. 전압·전류·소비 전력·광원의 와트 출력을 계산하지 않습니다. 상대 광량의 기준은 조리개 18 mm, 물체거리 300 mm이며 표시 영상은 고정 노출을 사용합니다.';
      break;
    default:
      return { facts: [], note: COMPONENTS.some(part => part.id === partId) ? '상세 계산값이 없습니다.' : '선택한 부품의 상세 계산값이 없습니다.' };
  }
  return { facts, note };
}
