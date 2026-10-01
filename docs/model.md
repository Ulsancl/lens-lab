# 광학 계산과 투영 영상

Lens Lab은 하나의 이상적인 볼록 얇은 렌즈를 통과하는 근축 광선을 계산합니다. 초점, 실상·허상, 배율, 조리개에 따른 기하학적 흐림과 상대 광량을 관찰하는 모형입니다. 실제 렌즈의 성능·조도·카메라 노출을 예측하는 광학 설계 도구는 아닙니다.

## 입력과 좌표

모형 식별자는 `thin-lens-paraxial-1`입니다. 입력은 다음 네 값으로 제한합니다.

| 키 | 의미 | 허용값 | 기본값 |
| --- | --- | --- | --- |
| `focalLengthMm` | 초점 거리 f | 150, 225, 300 mm | 150 |
| `objectDistanceMm` | 표적과 렌즈 사이 거리 u | 100–900 mm | 300 |
| `screenDistanceMm` | 렌즈와 스크린 사이 거리 s | 100–900 mm | 360 |
| `apertureDiameterMm` | 원형 조리개 지름 D | 6–18 mm | 18 |

광축은 x축이고 렌즈 면은 x=0, 표적은 x=−u, 스크린은 x=s입니다. 표적의 가로 좌표는 z, 세로 좌표는 y에 대응하며 광축 중심을 0으로 둡니다. `traceRay`는 mm를 반환합니다. 3D 장면은 이를 m로 변환하고 광축 높이 0.13 m를 y에 더합니다. 표적은 12×12 mm, 스크린은 48×48 mm입니다.

## 상과 실제 광선

