import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { targetGeometry, traceRay } from './physics.js';
import { COMPONENTS, DEFAULT_VIEW, GEOMETRY as G, carriagePositions, opticalPointToWorld, rasterPlane } from './geometry.js';
import { MECHANICAL as M, rulerTickPixel, rulerWorldToUv, glassGeometry, seatGeometry, finishedRingGeometry, knurledRingGeometry, apertureControlAngle, screenBackingGeometry, rayDisplayClipPlanes } from './mechanical-geometry.js';
import { finishTexture, coatedGlassMaterial, irisPetalGeometry, shapeIrisPetals } from './apparatus-visuals.js';
import './scene.css';

const V = p => new THREE.Vector3(...p), clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const clean = n => Object.is(n, -0) ? 0 : n;
const TAU = Math.PI * 2;
function imageGeometry(width, height, facing) {
  const values = rasterPlane(width, height, facing), geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(values.positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(values.uv, 2)); geometry.setIndex(values.indices); geometry.computeVertexNormals(); return geometry;
}
function ringGeometry(inner, outer, thickness) {
  const shape = new THREE.Shape(); shape.absarc(0, 0, outer, 0, TAU, false);
  const hole = new THREE.Path(); hole.absarc(0, 0, inner, 0, TAU, true); shape.holes.push(hole);
  const geometry = new THREE.ExtrudeGeometry(shape, { depth: thickness, bevelEnabled: false, curveSegments: 64 });
  geometry.translate(0, 0, -thickness / 2); geometry.rotateY(Math.PI / 2); return geometry;
}
function checksum(data) { let result = 2166136261; for (const n of data) result = Math.imul(result ^ n, 16777619); return (result >>> 0).toString(16).padStart(8, '0'); }

