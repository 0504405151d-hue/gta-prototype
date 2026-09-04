// Procedurally builds a small city grid: ground, roads, sidewalks, buildings,
// streetlights and a stylised dusk sky. Returns spawn points and prop spots
// so other modules (destructibles.js) know where to scatter physics props.

import { rand, randInt, choice, resetSeed, buildFacadeTexture, buildRoadTexture, buildSidewalkTexture, buildSoftDotTexture } from './utils.js';

const GRID_N = 7;            // city is GRID_N x GRID_N blocks
const BLOCK_PITCH = 34;      // distance between block centers
const ROAD_HALF_WIDTH = 5.5; // half width of the road strip between blocks
export const CITY_HALF = (GRID_N * BLOCK_PITCH) / 2;

export function buildCity(THREE, CANNON, world, scene) {
  resetSeed(1337); // deterministic world: every client builds an identical city + prop layout
  const group = new THREE.Group();
  scene.add(group);

  const spawnPoints = [];
  const propSpots = [];         // { x, z, kind }
  const buildingBodies = [];
  const footprints = [];        // { x, z, w, d } — for the minimap

  // ---------- Sky ----------
  const skyGeo = new THREE.SphereGeometry(600, 24, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    uniforms: {
      topColor: { value: new THREE.Color(0x1b2a52) },
      bottomColor: { value: new THREE.Color(0xffb27a) },
      offset: { value: 20 },
      exponent: { value: 0.6 },
    },
    vertexShader: `
      varying vec3 vWorldPosition;
      void main() {
        vec4 worldPosition = modelMatrix * vec4(position, 1.0);
        vWorldPosition = worldPosition.xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 bottomColor;
      uniform float offset;
      uniform float exponent;
      varying vec3 vWorldPosition;
      void main() {
        float h = normalize(vWorldPosition + vec3(0.0, offset, 0.0)).y;
        gl_FragColor = vec4(mix(bottomColor, topColor, max(pow(max(h, 0.0), exponent), 0.0)), 1.0);
      }`,
  });
  scene.add(new THREE.Mesh(skyGeo, skyMat));
  scene.fog = new THREE.FogExp2(0xd68a5c, 0.0038);

  // A scatter of stars in the upper sky — cheap atmosphere for the dusk/night look.
  {
    const starCount = 500;
    const starPos = new Float32Array(starCount * 3);
    for (let i = 0; i < starCount; i++) {
      const theta = rand(0, Math.PI * 2);
      const phi = rand(0, Math.PI * 0.42); // keep to the upper dome only
      const r = 550;
      starPos[i * 3] = Math.cos(theta) * Math.sin(phi) * r;
      starPos[i * 3 + 1] = Math.cos(phi) * r;
      starPos[i * 3 + 2] = Math.sin(theta) * Math.sin(phi) * r;
    }
    const starGeo = new THREE.BufferGeometry();
    starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
    const starMat = new THREE.PointsMaterial({
      size: 2.2,
      map: buildSoftDotTexture(THREE),
      transparent: true,
      opacity: 0.75,
      depthWrite: false,
      color: 0xdfe8ff,
      sizeAttenuation: false,
    });
    scene.add(new THREE.Points(starGeo, starMat));
  }

  // ---------- Lighting ----------
  const sun = new THREE.DirectionalLight(0xffd9a8, 2.4);
  sun.position.set(-140, 120, -80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -160;
  sun.shadow.camera.right = 160;
  sun.shadow.camera.top = 160;
  sun.shadow.camera.bottom = -160;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = 400;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x8fa8ff, 0x30261a, 0.9);
  scene.add(hemi);

  const fill = new THREE.AmbientLight(0x404860, 0.35);
  scene.add(fill);

  // ---------- Ground / roads ----------
  const roadTex = buildRoadTexture(THREE);
  roadTex.repeat.set(GRID_N * 3, GRID_N * 3);
  const groundSize = GRID_N * BLOCK_PITCH + 60;
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
  const groundMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.95, metalness: 0.02 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  group.add(ground);

  // NOTE: a thick flat Box is used instead of an infinite CANNON.Plane — the
  // RaycastVehicle's wheel raycasts were found (empirically) to miss/behave
  // unreliably against a bare Plane shape, causing suspension to never engage.
  const groundThickness = 2;
  const groundBody = new CANNON.Body({
    mass: 0,
    shape: new CANNON.Box(new CANNON.Vec3(groundSize / 2, groundThickness / 2, groundSize / 2)),
    material: new CANNON.Material('ground'),
  });
  groundBody.position.set(0, -groundThickness / 2, 0);
  world.addBody(groundBody);

  // ---------- Sidewalks + buildings per block ----------
  const sidewalkTex = buildSidewalkTexture(THREE);
  const half = (GRID_N - 1) / 2;

  const openBlocks = new Set(); // blocks left as plazas / parks for open testing space

  for (let i = 0; i < GRID_N; i++) {
    for (let j = 0; j < GRID_N; j++) {
      const cx = (i - half) * BLOCK_PITCH;
      const cz = (j - half) * BLOCK_PITCH;
      const isCenter = Math.abs(i - half) <= 1 && Math.abs(j - half) <= 1;
      const footprint = BLOCK_PITCH - ROAD_HALF_WIDTH * 2 - 2;

      // Keep the central 3x3 blocks mostly open (a plaza) so there's room to drive/drift
      // and a dedicated spot for destructible props.
      const makeOpen = isCenter || rand(0, 1) < 0.12;

      // Sidewalk slab (visual + very low curb collider)
      const sidewalkMat = new THREE.MeshStandardMaterial({ map: sidewalkTex, roughness: 1 });
      const sidewalk = new THREE.Mesh(new THREE.BoxGeometry(footprint, 0.18, footprint), sidewalkMat);
      sidewalk.position.set(cx, 0.09, cz);
      sidewalk.receiveShadow = true;
      group.add(sidewalk);

      if (makeOpen) {
        openBlocks.add(`${i},${j}`);
        propSpots.push({ x: cx + rand(-footprint / 3, footprint / 3), z: cz + rand(-footprint / 3, footprint / 3) });
        // scatter a few trees around the edges of the open plaza/park block
        const treeCount = randInt(2, 5);
        for (let t = 0; t < treeCount; t++) {
          const tx = cx + rand(-footprint / 2 + 2, footprint / 2 - 2);
          const tz = cz + rand(-footprint / 2 + 2, footprint / 2 - 2);
          addTree(THREE, group, tx, tz);
        }
        continue;
      }

      // Building footprint smaller than the sidewalk to leave a walkable margin
      const bw = footprint - rand(4, 8);
      const bd = footprint - rand(4, 8);
      const bh = rand(10, 62);
      const hue = rand(0, 1) < 0.5 ? 0x2b2f3a : 0x3a3226;
      const tex = buildFacadeTexture(THREE, { base: `#${hue.toString(16)}` });
      tex.repeat.set(Math.max(1, Math.round(bw / 6)), Math.max(1, Math.round(bh / 6)));
      const mat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.15 });
      const building = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
      building.position.set(cx, bh / 2, cz);
      building.castShadow = true;
      building.receiveShadow = true;
      group.add(building);

      const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(bw / 2, bh / 2, bd / 2)) });
      body.position.set(cx, bh / 2, cz);
      body.userData = { isBuilding: true };
      world.addBody(body);
      buildingBodies.push(body);
      footprints.push({ x: cx, z: cz, w: bw, d: bd });

      // rooftop clutter — AC units + the occasional antenna, purely visual,
      // just enough to break up the flat roofline silhouette
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.8, metalness: 0.2 });
      const acCount = randInt(1, 3);
      for (let a = 0; a < acCount; a++) {
        const acW = rand(0.8, 1.6);
        const ac = new THREE.Mesh(new THREE.BoxGeometry(acW, acW * 0.5, acW), roofMat);
        ac.position.set(
          cx + rand(-bw / 2 + acW, bw / 2 - acW),
          bh + acW * 0.25,
          cz + rand(-bd / 2 + acW, bd / 2 - acW)
        );
        ac.castShadow = true;
        group.add(ac);
      }
      if (rand(0, 1) < 0.35) {
        const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, rand(2, 5), 6), roofMat);
        antenna.position.set(cx + rand(-bw / 3, bw / 3), bh + antenna.geometry.parameters.height / 2, cz + rand(-bd / 3, bd / 3));
        group.add(antenna);
      }
    }
  }

  // ---------- Streetlights at intersections ----------
  for (let i = 0; i <= GRID_N; i++) {
    for (let j = 0; j <= GRID_N; j++) {
      if ((i + j) % 2 !== 0) continue; // sparse, for perf
      const x = (i - half - 0.5) * BLOCK_PITCH;
      const z = (j - half - 0.5) * BLOCK_PITCH;
      addStreetlight(THREE, group, x, z);
    }
  }

  // ---------- Spawn points (center plaza roads) ----------
  for (let k = 0; k < 8; k++) {
    const angle = (k / 8) * Math.PI * 2;
    spawnPoints.push({
      x: Math.cos(angle) * 14,
      z: Math.sin(angle) * 14,
      heading: angle + Math.PI / 2,
    });
  }

  // add extra prop spots scattered along a couple of open blocks for variety
  for (let k = 0; k < 10; k++) {
    propSpots.push({ x: rand(-CITY_HALF * 0.6, CITY_HALF * 0.6), z: rand(-CITY_HALF * 0.6, CITY_HALF * 0.6) });
  }

  return { group, spawnPoints, propSpots, cityHalf: CITY_HALF, sun, buildingBodies, footprints };
}
// (helpers kept below)