얇은 렌즈 관계식은 `1/f = 1/u + 1/v`, 상의 배율은 `m = −v/u`입니다. v>0이면 렌즈 뒤의 실상, v<0이면 표적 쪽의 허상입니다. u=f이면 상의 위치와 배율을 `null`로 반환하고 `kind: 'infinity'`로 구분합니다. 허상은 출사 광선의 역연장이 만나는 위치이며 실제 스크린에 선명하게 맺히는 상이 아닙니다. 이 기본 관계와 광선 부호는 [OpenStax의 Thin Lenses](https://openstax.org/books/university-physics-volume-3/pages/2-4-thin-lenses)를 따릅니다.

각 횡방향 좌표에서 표적점 r₀, 조리개 통과점 a의 출사 기울기와 스크린 좌표는 다음과 같습니다.

```text
출사 기울기 = (a − r₀)/u − a/f
스크린 좌표 = C·a + B·r₀
C = 1 + s/u − s/f
B = −s/u
```

원형 조리개에서 나온 한 표적점의 광선은 스크린에서 반지름 `b = (D/2)|C|`인 원을 이룹니다. 원의 중심 배율 B는 현재 스크린 거리로 정해지므로, 렌즈가 만드는 상 자체의 배율 m과 구분합니다. 초점면 s=v에서는 C=0이고 B=m입니다.

u가 f에 매우 가까워도 상의 위치를 임의의 레일 끝으로 자르지 않습니다. `image.onBench`는 유한한 상의 위치가 |v|≤900 mm인지 알립니다. 실제 광선 계산에는 유한한 u, s, f만 사용하므로 상이 무한대이거나 표시 레일 밖이어도 스크린 좌표는 유한합니다.

## 광량과 화면 밝기

표적은 일정한 단색 휘도를 가진 것으로 가정합니다. 조리개는 균일한 원형 동공이며 렌즈 흡수, 비네팅과 큰 각도에서의 보정은 생략합니다. 같은 표적의 기준 조건 D=18 mm, u=300 mm에 대한 상대 수집 광량은 다음과 같습니다.

```text
collectedRelative = (D/18)² · (300/u)²
irradianceScale   = (D/18)² · (300/s)²
```

조리개 면적에 비례하는 통과 광량과 유한한 물체 거리의 구분은 [Edmund Optics의 System Throughput, f/#, and Numerical Aperture](https://www.edmundoptics.com/knowledge-center/application-notes/imaging/lens-iris-aperture-setting/)에 설명되어 있습니다. 위 비율의 기준값과 아래 영상 적분은 이 앱의 명시적인 이상 모형입니다. lux, W 또는 카메라 센서의 실측값을 뜻하지 않습니다.

표적 마스크를 B배 한 뒤 반지름 b의 정규화된 원판으로 합성곱하고 `irradianceScale`을 곱합니다. 무한한 스크린에 대한 선형 영상 적분은 `표적 면적 × collectedRelative`가 됩니다. 따라서 D를 18에서 6 mm로 줄이면 수집 광량은 1/9이 됩니다. 실제 48 mm 스크린 밖으로 나간 빛은 잘리며, 남은 영상을 다시 밝게 정규화하지 않습니다.

`linear`에는 이 선형 상대 밝기가 들어갑니다. `rgba`는 모든 조건에서 같은 노출과 같은 표시 변환을 사용합니다.

```text
노출 후 값 = 1 − exp(−1.2 · linear)
표시 값 = 표준 sRGB 전달 함수를 적용한 8비트 회색값
```

밝은 값의 포화와 sRGB 변환 때문에 화면의 8비트 값 자체가 광량에 정비례하지는 않습니다. 조리개·거리 비교의 수치는 선형 모형 값을 사용해야 합니다. 원본 표적과 투영의 검은 배경은 밝기가 0인 영역입니다.

## 원본 표적과 수치 적분

표적은 직접 만든 화살표와 오른쪽 위의 사각형입니다. 1.5×4.5 mm 줄기, 밑변 4.5 mm·높이 4 mm 삼각형, 1.5×1.5 mm 사각형의 서로 겹치지 않는 면적을 합치면 18 mm²입니다. 비대칭 표식으로 가로·세로 반전을 함께 확인합니다.

유한한 흐림은 각 볼록 다각형과 원판의 교집합 면적으로 계산합니다. 원과 교차하는 변을 나누고 삼각형·부채꼴의 부호 있는 면적을 더하는 해석적 적분입니다. 표적 이미지의 흐림 필터나 미리 그린 허상을 대신 붙이지 않습니다. 무한대·허상 조건도 동일한 실제 출사 광선의 스크린 분포를 사용합니다.

픽셀 면적은 가로·세로 각각 1/4, 3/4 위치의 네 표본으로 근사합니다. 기본 해상도는 192×192이며 스크린 픽셀 간격은 0.25 mm입니다. b가 픽셀 간격의 10⁻⁵보다 작으면 수치적으로 매우 작은 원판으로 나누는 대신 선명한 마스크를 표본화합니다. 이는 래스터 계산의 극소 흐림 처리이며, 반환되는 실제 흐림 반지름이나 초점 판정을 변경하지 않습니다.

원판 면적 계산과 달리 픽셀 적분은 근사입니다. 매우 가느다란 표식·작은 배율에서는 계단 현상과 선형 합계의 오차가 커질 수 있습니다. 192 픽셀의 시험 조건에서 초점상의 면적·중심·분산, 조리개 9배 광량 차이, 원판 분산 b²/4를 독립 값과 대조합니다. 부분 경계는 동공의 균일 면적 표본과 비교하고, 스크린 잘림은 표적에서 출발한 광선을 별도로 추적해 검증합니다. 이런 허용오차는 시험한 조건의 수치 검증이며 모든 입력에 대한 오차 상한은 아닙니다.

## 코드 연결 계약

`src/physics.js`는 DOM과 Three.js에 의존하지 않습니다.

- `CONFIG_BOUNDS`, `DEFAULT_CONFIG`, `MODEL_VERSION`: 변경할 수 없는 입력 경계와 모형 식별자입니다.
- `normalizeConfig(input)`: 현재 조작값을 기본값·범위 안으로 정리합니다. 허용 초점 거리가 아니면 가장 가까운 값을 선택하며 같은 거리이면 작은 값을 선택합니다.
- `assertConfig(config)`: 정확한 네 키, 유한한 숫자, 범위와 초점 거리 열거값을 검사합니다. 원본을 변경하거나 잘못된 파일 값을 보정하지 않습니다. 성공 시 원본을 반환하고 실패 시 `TypeError` 또는 `RangeError`를 냅니다.
- `solveOptics(config)`: `{modelVersion, config, image, screen, light}`를 반환합니다. `image`는 `{kind,distanceMm,magnification,onBench}`, `screen`은 `{pupilScale,objectScale,blurRadiusMm,irradianceScale}`, `light`는 `{collectedRelative}`입니다.
- `traceRay(config, objectPoint, pupilPoint)`: 각 점은 `{horizontalMm,verticalMm}`이며 표적점은 각 축 ±6 mm, 동공점은 반지름 D/2 안에 있어야 합니다. 동공 경계 10⁻¹⁰ mm 이내의 부동소수점 초과만 원 안으로 되돌립니다. `{object,pupil,screen,outgoingSlope}`를 반환합니다. 세 점은 `{xMm,yMm,zMm}`, 기울기는 `{yPerX,zPerX}`입니다.

`src/projection.js`의 `makeTarget({size=192})`, `makeProjection(solution,{size=192})`는 매번 독립적인 버퍼를 반환합니다. `size`는 16–512의 정수입니다. 반환값은 `{width,height,physicalWidthMm,physicalHeightMm,linear,rgba}`이고 배열 형식은 각각 `Float32Array`, `Uint8ClampedArray`입니다. 첫 행이 양의 세로 방향이고 열은 가로 방향으로 증가합니다. `makeProjection`은 현재 `solveOptics` 결과의 도출값이 입력 설정과 일치하는지도 검사합니다. 2D 검사 화면과 3D 스크린은 이 같은 `rgba`를 사용해야 합니다.

카메라·선택·라벨 변경은 광학 입력이 아니므로 재계산할 필요가 없습니다. 투영 버퍼는 네 설정값을 키로 재사용할 수 있습니다. CPU 시간은 기기와 조건에 따라 다르며, 큰 해상도의 계산은 픽셀 수에 따라 늘어납니다.

## 적용 한계와 확인 명령

렌즈의 실제 두께·재질·곡률에 따른 면별 굴절, 색수차·구면수차, 회절·간섭, 파장, 조리개 날 모양, 센서 잡음과 눈의 적응은 계산하지 않습니다. 유리 외형과 광선의 밝은 선은 구조 설명용 표현입니다. 특히 조리개를 줄일수록 무조건 실제 광학 해상도가 좋아진다는 결론은 이 모형의 범위를 벗어납니다. 단일 렌즈와 정지 표적의 즉시 평형 관계만 다루며 시간·광속 애니메이션 상태는 없습니다.

```sh
node --test tests/physics.test.mjs tests/projection.test.mjs
```

물리·투영 단위 검사는 광학 관계와 수치 적분을 확인합니다. 실제 앱의 조작, 3D 텍스처 방향, 파일 저장, 설치 동작과 시각적 가독성은 별도의 통합 검사가 필요합니다.

## 1.1 상세 관찰: 출사 광선과 스크린 위치 허용 범위

`src/detail-model.js`는 기존 해의 관찰값만 도출합니다. 모형 식별자, 네 광학 입력, 저장 형식과 투영 버퍼 계산은 바꾸지 않습니다. 모든 길이는 기존 광학 API와 같이 mm이며, 3D 외형에서 가져온 치수만 m에서 mm로 변환합니다.

`lensDetail(config, solution = solveOptics(config), {blurRadiusLimitMm = 0.1} = {})`는 정확한 설정과 그 설정의 해가 일치하는지 검증하고 다음 독립 객체를 반환합니다. 설정·해를 수정하거나 범위 밖 입력을 보정하지 않습니다.

| 객체 | 필드와 의미 |
| --- | --- |
| `aperture` | `diameterMm`, `radiusMm`, `areaMm2 = π(D/2)²`, `fNumber = f/D` |
| `bundle` | `kind: converging / parallel / diverging`, 부호 있는 `vergencePerMm = q` |
| `image` | 기존 `kind`, `distanceMm`, `magnification`, `onBench`의 복사본과 `realFocusOnRail` |
| `screen` | `distanceMm`, 부호 있는 `pupilScale = C`, `centerScale = B`, `blurRadiusMm`, `blurDiameterMm` |
| `light` | 기존 `collectedRelative`와 `irradianceScale`의 복사본 |
| `focusTolerance` | `blurRadiusLimitMm`, `pupilScaleLimit`, `forwardRangeMm`, `railRangeMm`, `railWidthMm`, `containsScreen` |

출사 광선의 수렴도는 `q = 1/f − 1/u = (u−f)/(fu)`입니다. 계산은 u≈f에서 거의 같은 역수의 차를 피하기 위해 뒤 식을 사용합니다. 같은 표적점에서 나온 광선에 대해 q>0은 렌즈 뒤 수렴, q=0은 평행, q<0은 발산을 뜻합니다. 서로 다른 표적점의 평행 광선 방향이 같다는 뜻은 아닙니다. `screen.pupilScale`은 기존 해의 `1+s/u−s/f`를 그대로 사용하며, 이상적인 관계에서는 `C = 1−sq`입니다. 스크린이 실상 초점면을 지난 경우 C의 부호가 바뀌지만 렌즈에서 출사하는 광선의 분류 q는 바뀌지 않습니다.

흐림 **반지름** 기준 c에 대해 허용 스크린 위치는 다음 부등식으로 정합니다.

```text
ε = 2c/D
b(s) ≤ c  ⇔  |1−sq| ≤ ε
q > 0:  (1−ε)/q ≤ s ≤ (1+ε)/q
```

`forwardRangeMm`는 위 부등식의 s≥0 부분이고, `railRangeMm`는 다시 실제 스크린 이동 범위 [100,900] mm와 교차한 구간입니다. 구간은 `{minMm,maxMm}`, 없으면 `null`입니다. 레일 안 구간 폭은 없으면 0이며, 상의 위치 v 자체는 레일 끝으로 자르지 않습니다. 실상 초점이 900 mm보다 조금 멀어도 그 앞쪽 허용 구간이 레일에 걸칠 수 있습니다. 반대로 기존 `image.onBench`는 |v|≤900 조건이므로 허상에도 참일 수 있습니다. `realFocusOnRail`은 실상 여부와 실제 스크린 범위를 함께 확인합니다.

앱의 고정 기준 c=0.1 mm는 모든 지원 구경의 반지름보다 작습니다. 따라서 u=f의 평행 광선과 u<f의 발산 광선에는 허용 전방 스크린 구간이 없습니다. API 자체는 유한한 0 이상의 다른 기준도 정확히 처리합니다. ε≥1이면 q=0에서 전방 전체가 허용되고, q<0에서는 `0 ≤ s ≤ (ε−1)/(−q)`가 됩니다. 전방 구간의 무한 상한은 `maxMm:null`로 나타내며 레일과 교차한 구간은 항상 유한합니다. `containsScreen`은 현재 반지름을 기준과 비교할 때 원래 C 계산의 상쇄에서 생기는 부동소수점 오차만 허용합니다. 표시 반올림이나 래스터 해상도로 허용 구간을 늘리지 않습니다.

기본 f=150, u=300, D=18 mm에서 허용 스크린 위치는 약 296.666667–303.333333 mm입니다. D=6 mm로 바꾸면 290–310 mm로 넓어지며 수집 광량은 1/9로 줄어듭니다. 이는 **현재 물체거리를 고정한 스크린 위치 허용 범위**입니다. 물체거리의 피사계심도, 회절 한계나 실제 렌즈 해상도가 아닙니다. 명목 f/D 역시 유한 물체거리·현재 스크린 분포를 생략한 실제 밝기나 수치개구를 뜻하지 않습니다.

`describeLensDetail(partId, config, solution)`는 14개 부품 각각에 최대 6개의 `{label,value,unit,digits}`와 `note`를 반환합니다. 이상 상의 배율 m과 현재 스크린의 중심 배율 B, 상대 수집 광량과 선형 영상에 곱하는 배율 인자를 구분합니다. 무한대의 상 위치·배율은 숫자 무한대를 만들지 않고 설명 문자열로 표시합니다. 전원선에는 계산하지 않는 전압·전류·광원 출력값을 추가하지 않습니다.

새 검사는 광선 중심·동공 경계에서 상세값을 재구성하고, 허용 구간 양 끝과 바깥의 광선 간격, 레일 밖 초점, 초점거리의 바로 이웃 부동소수점 입력, 구경의 면적·광량·허용 폭 관계, 선형 래스터 적분과 잘림, 동결 입력과 반환 객체의 독립성을 확인합니다.

```sh
node --test tests/physics.test.mjs tests/projection.test.mjs tests/geometry.test.mjs tests/detail-model.test.mjs
```