export class LensScene {
  constructor(container, { onConfigChange = () => {}, onSelect = () => {}, onCameraChange = () => {} } = {}) {
    this.container = container; this.onConfigChange = onConfigChange; this.onSelect = onSelect; this.onCameraChange = onCameraChange;
    this.view = structuredClone(DEFAULT_VIEW); this.components = new Map(); this.geometries = new Set(); this.materials = new Set(); this.textures = new Set(); this.pointers = []; this.carriageRoofs = []; this.updating = true;
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color('#181f26');
    this.scene.fog = new THREE.Fog(this.scene.background, 1.8, 8);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 1.7)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.0;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.localClippingEnabled = true; this.rayClipPlanes = rayDisplayClipPlanes();
    this.renderer.domElement.setAttribute('aria-label', '표적과 스크린을 끌어 초점을 맞추는 3D 광학 시험대'); this.renderer.domElement.tabIndex = 0;
    this.container.classList.add('lens-scene'); this.container.append(this.renderer.domElement);
    this.camera = new THREE.PerspectiveCamera(35, 1, .001, 30);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement); this.controls.enableDamping = false;
    this.controls.minDistance = .05; this.controls.maxDistance = 10; this.controls.maxPolarAngle = Math.PI;
    this.controls.panSpeed = .6; this.controls.zoomSpeed = .7;
    this.controlsChanged = () => { if (!this.updating && !this.disposed) { this.render(); this.onCameraChange(this.getCameraState()); } };
    this.controls.addEventListener('change', this.controlsChanged);
    const room = new RoomEnvironment(), pmrem = new THREE.PMREMGenerator(this.renderer); this.environment = pmrem.fromScene(room, .04);
    this.scene.environment = this.environment.texture; this.scene.environmentIntensity = .82; room.dispose(); pmrem.dispose();
    this.scene.add(new THREE.HemisphereLight(0xe3ecff, 0x252022, 1.02));
    const key = new THREE.DirectionalLight(0xffefde, 3.0); key.position.set(-.45, 1.7, .7); key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -1.2, right: 1.2, top: .45, bottom: -.45, near: .05, far: 4 }); key.shadow.normalBias = .00045; this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xb6d5ef, 1.6); rim.position.set(.8, .8, -1); this.scene.add(rim);
    this.root = new THREE.Group(); this.scene.add(this.root); this.makeMaterials(); this.buildBench(); this.buildCarriages(); this.buildLens(); this.buildOverlay();
    this.rays = new THREE.Group(); this.root.add(this.rays); this.focusMarker = new THREE.Group(); this.root.add(this.focusMarker);
    this.modelPlane = this.mesh(imageGeometry(.046, .058, -1), this.material({ color: '#80e7dd', transparent: true, opacity: .13, depthWrite: false, side: THREE.DoubleSide }), this.root, [0, G.axisY, 0]); this.modelPlane.userData.nonPickable = true;
    const pupilPoints = Array.from({ length: 129 }, (_, i) => new THREE.Vector3(0, Math.cos(i * TAU / 128), Math.sin(i * TAU / 128)));
    const pupilGeometry = new THREE.BufferGeometry().setFromPoints(pupilPoints), pupilMaterial = new THREE.LineBasicMaterial({ color: '#69ffe8', depthTest: false, toneMapped: false, fog: false });
    this.geometries.add(pupilGeometry); this.materials.add(pupilMaterial); this.pupilGlyph = new THREE.Line(pupilGeometry, pupilMaterial);
    this.pupilGlyph.position.y = G.axisY; this.pupilGlyph.visible = false; this.pupilGlyph.userData.nonPickable = true; this.pupilGlyph.renderOrder = 5; this.root.add(this.pupilGlyph);
    this.root.traverse(object => { if (!object.isMesh) return; let ancestor = object; while (ancestor && !ancestor.userData.partId) ancestor = ancestor.parent; if (ancestor) object.userData.partId = ancestor.userData.partId; });
    this.raycaster = new THREE.Raycaster(); this.pointer = new THREE.Vector2();
    this.pointerDown = event => this.beginPointer(event); this.pointerMove = event => this.movePointer(event); this.pointerUp = event => this.endPointer(event); this.pointerCancel = event => this.endPointer(event, true);
    for (const [name, listener] of [['pointerdown', this.pointerDown], ['pointermove', this.pointerMove], ['pointerup', this.pointerUp], ['pointercancel', this.pointerCancel], ['lostpointercapture', this.pointerCancel]]) this.renderer.domElement.addEventListener(name, listener, true);
    this.resizeObserver = new ResizeObserver(() => this.resize()); this.resizeObserver.observe(container);
    this.targetRoot.position.x = -.3; this.screenRoot.position.x = .36; this.resize(); this.updating = false; this.resetCamera();
  }
  material(values) { const material = new THREE.MeshStandardMaterial({ roughness: .4, metalness: .6, fog: false, ...values }); this.materials.add(material); return material; }
  makeMaterials() {
    const brush = finishTexture(true), grain = finishTexture();
    this.textures.add(brush); this.textures.add(grain);
    const anodized = { metalness: .77, roughness: .47, roughnessMap: grain, bumpMap: grain, bumpScale: .00005 };
    this.mat = {
      steel: this.material({ color: '#aeb9bf', roughness: .32, metalness: .92, roughnessMap: brush, bumpMap: brush, bumpScale: .000004 }),
      machined: this.material({ color: '#83909a', roughness: .36, metalness: .9, roughnessMap: brush }),
      dark: this.material({ color: '#283139', ...anodized }), anodized: this.material({ color: '#161d23', ...anodized }),
      base: this.material({ color: '#343d45', roughness: .7, metalness: .32, bumpMap: grain, bumpScale: .00017 }),
      black: this.material({ color: '#12161a', roughness: .65, metalness: .3 }),
      brass: this.material({ color: '#c4a06b', roughness: .34, metalness: .86, roughnessMap: brush }),
      rubber: this.material({ color: '#15181a', roughness: .92, metalness: 0, bumpMap: grain, bumpScale: .00008 }),
      white: this.material({ color: '#c3cac8', roughness: .83, metalness: 0 }),
      screen: this.material({ color: '#4e4d46', metalness: 0, roughness: .91, bumpMap: grain, bumpScale: .00007, toneMapped: false, side: THREE.DoubleSide }),
      reticle: this.material({ color: '#1d211e', metalness: .1, roughness: .48, toneMapped: false, side: THREE.DoubleSide }),
    };
    this.mat.blades = ['#42494f', '#333b43', '#3b434a'].map(color => this.material({ color, roughness: .53, metalness: .66 }));
    const worktop = grain.clone(); worktop.repeat.set(196, 196); worktop.needsUpdate = true; this.textures.add(worktop);
    this.mat.worktop = this.material({ color: '#21272c', metalness: .06, roughness: .89, bumpMap: worktop, bumpScale: .00015, fog: true });
  }
  mesh(geometry, material, parent, position) {
    this.geometries.add(geometry);
    const clone = original => { const own = original.clone(); this.materials.add(own); return own; };
    const own = Array.isArray(material) ? material.map(clone) : clone(material);
    const mesh = new THREE.Mesh(geometry, own); mesh.castShadow = true; mesh.receiveShadow = true;
    if (position) mesh.position.set(...position); parent.add(mesh); return mesh;
  }
  box(size, material, parent, position) { return this.mesh(new THREE.BoxGeometry(...size), material, parent, position); }
  machinedBox(size, radius, material, parent, position) { return this.mesh(new RoundedBoxGeometry(...size, 1, radius), material, parent, position); }
  cylinder(radius, length, material, parent, position, axis = 'y', segments = 40) {
    const mesh = this.mesh(new THREE.CylinderGeometry(radius, radius, length, segments), material, parent, position);
    if (axis === 'x') mesh.rotation.z = -Math.PI / 2; else if (axis === 'z') mesh.rotation.x = Math.PI / 2; return mesh;
  }
  part(id, anchor, parent = this.root) {
    const node = new THREE.Group(); node.name = id; node.userData.partId = id; parent.add(node);
    this.components.set(id, { ...COMPONENTS.find(p => p.id === id), node, anchor: V(anchor) }); return node;
  }
  bolt(parent, p) { this.cylinder(.0024, .0018, this.mat.steel, parent, p, 'y', 6); this.cylinder(.001, .0019, this.mat.black, parent, p, 'y', 6); }
  textPlate(text, size, parent, position, rotation) {
    const canvas = document.createElement('canvas'); canvas.width = 512; canvas.height = 128; const c = canvas.getContext('2d');
    c.fillStyle = '#1b303b'; c.fillRect(0, 0, 512, 128); c.strokeStyle = '#9eb4bb'; c.strokeRect(4, 4, 504, 120); c.fillStyle = '#dce6e7'; c.font = '600 38px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText(text, 256, 64);
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; this.textures.add(texture);
    const mesh = this.mesh(new THREE.PlaneGeometry(...size), this.material({ map: texture, roughness: .65, metalness: .05 }), parent, position); mesh.rotation.set(...rotation); mesh.userData.nonPickable = true;
  }
  buildBench() {
    const m = this.mat, base = this.part('bench-base', [0, .017, .088]);
    this.machinedBox([1.96, .018, G.baseWidth], .002, m.base, base, [0, .012, 0]);
    this.baseTop = this.machinedBox([1.92, .0025, .180], .0006, m.dark, base, [0, .022, 0]);
    for (const z of [-.093, .093]) this.machinedBox([1.93, .0022, .0016], .0005, m.machined, base, [0, .017, z]);
    for (const x of [-.85, .85]) for (const z of [-.065, .065]) { this.cylinder(.022, .009, m.rubber, base, [x, .001, z]); this.bolt(base, [x, .0241, z]); }
    this.textPlate('LENS LAB  /  광학 시험대', [.118, .012], base, [0, .0105, .0951], [0, 0, 0]);
    const rail = this.part('rail', [.055, G.railTopY, .018]);
    this.railMain = this.machinedBox([1.9, .010, G.railWidth], .00035, m.steel, rail, [0, .029, 0]);
    this.railSupport = this.box([1.9, M.railBottomY - M.baseTopY, .048], m.anodized, rail, [0, (M.railBottomY + M.baseTopY) / 2, 0]);
    this.railGuides = [];
    for (const z of [-.019, .019]) { this.box([1.9, .003, .005], m.anodized, rail, [0, .035, z]); this.railGuides.push(this.machinedBox([1.9, .0015, .002], .00023, m.steel, rail, [0, .037, z])); }
    this.box([1.9, .0006, .012], m.dark, rail, [0, .034, 0]);
    for (const x of [-.953, .953]) this.machinedBox([.008, .016, .053], .001, m.anodized, rail, [x, .032, 0]);
    const ruler = this.part('rail-scale', [.055, .025, .056]);
    const canvas = document.createElement('canvas'); canvas.width = M.rulerPixels; canvas.height = 128; const c = canvas.getContext('2d');
    const finish = c.createLinearGradient(0, 0, 0, canvas.height);
    finish.addColorStop(0, '#414b51'); finish.addColorStop(.1, '#242b30'); finish.addColorStop(.88, '#293136'); finish.addColorStop(1, '#596066');
    c.fillStyle = finish; c.fillRect(0, 0, canvas.width, canvas.height);
    c.font = '600 52px sans-serif'; c.textAlign = 'center';
    this.rulerTicks = [];
    for (let mm = -900; mm <= 900; mm += 10) {
      const x = rulerTickPixel(mm), major = mm % 100 === 0, half = mm % 50 === 0;
      this.rulerTicks.push({ nominalMm: mm, pixelX: x });
      c.fillStyle = mm === 0 ? '#eec48f' : major || half ? '#e5e4db' : '#b0b6b2';
      const width = major ? 6 : half ? 4 : 3;
      c.fillRect(x - width / 2, 5, width, major ? 50 : half ? 34 : 20);
      if (major) c.fillText(mm === 0 ? '0 mm' : String(Math.abs(mm)), x, 107);
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace; texture.anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy()); this.textures.add(texture);
    this.machinedBox([M.rulerLengthM, .001, M.rulerWidthM + .0016], .00025, m.machined, ruler, [0, .0234, .054]);
    const plate = this.mesh(new THREE.PlaneGeometry(M.rulerLengthM, M.rulerWidthM), this.material({ map: texture, metalness: .22, roughness: .68 }), ruler, [0, .024, .054]);
    plate.rotation.x = -Math.PI / 2; plate.castShadow = false; this.rulerPlate = plate;
    const ground = this.mesh(new THREE.PlaneGeometry(28, 28), m.worktop, this.scene, [0, -.004, 0]); ground.rotation.x = -Math.PI / 2; ground.castShadow = false;
  }
  makeCarriage(id, parent, postTop) {
    const node = this.part(id, [0, .046, .046], parent), m = this.mat;
    const roof = this.machinedBox([.052, M.carriageTopY - M.carriageRoofBottomY, .086], .0014, m.anodized, node, [0, (M.carriageTopY + M.carriageRoofBottomY) / 2, 0]);
    const shoes = [];
    for (const sign of [-1, 1]) {
      this.box([.052, M.carriageRoofBottomY - M.shoeTopY, M.shoeWidthM], m.anodized, node, [0, (M.carriageRoofBottomY + M.shoeTopY) / 2, sign * M.shoeCenterZM]);
      shoes.push(this.box([.052, M.shoeTopY - M.shoeBottomY, M.shoeWidthM], m.brass, node, [0, (M.shoeTopY + M.shoeBottomY) / 2, sign * M.shoeCenterZM]));
    }
    this.carriageRoofs.push({ id, roof, shoes });
    this.machinedBox([.042, .003, .069], .0007, m.machined, node, [0, .054, 0]);
    this.cylinder(.006, postTop - .055, m.steel, node, [0, (.055 + postTop) / 2, 0]);
    this.cylinder(.009, .017, m.anodized, node, [0, .064, 0]);
    this.cylinder(.0095, .0017, m.machined, node, [0, .072, 0]);
    this.cylinder(.003, .017, m.steel, node, [0, .046, .050], 'z');
    const knob = this.mesh(knurledRingGeometry(.003, .008, .009), m.brass, node, [0, .046, .061]); knob.rotation.y = -Math.PI / 2;
    // A physical pointer and hairline mark the carriage's X datum on the scale.
    this.box([.006, .0128, .0012], m.steel, node, [0, .0311, .0438]);
    const pointerShape = new THREE.Shape(); pointerShape.moveTo(-.003, 0); pointerShape.lineTo(.003, 0); pointerShape.lineTo(0, .007); pointerShape.closePath();
    const pointerGeometry = new THREE.ExtrudeGeometry(pointerShape, { depth: .0004, bevelEnabled: false }); pointerGeometry.rotateX(Math.PI / 2);
    const pointer = this.mesh(pointerGeometry, m.brass, node, [0, .0249, .0432]);
    const hairline = this.box([.00018, .00004, .0048], m.black, node, [0, .02493, .0466]); this.pointers.push({ id, pointer, hairline });
    for (const x of [-.018, .018]) for (const z of [-.030, .030]) this.bolt(node, [x, .055, z]); return node;
  }
  buildCarriages() {
    const m = this.mat; this.targetRoot = new THREE.Group(); this.screenRoot = new THREE.Group(); this.root.add(this.targetRoot, this.screenRoot);
    this.makeCarriage('target-carriage', this.targetRoot, .105); this.makeCarriage('screen-carriage', this.screenRoot, .101); this.makeCarriage('lens-carriage', this.root, .111);
    const housing = this.part('target-housing', [-.018, .156, .022], this.targetRoot);
    this.machinedBox([.034, .060, .050], .0023, m.anodized, housing, [-.019, G.axisY, 0]);
    this.machinedBox([.003, .053, .046], .0007, m.machined, housing, [-.0017, G.axisY, 0]);
    this.machinedBox([.0024, .034, .039], .0006, m.black, housing, [-.0014, G.axisY, 0]);
    this.machinedBox([.0014, .023, .036], .00035, m.reticle, housing, [-.0008, G.axisY, 0]);
    for (const y of [-.022, .022]) for (const z of [-.0185, .0185]) this.cylinder(.0016, .002, m.steel, housing, [-.0002, G.axisY + y, z], 'x', 6);
    for (const x of [-.030, -.026, -.022, -.018, -.014, -.010]) this.machinedBox([.0017, .020, .0015], .00055, m.black, housing, [x, G.axisY + .004, .025]);
    this.textPlate('발광 표적', [.025, .012], housing, [-.019, .1601, .000], [-Math.PI / 2, 0, Math.PI / 2]);
    const pattern = this.part('target-pattern', [0, G.axisY + .003, 0], this.targetRoot);
    this.targetPattern = pattern;
    this.targetMesh = this.mesh(imageGeometry(G.targetWidth, G.targetHeight, 1), m.reticle, pattern, [0, G.axisY, 0]); this.targetMesh.castShadow = false;
    const frame = this.part('screen-frame', [.003, G.axisY + .031, .022], this.screenRoot);
    for (const y of [-.029, .029]) this.machinedBox([.008, .009, .066], .001, m.anodized, frame, [.0035, G.axisY + y, 0]);
    for (const z of [-.029, .029]) this.machinedBox([.008, .050, .009], .001, m.anodized, frame, [.0035, G.axisY, z]);
    this.machinedBox([.003, .055, .055], .0007, m.dark, frame, [.0035, G.axisY, 0]);
    for (const y of [-.029, .029]) for (const z of [-.0285, .0285]) this.cylinder(.00125, .0012, m.machined, frame, [-.0004, G.axisY + y, z], 'x', 6);
    const screen = this.part('screen-surface', [0, G.axisY + .010, 0], this.screenRoot);
    // The optical raster remains at X=0; the substrate joins the rear frame.
    this.screenBacking = this.mesh(screenBackingGeometry(), m.white, screen, [0, G.axisY, 0]);
    this.screenMesh = this.mesh(imageGeometry(G.screenWidth, G.screenHeight, -1), m.screen, screen, [0, G.axisY, 0]); this.screenMesh.castShadow = false;
    const cable = this.part('power-cable', [-.06, .030, -.06], this.targetRoot);
    const points = [[-.036, G.axisY, 0], [-.050, .125, -.006], [-.058, .050, -.030], [-.080, .025, -.064], [-.150, .025, -.068], [-.180, .026, -.060]].map(V);
    this.mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), 64, .002, 10, false), m.rubber, cable);
    this.cylinder(.004, .009, m.black, cable, [-.039, G.axisY, 0], 'x');
    for (const x of [-.040, -.043, -.046]) this.cylinder(.0034, .0011, m.rubber, cable, [x, G.axisY - (Math.abs(x) - .040) * .85, 0], 'x');
  }
  buildLens() {
    const ring = this.part('lens-ring', [0, G.axisY + .019, .008]), m = this.mat;
    this.mesh(finishedRingGeometry(M.barrelBoreRadiusM, G.lensRingRadius, .006), this.mat.anodized, ring, [0, G.axisY, 0]);
    for (const x of [-.0035, .0035]) this.mesh(finishedRingGeometry(.013, .019, .001, .00009), m.dark, ring, [x, G.axisY, 0]);
    this.mesh(finishedRingGeometry(.0177, .0182, .00036, .00008), m.machined, ring, [.00395, G.axisY, 0]);
    this.mesh(finishedRingGeometry(.0219, .02235, .0042, .0001), m.anodized, ring, [0, G.axisY, 0]);
    this.machinedBox([.010, .007, .013], .0015, m.anodized, ring, [0, .108, 0]);
    this.seats = [-1, 1].map(side => ({ side, mesh: this.mesh(seatGeometry(side), this.mat.anodized, ring, [0, G.axisY, 0]) }));
    for (let i = 0; i < 3; i++) { const a = i * TAU / 3; this.cylinder(.00125, .008, m.machined, ring, [0, G.axisY + .0208 * Math.cos(a), .0208 * Math.sin(a)], 'x', 6); }
    const glass = this.part('lens-glass', [0, G.axisY + .006, .006]);
    const glassMaterial = coatedGlassMaterial(); this.materials.add(glassMaterial);
    this.glassMesh = this.mesh(glassGeometry(), glassMaterial, glass, [0, G.axisY, 0]); this.glassMesh.castShadow = false;
    this.glassMesh.renderOrder = 2;
    const iris = this.part('iris', [-.004, G.axisY + .011, .006]);
    this.irisMesh = this.mesh(ringGeometry(.009, .0132, M.irisThicknessM), m.black, iris, [M.irisPlaneXM, G.axisY, 0]);
    this.irisPetals = this.mesh(irisPetalGeometry(), m.blades, iris, [M.irisPlaneXM, G.axisY, 0]);
    this.irisPetals.castShadow = false; this.irisPetals.userData.nonPickable = true;
    shapeIrisPetals(this.irisPetals.geometry, .009, M.irisThicknessM / 2, apertureControlAngle(18));
    this.mesh(finishedRingGeometry(.0196, .022, .0015, .0001), m.anodized, iris, [-.00375, G.axisY, 0]);
    this.irisControl = new THREE.Group(); this.irisControl.position.y = G.axisY; iris.add(this.irisControl);
    this.mesh(knurledRingGeometry(.013, .0195, .0012, 72), m.machined, this.irisControl, [-.00435, 0, 0]);
    this.irisKnob = this.mesh(knurledRingGeometry(.0008, .0027, .003, 24), m.brass, this.irisControl, [-.0062, .0175, 0]);
    this.cylinder(.0008, .0036, m.steel, this.irisControl, [-.0060, .0175, 0], 'x');
    for (const diameter of [6, 9, 12, 15, 18]) {
      const angle = apertureControlAngle(diameter);
      const major = diameter % 6 === 0;
      const tick = this.box([.00008, major ? .0013 : .00075, .00017], m.white, iris, [-.00455, G.axisY + .0204 * Math.cos(angle), .0204 * Math.sin(angle)]); tick.rotation.x = angle;
      if (major) this.textPlate(String(diameter), [.0021, .0015], iris, [-.00458, G.axisY + .0212 * Math.cos(angle), .0212 * Math.sin(angle)], [0, -Math.PI / 2, 0]);
    }
    this.apertureRadius = .009;
  }
  buildOverlay() {
    this.overlay = document.createElement('div'); this.overlay.className = 'lens-scene-overlay'; this.container.append(this.overlay);
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); this.svg.classList.add('lens-label-lines'); this.overlay.append(this.svg); this.labels = new Map();
    for (const part of COMPONENTS) {
      const button = document.createElement('button'); button.className = 'lens-part-label'; button.dataset.partId = part.id; button.textContent = part.name; button.type = 'button'; button.hidden = true;
      button.addEventListener('click', () => this.select(part.id)); this.overlay.append(button);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'g'); line.style.display = 'none'; this.svg.append(line);
      const halo = document.createElementNS('http://www.w3.org/2000/svg', 'path'); halo.classList.add('lens-leader-halo'); line.append(halo);
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path'); path.classList.add('lens-leader'); line.append(path);
      const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle'); dot.classList.add('lens-leader-dot'); dot.setAttribute('r', '3'); line.append(dot);
      this.labels.set(part.id, { button, line, halo, path, dot });
    }
    this.note = document.createElement('div'); this.note.className = 'lens-scene-note'; this.overlay.append(this.note);
    this.focusReadout = document.createElement('div'); this.focusReadout.className = 'lens-focus-readout'; this.overlay.append(this.focusReadout);
  }
  setRaster(mesh, raster, key) {
    if (!raster || this[key]?.raster === raster) return;
    if (!Number.isInteger(raster.width) || !Number.isInteger(raster.height) || raster.rgba.length !== raster.width * raster.height * 4) throw new TypeError('Invalid shared raster');
    if (this[key]) { this.textures.delete(this[key].texture); this[key].texture.dispose(); }
    const texture = new THREE.DataTexture(raster.rgba, raster.width, raster.height, THREE.RGBAFormat); texture.flipY = false; texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter; texture.magFilter = THREE.LinearFilter; texture.generateMipmaps = false; texture.needsUpdate = true; this.textures.add(texture);
    // The shared raster supplies the pattern or projected irradiance as an
    // emissive contribution over the separately lit matte substrate.
    mesh.material.emissive.set('#ffffff'); mesh.material.emissiveMap = texture; mesh.material.needsUpdate = true;
    this[key] = { texture, raster, checksum: checksum(texture.image.data) };
  }
  clearLines(group) { for (const child of [...group.children]) { child.geometry?.dispose(); child.material?.dispose(); group.remove(child); } }
  line(points, color, parent, dashed = false, opacity = 1) {
    const geometry = new THREE.BufferGeometry().setFromPoints(points.map(V));
    const style = { color, transparent: true, opacity, toneMapped: false, depthWrite: false, fog: false };
    const material = dashed ? new THREE.LineDashedMaterial({ ...style, dashSize: .008, gapSize: .005, depthTest: false }) : new THREE.LineBasicMaterial(style);
    if (parent === this.rays) { material.clippingPlanes = this.rayClipPlanes; material.clipIntersection = true; }
    const line = new THREE.Line(geometry, material); if (dashed) line.computeLineDistances(); line.renderOrder = dashed ? 4 : 3; line.userData.nonPickable = true; parent.add(line); return line;
  }
  updateRays(solution) {
    this.clearLines(this.rays); this.clearLines(this.focusMarker); this.rayLines = []; this.focusMarkerPoints = [];
    const r = solution.config.apertureDiameterMm / 2;
    const { scale, horizontalOffsetMm } = targetGeometry(solution.config);
    for (const [x, y, color] of [[0, 3, '#ffd69b'], [3.25, 2.25, '#84edf5']]) {
      const objectPoint = { horizontalMm: x * scale + horizontalOffsetMm, verticalMm: y * scale };
      for (const pupil of [{ horizontalMm: 0, verticalMm: 0 }, { horizontalMm: r * .8, verticalMm: r * .6 }, { horizontalMm: -r * .8, verticalMm: -r * .6 }]) {
        const ray = traceRay(solution.config, objectPoint, pupil), points = [ray.object, ray.pupil, ray.screen].map(opticalPointToWorld);
        this.rayLines.push(this.line(points, color, this.rays, false, .86));
        if (solution.image.kind === 'virtual') {
          const x = Math.max(G.railX[0] * 1000, solution.image.distanceMm);
          const back = opticalPointToWorld({ xMm: x, yMm: ray.pupil.yMm + x * ray.outgoingSlope.yPerX, zMm: ray.pupil.zMm + x * ray.outgoingSlope.zPerX });
          this.line([points[1], back], color, this.rays, true, .74);
        }
      }
    }
    if (solution.image.kind !== 'infinity' && solution.image.onBench) {
      const x = solution.image.distanceMm / 1000, c = solution.image.kind === 'virtual' ? '#71dbe6' : '#ffc477';
      this.focusMarkerPoints = [[x, G.axisY - .022, -.024], [x, G.axisY + .022, -.024], [x, G.axisY + .022, .024], [x, G.axisY - .022, .024], [x, G.axisY - .022, -.024]];
      this.line(this.focusMarkerPoints, c, this.focusMarker, true, .82);
    }
  }
  update(solution, view, { projection, target } = {}) {
    if (this.disposed) return; this.updating = true;
    const previous = this.solution?.config; this.solution = solution; this.view = { ...DEFAULT_VIEW, ...view };
    const positions = carriagePositions(solution.config); this.targetRoot.position.x = positions.targetX; this.screenRoot.position.x = positions.screenX;
    const targetShape = targetGeometry(solution.config);
    this.targetPattern.position.z = targetShape.horizontalOffsetMm / 1000;
    this.targetMesh.scale.set(1, targetShape.scale, targetShape.scale);
    const radius = solution.config.apertureDiameterMm / 2000;
    const adjustment = apertureControlAngle(solution.config.apertureDiameterMm);
    if (radius !== this.apertureRadius) {
      const old = this.irisMesh.geometry; this.geometries.delete(old); old.dispose();
      this.irisMesh.geometry = ringGeometry(radius, .0132, M.irisThicknessM); this.geometries.add(this.irisMesh.geometry);
      shapeIrisPetals(this.irisPetals.geometry, radius, M.irisThicknessM / 2, adjustment);
      this.apertureRadius = radius;
    }
    this.irisControl.rotation.x = adjustment;
    this.pupilGlyph.scale.setScalar(radius); this.pupilGlyph.visible = this.view.structure;
    this.setRaster(this.screenMesh, projection, 'screenRaster'); this.setRaster(this.targetMesh, target, 'targetRaster');
    if (!previous || [...Object.keys(previous), ...Object.keys(solution.config)].some(key => solution.config[key] !== previous[key])) this.updateRays(solution);
    this.rays.visible = this.view.rays; this.focusMarker.visible = this.view.focus; this.modelPlane.visible = this.view.structure;
    this.highlight(); this.note.textContent = this.view.structure ? '청록 원: 계산 구경 0 mm · 조리개 −3 mm와 코팅은 구조 표현 · 내부 광선 생략'
      : '표적·스크린을 끌어 이동 · 조립체 내부 광선은 표시를 생략합니다';
    const image = solution.image;
    this.focusReadout.textContent = image.kind === 'infinity' ? '유한 초점 없음 · 출사 광선 평행' : `${image.kind === 'virtual' ? '허상 · 역연장 위치' : '실상 위치'} ${image.distanceMm.toFixed(1)} mm${image.onBench ? '' : ' · 레일 밖'}`;
    this.focusReadout.hidden = !this.view.focus; this.updating = false; this.render();
  }
  highlight() {
    this.glassMesh.material.uniforms.selection.value = Number(this.view.selectedPart === 'lens-glass');
    this.root.traverse(object => {
      if (!object.isMesh || !object.userData.partId || !object.material.emissive || object === this.screenMesh || object === this.targetMesh) return;
      const selected = object.userData.partId === this.view.selectedPart;
      object.material.emissive.set(selected ? '#286573' : '#000000');
      object.material.emissiveIntensity = selected ? .38 : 0;
    });
  }
  select(id) { if (!this.components.has(id)) return; this.view.selectedPart = id; this.highlight(); this.render(); this.onSelect(id); }
  pointerRay(event) {
    const rect = this.renderer.domElement.getBoundingClientRect(); this.pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
    this.raycaster.setFromCamera(this.pointer, this.camera); return this.raycaster;
  }
  pick(event) { return this.pointerRay(event).intersectObject(this.root, true).find(hit => hit.object.isMesh && hit.object.userData.partId && !hit.object.userData.nonPickable); }
  beginPointer(event) {
    if (event.button !== 0 || this.drag || !this.solution) return;
    const hit = this.pick(event); this.down = { x: event.clientX, y: event.clientY, id: hit?.object.userData.partId };
    if (!hit) return; const id = hit.object.userData.partId, kind = id.startsWith('target-') ? 'target' : id.startsWith('screen-') ? 'screen' : null;
    if (!kind) return;
    const normal = this.camera.position.clone().sub(this.controls.target); normal.x = 0; if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0); normal.normalize();
    this.drag = { pointerId: event.pointerId, kind, startX: hit.point.x, initial: kind === 'target' ? this.targetRoot.position.x : this.screenRoot.position.x,
      plane: new THREE.Plane().setFromNormalAndCoplanarPoint(normal, hit.point), moved: false };
    this.controls.enabled = false; this.renderer.domElement.setPointerCapture(event.pointerId); this.container.classList.add('is-dragging'); event.preventDefault(); event.stopImmediatePropagation();
  }
  movePointer(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    const point = this.pointerRay(event).ray.intersectPlane(this.drag.plane, new THREE.Vector3()); if (!point) return;
    if (Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) < 3 && !this.drag.moved) return;
    this.drag.moved = true; const x = this.drag.initial + point.x - this.drag.startX;
    const key = this.drag.kind === 'target' ? 'objectDistanceMm' : 'screenDistanceMm', distance = clamp(Math.round(x * 10000 * (this.drag.kind === 'target' ? -1 : 1)) / 10, 100, 900);
    // An earlier move may still be queued for this frame. Returning to the
    // displayed distance must replace it, not leave the stale value pending.
    this.onConfigChange({ [key]: distance }); event.preventDefault(); event.stopImmediatePropagation();
  }
  endPointer(event, canceled = false) {
    if (this.drag) {
      if (event.pointerId !== this.drag.pointerId) return;
      const drag = this.drag; this.drag = null; this.controls.enabled = true; this.container.classList.remove('is-dragging');
      if (this.renderer.domElement.hasPointerCapture(drag.pointerId)) this.renderer.domElement.releasePointerCapture(drag.pointerId);
      if (!canceled && !drag.moved && this.down?.id) this.select(this.down.id); this.down = null; event.stopImmediatePropagation(); return;
    }
    if (!canceled && this.down && Math.hypot(event.clientX - this.down.x, event.clientY - this.down.y) <= 4 && this.down.id) this.select(this.down.id); this.down = null;
  }
  layoutLabels() {
    if (!this.width) return; this.root.updateMatrixWorld(true);
    for (const [id, label] of this.labels) { label.button.hidden = true; label.line.style.display = 'none'; label.button.classList.toggle('is-selected', id === this.view.selectedPart); }
    if (!this.view.labels || this.height < 180) return;
    const candidates = [...new Set([this.view.selectedPart, ...(this.focusContext || ['target-pattern', 'lens-glass', 'screen-surface'])])].slice(0, 4), projected = [];
    for (const id of candidates) { const part = this.components.get(id); if (!part) continue; const p = part.node.localToWorld(part.anchor.clone()).project(this.camera); if (Math.abs(p.x) > 1 || Math.abs(p.y) > 1 || p.z < -1 || p.z > 1) continue; projected.push({ id, x: (p.x + 1) * this.width / 2, y: (1 - p.y) * this.height / 2 }); }
    const width = this.width < 620 ? Math.min(118, this.width * .32) : 148, height = 29, placed = [];
    const intersects = (a, b, gap = 7) => a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
    let opticalArea = null;
    if (this.focusContext?.includes('lens-glass') && this.focusContext?.includes('iris')) {
      const circle = Array.from({ length: 48 }, (_, i) => new THREE.Vector3(0, G.axisY + G.lensRadius * Math.cos(i * TAU / 48), G.lensRadius * Math.sin(i * TAU / 48)).project(this.camera));
      const xs = circle.map(p => (p.x + 1) * this.width / 2), ys = circle.map(p => (1 - p.y) * this.height / 2);
      opticalArea = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
    }
    for (const p of projected) {
      // Keep a label near its own part; screen-edge columns can imply the wrong part.
      const candidates = [];
      for (const dy of [-58, -96, 42, 80, -134, 118]) for (const dx of [0, -width * .65, width * .65, -width, width]) {
        const box = { x: clamp(p.x - width / 2 + dx, 10, this.width - width - 10), y: clamp(p.y + dy, 54, Math.max(54, this.height - 112)), w: width, h: height };
        if (placed.some(other => intersects(box, other))) continue;
        const end = { x: clamp(p.x, box.x + 6, box.x + width - 6), y: clamp(p.y, box.y, box.y + height) };
        const length = Math.hypot(p.x - end.x, p.y - end.y);
        const covered = projected.filter(q => q.x > box.x - 7 && q.x < box.x + width + 7 && q.y > box.y - 7 && q.y < box.y + height + 7).length;
        const ownDistance = Math.hypot(box.x + width / 2 - p.x, box.y + height / 2 - p.y);
        const nearerOther = projected.some(q => q.id !== p.id && Math.hypot(box.x + width / 2 - q.x, box.y + height / 2 - q.y) + 8 < ownDistance);
        candidates.push({ box, end, score: length + Math.abs(dx) * .16 + (dy > 0 ? 12 : 0) + covered * 10000 + (nearerOther ? 1000 : 0) + (opticalArea && intersects(box, opticalArea, 9) ? 100000 : 0) });
      }
      candidates.sort((a, b) => a.score - b.score); const best = candidates[0]; if (!best) continue;
      const { box, end } = best, label = this.labels.get(p.id), d = `M ${p.x} ${p.y} L ${end.x} ${end.y}`; placed.push(box);
      label.button.hidden = false; Object.assign(label.button.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${width}px` });
      label.halo.setAttribute('d', d); label.path.setAttribute('d', d); label.dot.setAttribute('cx', p.x); label.dot.setAttribute('cy', p.y); label.line.style.display = '';
    }
  }
  visiblePoints(node) {
    const result = []; this.root.updateMatrixWorld(true); node.traverseVisible(object => { if (!object.isMesh || object.userData.nonPickable) return; object.geometry.computeBoundingBox(); const b = object.geometry.boundingBox;
      for (const x of [b.min.x, b.max.x]) for (const y of [b.min.y, b.max.y]) for (const z of [b.min.z, b.max.z]) result.push(new THREE.Vector3(x, y, z).applyMatrix4(object.matrixWorld)); }); return result;
  }
  fit(points, direction) {
    if (!points.length) return false; const bounds = new THREE.Box3().setFromPoints(points), target = bounds.getCenter(new THREE.Vector3()), dir = V(direction).normalize();
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize(), up = new THREE.Vector3().crossVectors(dir, right).normalize();
    const tanV = Math.tan(this.camera.fov * Math.PI / 360), tanH = tanV * this.camera.aspect; let distance = .05;
    for (let iteration = 0; iteration < 5; iteration++) {
      const relative = points.map(p => p.clone().sub(target)); distance = .05;
      for (const p of relative) distance = Math.max(distance, p.dot(dir) + Math.abs(p.dot(right)) / (tanH * .80), p.dot(dir) + Math.abs(p.dot(up)) / (tanV * .70));
      if (iteration === 4) break;
      let l = Infinity, r = -Infinity, b = Infinity, t = -Infinity;
      for (const p of relative) { const depth = Math.max(.001, distance - p.dot(dir)), x = p.dot(right) / depth, y = p.dot(up) / depth; l = Math.min(l, x); r = Math.max(r, x); b = Math.min(b, y); t = Math.max(t, y); }
      target.addScaledVector(right, (l + r) * distance / 2).addScaledVector(up, (b + t) * distance / 2);
    }
    this.updating = true; this.camera.zoom = 1; this.camera.updateProjectionMatrix(); this.controls.target.copy(target); this.camera.position.copy(target.clone().addScaledVector(dir, Math.min(10, distance))); this.controls.update(); this.updating = false; this.render(); this.onCameraChange(this.getCameraState()); return true;
  }
  resetCamera(preset = 'iso') {
    if (preset === 'screen') return this.focusPart('screen-surface'); this.focusContext = null;
    const nodes = ['target-housing', 'target-carriage', 'lens-ring', 'lens-carriage', 'screen-frame', 'screen-carriage'];
    const points = nodes.flatMap(id => this.visiblePoints(this.components.get(id).node));
    if (this.view.focus && this.solution?.image.kind === 'virtual') points.push(...this.focusMarkerPoints.map(V));
    return this.fit(points, preset === 'side' ? [0, .08, 1] : [-.22, .44, 1]);
  }
  focusPart(id) {
    if (!this.components.has(id)) return false; let ids = [id], direction = [-.3, .4, 1];
    if (id === 'rail-scale') {
      this.root.updateMatrixWorld(true); const points = [];
      for (const x of [-.10, .10]) for (const y of [-M.rulerWidthM / 2, M.rulerWidthM / 2]) points.push(this.rulerPlate.localToWorld(new THREE.Vector3(x, y, 0)));
      const carriage = this.carriageRoofs.find(c => c.id === 'lens-carriage'), pointer = this.pointers.find(p => p.id === 'lens-carriage');
      points.push(...this.visiblePoints(carriage.roof), ...this.visiblePoints(pointer.pointer));
      this.focusContext = ['rail-scale', 'lens-carriage']; return this.fit(points, [0, 1, 1.5]);
    }
    if (id.startsWith('target-')) { ids = ['target-housing', 'target-pattern', 'target-carriage']; direction = [1, .20, .16]; }
    else if (id.startsWith('screen-')) { ids = ['screen-surface', 'screen-frame']; direction = [-1, .13, .15]; }
    else if (id.startsWith('lens-') || id === 'iris') {
      ids = ['lens-glass', 'lens-ring', 'iris']; if (id === 'lens-carriage') ids.push('lens-carriage');
      direction = [id === 'iris' ? -1 : 1, .20, .5];
    }
    this.focusContext = [...new Set([id, ...ids])].slice(0, 4); return this.fit(ids.flatMap(key => this.visiblePoints(this.components.get(key).node)), direction);
  }
  getCameraState() { return { position: this.camera.position.toArray().map(clean), target: this.controls.target.toArray().map(clean), zoom: clean(this.camera.zoom) }; }
  setCameraState(value) {
    if (!value || ![value.position, value.target].every(p => Array.isArray(p) && p.length === 3 && p.every(n => Number.isFinite(n) && Math.abs(n) <= 100))) return false;
    const position = V(value.position), target = V(value.target), distance = position.distanceTo(target), zoom = value.zoom ?? 1;
    if (distance < .05 - 1e-10 || distance > 10 + 1e-10 || !Number.isFinite(zoom) || zoom < .25 || zoom > 4) return false;
    this.updating = true; this.focusContext = null; this.camera.position.copy(position); this.controls.target.copy(target); this.camera.zoom = zoom; this.camera.updateProjectionMatrix(); this.controls.update(); this.camera.position.copy(position); this.controls.target.copy(target); this.camera.lookAt(target); this.updating = false; this.render(); return true;
  }
  getComponents() { return COMPONENTS.map(p => ({ ...p })); }
  getDebug() {
    this.root.updateMatrixWorld(true); const raster = entry => entry ? { width: entry.texture.image.width, height: entry.texture.image.height, flipY: entry.texture.flipY, checksum: checksum(entry.texture.image.data), physicalWidthMm: entry.raster.physicalWidthMm, physicalHeightMm: entry.raster.physicalHeightMm } : null;
    const corners = mesh => Array.from({ length: 4 }, (_, i) => mesh.localToWorld(new THREE.Vector3().fromBufferAttribute(mesh.geometry.getAttribute('position'), i)).toArray());
    const handles = ['target', 'screen'].map(kind => { const point = this[`${kind}Root`].localToWorld(V([0, .046, .061])), ndc = point.clone().project(this.camera); return { kind, world: point.toArray(), x: (ndc.x + 1) * this.width / 2, y: (1 - ndc.y) * this.height / 2 }; });
    const bounds = mesh => { mesh.geometry.computeBoundingBox(); return mesh.geometry.boundingBox.clone().applyMatrix4(mesh.matrixWorld); };
    const irisBounds = bounds(this.irisMesh), irisPosition = this.irisMesh.geometry.attributes.position;
    const irisRadii = Array.from({ length: irisPosition.count }, (_, i) => Math.hypot(irisPosition.getY(i), irisPosition.getZ(i)));
    const rulerBounds = this.rulerPlate.geometry.boundingBox ?? (this.rulerPlate.geometry.computeBoundingBox(), this.rulerPlate.geometry.boundingBox);
    const rail = bounds(this.railMain), support = bounds(this.railSupport), base = bounds(this.baseTop), backing = bounds(this.screenBacking), guideTop = Math.max(...this.railGuides.map(mesh => bounds(mesh).max.y));
    return { ready: !!this.solution, componentCount: this.components.size, objectX: this.targetRoot.position.x, screenX: this.screenRoot.position.x,
      ruler: { ticks: this.rulerTicks.map(t => ({ ...t, worldXM: this.rulerPlate.localToWorld(new THREE.Vector3(rulerBounds.min.x + (rulerBounds.max.x - rulerBounds.min.x) * t.pixelX / M.rulerPixels, 0, 0)).x })),
        pointers: this.pointers.map(p => { const world = p.hairline.getWorldPosition(new THREE.Vector3()); return { id: p.id, worldXM: world.x, uv: rulerWorldToUv(world.x) }; }) },
      opticalAssembly: { physicalIris: { planeXM: this.irisMesh.getWorldPosition(new THREE.Vector3()).x, throatXRangeM: [irisBounds.min.x, irisBounds.max.x], radiusM: Math.min(...irisRadii) },
        calculationPupil: { planeXM: this.pupilGlyph.getWorldPosition(new THREE.Vector3()).x, radiusM: this.pupilGlyph.scale.y, visible: this.pupilGlyph.visible },
        adjustmentAngleRad: this.irisControl.rotation.x,
        seats: this.seats.map(s => { const p = s.mesh.geometry.attributes.position, radii = Array.from({ length: p.count }, (_, i) => Math.hypot(p.getY(i), p.getZ(i))); return { side: s.side, innerRadiusM: Math.min(...radii), outerRadiusM: Math.max(...radii), bounds: bounds(s.mesh) }; }) },
      rayDisplay: { clipIntervalM: [-M.rayClipHalfLengthM, M.rayClipHalfLengthM], clipIntersection: this.rayLines?.every(line => line.material.clipIntersection) ?? false,
        planes: this.rayLines?.[0]?.material.clippingPlanes.map(plane => ({ normal: plane.normal.toArray(), constant: plane.constant })) ?? [] },
      supports: { railToSupportGapM: rail.min.y - support.max.y, supportToBaseGapM: support.min.y - base.max.y,
        carriages: this.carriageRoofs.map(c => ({ id: c.id, roofBottomYM: bounds(c.roof).min.y, guideClearanceM: bounds(c.roof).min.y - guideTop,
          shoeContactGapsM: c.shoes.map(shoe => bounds(shoe).min.y - rail.max.y) })),
        screenBacking: { frontXM: backing.min.x, rearXM: backing.max.x, widthM: backing.max.z - backing.min.z, heightM: backing.max.y - backing.min.y } },
      apertureRadiusM: this.apertureRadius, rayCount: this.rayLines?.length ?? 0, rays: (this.rayLines || []).map(line => { const p = line.geometry.getAttribute('position'); return [0, 1, 2].map(i => line.localToWorld(new THREE.Vector3().fromBufferAttribute(p, i)).toArray()); }),
      screenTexture: raster(this.screenRaster), targetTexture: raster(this.targetRaster), screenUv: Array.from(this.screenMesh.geometry.getAttribute('uv').array), targetUv: Array.from(this.targetMesh.geometry.getAttribute('uv').array), screenCorners: corners(this.screenMesh), targetCorners: corners(this.targetMesh),
      focus: { kind: this.solution?.image.kind, distanceMm: this.solution?.image.distanceMm, markerVisible: this.focusMarker.visible && this.focusMarker.children.length > 0 },
      dragHandles: handles, dragging: this.drag?.kind ?? null, orbitEnabled: this.controls.enabled,
      labels: [...this.labels].filter(([, l]) => !l.button.hidden).map(([id, l]) => ({ id, left: parseFloat(l.button.style.left), top: parseFloat(l.button.style.top), width: l.button.offsetWidth, height: l.button.offsetHeight, anchor: [Number(l.dot.getAttribute('cx')), Number(l.dot.getAttribute('cy'))] })),
      camera: this.getCameraState(), drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, renderFrame: this.renderer.info.render.frame };
  }
  resize() { if (this.disposed) return; this.width = Math.max(1, this.container.clientWidth); this.height = Math.max(1, this.container.clientHeight); this.renderer.setSize(this.width, this.height, false); this.camera.aspect = this.width / this.height; this.camera.updateProjectionMatrix(); this.render(); }
  render() { if (this.disposed) return; this.camera.updateMatrixWorld(); this.layoutLabels(); this.renderer.render(this.scene, this.camera); }
  dispose() {
    if (this.disposed) return; this.disposed = true; this.resizeObserver.disconnect(); this.controls.removeEventListener('change', this.controlsChanged); this.controls.dispose();
    for (const [name, listener] of [['pointerdown', this.pointerDown], ['pointermove', this.pointerMove], ['pointerup', this.pointerUp], ['pointercancel', this.pointerCancel], ['lostpointercapture', this.pointerCancel]]) this.renderer.domElement.removeEventListener(name, listener, true);
    this.clearLines(this.rays); this.clearLines(this.focusMarker); for (const g of this.geometries) g.dispose(); for (const m of this.materials) m.dispose(); for (const t of this.textures) t.dispose(); this.environment.dispose(); this.renderer.dispose(); this.overlay.remove(); this.renderer.domElement.remove(); this.container.classList.remove('lens-scene', 'is-dragging');
  }
}
