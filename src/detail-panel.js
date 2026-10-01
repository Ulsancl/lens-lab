import { describeLensDetail } from './detail-readouts.js';

const $ = selector => document.querySelector(selector);
const number = (value, digits = 3) => {
  if (!Number.isFinite(value)) return '정의되지 않음';
  if ((Math.abs(value) > 0 && Math.abs(value) < 10 ** -digits) || Math.abs(value) >= 1e7) return value.toExponential(3);
  return (Object.is(value, -0) ? 0 : value).toLocaleString('ko-KR', { maximumFractionDigits: digits });
};
function quantity(selector, value, unit = '', digits = 3) {
  const node = $(selector); node.dataset.value = value === null ? 'null' : String(value);
  node.textContent = value === null ? '정의되지 않음' : `${number(value, digits)}${unit ? ` ${unit}` : ''}`;
}
function facts(selector, rows) {
  $(selector).replaceChildren(...rows.map(row => {
    const item = document.createElement('div'); item.className = 'detail-fact';
    Object.assign(item.dataset, { label: row.label, value: String(row.value), unit: row.unit ?? '' });
    const term = document.createElement('dt'), value = document.createElement('dd');
    term.textContent = row.label;
    value.textContent = typeof row.value === 'number' ? `${number(row.value, row.digits ?? 3)}${row.unit ? ` ${row.unit}` : ''}` : String(row.value);
    item.append(term, value); return item;
  }));
}
const ns = 'http://www.w3.org/2000/svg';
function svgNode(tag, attributes, text) {
  const node = document.createElementNS(ns, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  if (text !== undefined) node.textContent = text;
  return node;
}
function tolerancePlot(config, detail) {
  const svg = $('#tolerance-plot'), range = detail.focusTolerance.railRangeMm;
  const s = config.screenDistanceMm, v = detail.image.distanceMm, limit = detail.focusTolerance.blurRadiusLimitMm;
  let lo = 100, hi = 900;
  if (detail.image.realFocusOnRail) {
    const margin = Math.max(20, detail.focusTolerance.railWidthMm * 3);
    lo = Math.max(100, Math.min(s, v) - margin); hi = Math.min(900, Math.max(s, v) + margin);
  }
  const blur = distance => config.apertureDiameterMm / 2 * Math.abs(1 + distance / config.objectDistanceMm - distance / config.focalLengthMm);
  const yMax = Math.max(limit * 1.6, blur(lo), blur(hi)) * 1.12;
  const left = 48, right = 626, top = 25, bottom = 172;
  const x = distance => left + (distance - lo) / (hi - lo) * (right - left), y = radius => bottom - radius / yMax * (bottom - top);
  Object.assign(svg.dataset, { screenMm: String(s), limitMm: String(limit), domainMinMm: String(lo), domainMaxMm: String(hi), yMaxMm: String(yMax) });
  svg.setAttribute('aria-label', `스크린 위치 ${number(lo, 2)}부터 ${number(hi, 2)} mm의 점 흐림 반지름. 현재 ${number(s, 3)} mm에서 ${number(detail.screen.blurRadiusMm, 4)} mm. 허용 반지름 ${number(limit)} mm.`);
  const nodes = [svgNode('title', {}, '스크린 위치에 따른 기하학적 점 흐림 반지름')];
  for (let i = 0; i <= 2; i++) {
    const radius = yMax * i / 2;
    nodes.push(svgNode('line', { x1: left, x2: right, y1: y(radius), y2: y(radius), class: 'plot-grid' }));
    nodes.push(svgNode('text', { x: left - 8, y: y(radius) + 4, 'text-anchor': 'end', class: 'plot-text' }, number(radius, 2)));
  }
  if (range) nodes.push(svgNode('rect', { id: 'tolerance-band', x: x(range.minMm), y: top, width: x(range.maxMm) - x(range.minMm), height: bottom - top, class: 'plot-band', 'data-min-mm': range.minMm, 'data-max-mm': range.maxMm }));
  nodes.push(svgNode('line', { x1: left, x2: right, y1: bottom, y2: bottom, class: 'plot-axis' }));
  nodes.push(svgNode('line', { id: 'tolerance-threshold', x1: left, x2: right, y1: y(limit), y2: y(limit), class: 'plot-threshold', 'data-value': limit }));
  const distances = [lo, hi];
  if (detail.image.kind === 'real' && v >= lo && v <= hi) {
    distances.push(v);
    nodes.push(svgNode('line', { x1: x(v), x2: x(v), y1: top, y2: bottom, class: 'plot-image', 'data-image-mm': v }));
  }
  distances.sort((a, b) => a - b);
  nodes.push(svgNode('path', { id: 'tolerance-curve', d: distances.map((distance, index) => `${index ? 'L' : 'M'}${x(distance)} ${y(blur(distance))}`).join(' '), class: 'plot-curve' }));
  nodes.push(svgNode('line', { x1: x(s), x2: x(s), y1: y(detail.screen.blurRadiusMm), y2: bottom, class: 'plot-current' }));
  nodes.push(svgNode('circle', { id: 'tolerance-current', cx: x(s), cy: y(detail.screen.blurRadiusMm), r: 4.5, class: 'plot-current-dot', 'data-screen-mm': s, 'data-blur-mm': detail.screen.blurRadiusMm }));
  for (let i = 0; i <= 4; i++) {
    const distance = lo + (hi - lo) * i / 4;
    nodes.push(svgNode('line', { x1: x(distance), x2: x(distance), y1: bottom, y2: bottom + 4, class: 'plot-axis' }));
    nodes.push(svgNode('text', { x: x(distance), y: bottom + 19, 'text-anchor': 'middle', class: 'plot-text' }, number(distance, 1)));
  }
  nodes.push(svgNode('text', { x: left, y: 14, class: 'plot-text' }, '흐림 반지름 (mm)'));
  nodes.push(svgNode('text', { x: (left + right) / 2, y: 218, 'text-anchor': 'middle', class: 'plot-text' }, '렌즈 중심 → 스크린 거리 (mm)'));
  svg.replaceChildren(...nodes);
}

export function renderLensDetails(config, solution, view, detail) {
  const selected = describeLensDetail(view.selectedPart, config, solution);
  facts('#part-detail-facts', selected.facts); facts('#focus-detail-facts', selected.facts);
  $('#part-detail-note').textContent = selected.note; $('#focus-detail-note').textContent = selected.note;
  $('#focus-part-select').value = view.selectedPart;
  const reference = `현재 조건 · f ${number(config.focalLengthMm, 9)} / 물체 ${number(config.objectDistanceMm, 9)} / 스크린 ${number(config.screenDistanceMm, 9)} / 구경 ${number(config.apertureDiameterMm, 9)} mm`;
  $('#detail-reference').textContent = reference; $('#focus-detail-reference').textContent = reference;
  const tolerance = detail.focusTolerance, range = tolerance.railRangeMm, rangeNode = $('#focus-tolerance-range');
  rangeNode.dataset.empty = String(!range); rangeNode.dataset.widthMm = String(tolerance.railWidthMm);
  if (range) {
    rangeNode.dataset.minMm = String(range.minMm); rangeNode.dataset.maxMm = String(range.maxMm);
    rangeNode.textContent = `${number(range.minMm, 3)}–${number(range.maxMm, 3)} mm`;
  } else { delete rangeNode.dataset.minMm; delete rangeNode.dataset.maxMm; rangeNode.textContent = '레일 안에 해당 구간 없음'; }
  const status = $('#focus-tolerance-status'); status.dataset.within = String(tolerance.containsScreen);
  status.textContent = tolerance.containsScreen ? '현재 스크린 · 기준 이내' : '현재 스크린 · 기준 초과';
  $('#focus-tolerance-note').textContent = range ? `현재 조건에서 스크린을 놓을 수 있는 ${number(tolerance.railWidthMm, 3)} mm 폭입니다. 물체 위치·초점거리·구경을 바꾸면 이 구간도 달라집니다.` : detail.image.kind === 'infinity' ? '한 물체점의 출사 광선이 평행합니다. 유한한 스크린 거리에는 이 기준을 만족하는 구간이 없습니다.' : detail.image.kind === 'virtual' ? '허상은 물체 쪽의 역연장 교점입니다. 현재 스크린에 선명하게 맺히는 상으로 취급하지 않습니다.' : '예상 실상과 허용 구간이 스크린 이동 범위 밖에 있습니다. 실제 상거리를 레일 끝으로 줄여 표시하지 않습니다.';
  quantity('#detail-aperture-area', detail.aperture.areaMm2, 'mm²', 2);
  quantity('#detail-fnumber', detail.aperture.fNumber, '', 3);
  quantity('#detail-center-scale', detail.screen.centerScale, '배', 4);
  quantity('#detail-image-scale', detail.image.magnification, '배', 4);
  quantity('#detail-pupil-scale', detail.screen.pupilScale, '', 5);
  quantity('#detail-blur-diameter', detail.screen.blurDiameterMm, 'mm', 4);
  quantity('#detail-irradiance', detail.light.irradianceScale, '×', 4);
  quantity('#detail-collected', detail.light.collectedRelative, '×', 4);
  $('#bundle-kind').textContent = { converging: '수렴 · 실상 쪽으로 모임', parallel: '평행 · 유한한 초점 없음', diverging: '발산 · 물체 쪽에 허상' }[detail.bundle.kind];
  tolerancePlot(config, detail);
}