function addTree(THREE, group, x, z) {
  const trunkH = rand(1.6, 2.4);
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.14, 0.18, trunkH, 7),
    new THREE.MeshStandardMaterial({ color: 0x4a3524, roughness: 0.9 })
  );
  trunk.position.set(x, trunkH / 2, z);
  trunk.castShadow = true;
  group.add(trunk);

  const canopyR = rand(1.1, 1.7);
  const canopy = new THREE.Mesh(
    new THREE.ConeGeometry(canopyR, canopyR * 1.8, 8),
    new THREE.MeshStandardMaterial({ color: choice([0x2f6b3a, 0x3a7a42, 0x275e30]), roughness: 0.85 })
  );
  canopy.position.set(x, trunkH + canopyR * 0.7, z);
  canopy.castShadow = true;
  group.add(canopy);
}

function addStreetlight(THREE, group, x, z) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.5, metalness: 0.6 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 6, 8), poleMat);
  pole.position.set(x, 3, z);
  pole.castShadow = true;
  group.add(pole);

  const armLen = 1.4;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, armLen, 6), poleMat);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(x + armLen / 2, 5.9, z);
  group.add(arm);

  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb347, emissiveIntensity: 2.2, roughness: 0.4 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), lampMat);
  lamp.position.set(x + armLen, 5.75, z);
  group.add(lamp);

  const light = new THREE.PointLight(0xffb066, 6, 16, 2);
  light.position.copy(lamp.position);
  group.add(light);
}
