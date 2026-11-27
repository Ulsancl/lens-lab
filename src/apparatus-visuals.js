import * as THREE from 'three';

const TAU = Math.PI * 2;

export function finishTexture(brushed = false) {
  const size = 128, data = new Uint8Array(size * size * 4);
  let seed = 41;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    seed = Math.imul(1664525, seed) + 1013904223 | 0;
    const grain = (seed >>> 24) / 255 - .5;
    const brush = 16 * Math.sin(TAU * 32 * y / size) + 7 * Math.sin(TAU * (2 * x + 19 * y) / size);
    const weave = 8 * Math.sin(TAU * 32 * x / size) * Math.sin(TAU * 32 * y / size);
    const tone = 185 + grain * (brushed ? 12 : 36) + (brushed ? brush : weave);
    const i = (y * size + x) * 4;
    data[i] = data[i + 1] = data[i + 2] = tone;
    data[i + 3] = 255;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

// Reflections describe the installed glass surfaces. Ray direction and screen
// exposure continue to come from the thin-lens solution and projection raster.
export function coatedGlassMaterial() {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    uniforms: { selection: { value: 0 } },
    vertexShader: `
      varying vec3 worldNormal;
      varying vec3 worldPosition;
      void main() {
        worldNormal = mat3(modelMatrix) * normal;
        worldPosition = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 worldNormal;
      varying vec3 worldPosition;
      uniform float selection;

      float softbox(vec3 reflection, vec3 center, vec2 size) {
        vec3 across = normalize(cross(vec3(0.0, 1.0, 0.0), center));
        vec3 up = cross(center, across);
        vec2 d = abs(vec2(dot(reflection, across), dot(reflection, up))) / size;
        return (1.0 - smoothstep(0.72, 1.15, max(d.x, d.y))) * step(0.0, dot(reflection, center));
      }

      void main() {
        vec3 n = normalize(worldNormal);
        vec3 eye = normalize(cameraPosition - worldPosition);
        vec3 reflection = reflect(-eye, n);
        float cosine = max(0.0, dot(n, eye));
        float grazing = pow(1.0 - cosine, 2.5);
        float key = max(softbox(reflection, normalize(vec3(0.91, 0.14, -0.42)), vec2(0.23, 0.06)),
                        softbox(reflection, normalize(vec3(-0.91, 0.14, -0.42)), vec2(0.23, 0.06)));
        float strip = max(softbox(reflection, normalize(vec3(0.79, 0.02, 0.61)), vec2(0.10, 0.04)),
                          softbox(reflection, normalize(vec3(-0.79, 0.02, 0.61)), vec2(0.10, 0.04)));
        vec3 tint = mix(vec3(0.035, 0.15, 0.13), vec3(0.21, 0.065, 0.29), smoothstep(0.0, 0.66, 1.0 - cosine));
        vec3 color = tint + key * vec3(1.2, 1.08, 0.88) + strip * vec3(0.61, 0.85, 1.2) + selection * vec3(0.0, 0.055, 0.07);
        float opacity = min(0.84, 0.15 + 0.60 * grazing + 0.60 * key + 0.48 * strip);
        gl_FragColor = vec4(color, opacity);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

const PETALS = 9, RADIAL_STEPS = 7, ARC_STEPS = 8;

export function irisPetalGeometry() {
  const geometry = new THREE.BufferGeometry();
  const groups = [[], [], []];
  const verticesPerSide = PETALS * (RADIAL_STEPS + 1) * (ARC_STEPS + 1);
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verticesPerSide * 2 * 3), 3).setUsage(THREE.DynamicDrawUsage));
  for (const side of [0, 1]) for (let petal = 0; petal < PETALS; petal++) {
    const indices = groups[petal % groups.length];
    const offset = side * verticesPerSide + petal * (RADIAL_STEPS + 1) * (ARC_STEPS + 1);
    for (let row = 0; row < RADIAL_STEPS; row++) for (let col = 0; col < ARC_STEPS; col++) {
      const a = offset + row * (ARC_STEPS + 1) + col;
      const b = a + ARC_STEPS + 1;
      if (side === 0) indices.push(a, a + 1, b, a + 1, b + 1, b);
      else indices.push(a, b, a + 1, a + 1, b, b + 1);
    }
  }
  let offset = 0;
  groups.forEach((indices, materialIndex) => {
    geometry.addGroup(offset, indices.length, materialIndex);
    offset += indices.length;
  });
  geometry.setIndex(groups.flat());
  return geometry;
}

export function shapeIrisPetals(geometry, radius, xFace, angle) {
  const positions = geometry.attributes.position;
  const sector = TAU / PETALS, outer = .0131;
  let index = 0;
  // Both faces show overlapping leaves around the exact circular throat.
  // The angle describes illustrative movement, independent of the ray model.
  for (const side of [-1, 1]) for (let petal = 0; petal < PETALS; petal++) {
    for (let row = 0; row <= RADIAL_STEPS; row++) {
      const t = row / RADIAL_STEPS;
      const r = THREE.MathUtils.lerp(radius + .00005, outer, t);
      const sweep = .9 * t - .36 * t * t;
      const relief = .00006 * (1 - t) * (petal % 3);
      for (let col = 0; col <= ARC_STEPS; col++) {
        const f = col / ARC_STEPS;
        const theta = petal * sector + angle - sweep + .013 + f * (sector - .026);
        const x = side * (xFace + .000012 + relief + .000045 * f * (1 - t));
        positions.setXYZ(index++, x, r * Math.cos(theta), r * Math.sin(theta));
      }
    }
  }
  positions.needsUpdate = true;
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
}
