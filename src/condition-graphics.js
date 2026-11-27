import { targetGeometry, traceRay } from './physics.js';
import { makeTarget } from './projection.js';

// Both image planes share this millimetre viewport. SVG y increases downwards.
const HALF_WIDTH_MM = 24;
const GRID = `
  <path class="condition-grid" d="M-12-24V24M12-24V24M-24-12H24M-24 12H24"/>
  <path class="condition-axis" d="M0-24V24M-24 0H24"/>
`;

function targetMask() {
  const { width, height, linear, physicalWidthMm } = makeTarget({ size: 96 });
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const pixels = context.createImageData(width, height);
  for (let i = 0; i < linear.length; i++) pixels.data[4 * i + 3] = linear[i] * 255;
  context.putImageData(pixels, 0, 0);
  const url = canvas.toDataURL();
  return name => `
    <mask id="condition-${name}-mask" x="-24" y="-24" width="48" height="48" maskUnits="userSpaceOnUse" mask-type="alpha">
      <image id="condition-${name}-pattern" href="${url}" x="${-physicalWidthMm / 2}" y="${-physicalWidthMm / 2}"
        width="${physicalWidthMm}" height="${physicalWidthMm}"/>
    </mask>
    <rect class="condition-pattern" x="-24" y="-24" width="48" height="48" mask="url(#condition-${name}-mask)"/>`;
}

function mountGraphics() {
  const targetPattern = targetMask();
  const card = document.createElement('section');
  card.className = 'detail-card condition-card';
  card.setAttribute('aria-labelledby', 'condition-title');
  card.innerHTML = `
    <div class="condition-heading">
      <h3 id="condition-title">이상 상과 현재 스크린</h3>
      <div class="condition-offset">
        <span>실상 초점 기준 스크린 오프셋</span>
        <strong id="condition-offset"></strong>
      </div>
    </div>
    <div class="condition-planes">
      <figure>
        <figcaption><h4 id="condition-image-title"></h4><p id="condition-image-scale"></p></figcaption>
        <div class="condition-plane">
          <svg id="condition-image-plane" viewBox="-24 -24 48 48" role="img">
            ${GRID}${targetPattern('image')}
          </svg>
          <span id="condition-image-empty" class="condition-empty" aria-hidden="true" hidden>유한한 상 없음</span>
        </div>
      </figure>
      <figure>
        <figcaption><h4 id="condition-screen-title"></h4><p id="condition-screen-scale"></p></figcaption>
        <div class="condition-plane">
          <svg id="condition-screen-plane" viewBox="-24 -24 48 48" role="img">
            ${GRID}<circle id="condition-spot" class="condition-spot"/>
            ${targetPattern('screen')}
            <path id="condition-spot-center" class="condition-spot-center" d="M-0.85 0H0.85M0-0.85V0.85"/>
          </svg>
        </div>
      </figure>
    </div>
    <p class="condition-legend"><span>비교 범위 48 × 48 mm · 눈금 간격 12 mm</span><span class="condition-spot-key">점 흐림 지름 <b id="condition-blur-diameter"></b></span></p>
    <p id="condition-note" class="condition-note"></p>`;
  document.querySelector('.detail-cards').prepend(card);
  return Object.fromEntries([...card.querySelectorAll('[id]')].map(node => [node.id, node]));
}

let fields, lastSolution;

export function renderConditionGraphics(solution, detail, number) {
  if (lastSolution === solution) return;
  fields ??= mountGraphics();
  lastSolution = solution;

  const { image, screen } = detail;
  const isReal = image.kind === 'real';
  const isVirtual = image.kind === 'virtual';
  const isFiniteImage = image.distanceMm !== null;
  const offset = isReal ? screen.distanceMm - image.distanceMm : null;
  const signed = (value, digits = 3) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${number(Math.abs(value), digits)}`;
  const mm = value => `${signed(value)}\u00a0mm`;
  const imageTitle = isReal ? '실상 초점면' : isVirtual ? '역연장으로 구한 허상' : '이상 상 · 무한대';
  const imageScale = isFiniteImage ? `m ${signed(image.magnification, 4)} 배 · ${isVirtual ? '정립' : '도립'}` : '유한한 배율 없음';
  const screenScale = `중심 배율 B ${signed(screen.centerScale, 4)} 배`;
  const diameter = `${number(screen.blurDiameterMm, 4)}\u00a0mm`;

  const offsetNode = fields['condition-offset'];
  offsetNode.dataset.offsetMm = String(offset);
  offsetNode.textContent = offset === null ? '실상 초점 없음'
    : `${mm(offset)} · ${offset === 0 ? '초점 일치' : offset < 0 ? '초점 앞' : '초점 뒤'}`;
  fields['condition-image-title'].textContent = isFiniteImage ? `${imageTitle} ${mm(image.distanceMm)}` : imageTitle;
  fields['condition-image-scale'].textContent = imageScale;
  fields['condition-screen-title'].textContent = `스크린 ${mm(screen.distanceMm)}`;
  fields['condition-blur-diameter'].textContent = diameter;
  fields['condition-image-empty'].hidden = isFiniteImage;

  const target = targetGeometry(solution.config);
  const projectedTarget = scale => `translate(${scale * target.horizontalOffsetMm} 0) scale(${scale * target.scale})`;
  fields['condition-image-pattern'].setAttribute('transform', isFiniteImage ? projectedTarget(image.magnification) : 'scale(0)');
  fields['condition-screen-pattern'].setAttribute('transform', projectedTarget(screen.centerScale));

  const imagePlane = fields['condition-image-plane'];
  imagePlane.dataset.kind = image.kind;
  imagePlane.dataset.scale = String(image.magnification);
  imagePlane.setAttribute('aria-label', isFiniteImage ? `${imageTitle} ${mm(image.distanceMm)}. ${imageScale}.` : '유한한 거리의 이상 상 없음.');
  const screenPlane = fields['condition-screen-plane'];
  screenPlane.dataset.scale = String(screen.centerScale);
  const { zMm: spotX, yMm: spotY } = traceRay(solution.config,
    { horizontalMm: target.horizontalOffsetMm, verticalMm: 0 }, { horizontalMm: 0, verticalMm: 0 }).screen;
  const screenObservation = target.horizontalOffsetMm ? `${screenScale} · 중심 가로 ${mm(spotX)}` : screenScale;
  fields['condition-screen-scale'].textContent = screenObservation;
  const spot = fields['condition-spot'];
  spot.setAttribute('cx', String(spotX));
  spot.setAttribute('cy', String(-spotY));
  spot.setAttribute('r', String(screen.blurRadiusMm));
  spot.dataset.diameterMm = String(screen.blurDiameterMm);
  fields['condition-spot-center'].setAttribute('transform', `translate(${spotX} ${-spotY})`);
  const spotExtent = Math.max(Math.abs(spotX), Math.abs(spotY));
  const clipping = spotExtent - screen.blurRadiusMm > HALF_WIDTH_MM ? '표적 중심점의 흐림이 스크린 밖에 있습니다.'
    : spotExtent + screen.blurRadiusMm > HALF_WIDTH_MM ? '흐림 원 일부가 스크린 밖에 있습니다.' : '';
  screenPlane.setAttribute('aria-label', `스크린 ${mm(screen.distanceMm)}에서 ${screenObservation}. 표적 중심점의 흐림 원 지름 ${diameter}. ${clipping}`.trim());
  fields['condition-note'].textContent = `스크린 무늬는 표적 각 점의 흐림 중심을 이은 모양입니다. 원은 표적 중심점의 기하학적 흐림입니다. ${clipping}`.trim();
}
