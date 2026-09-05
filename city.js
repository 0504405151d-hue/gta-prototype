// Procedurally builds a small city grid: ground, roads, sidewalks, buildings,
// streetlights and a stylised dusk sky. Returns spawn points and prop spots
// so other modules (destructibles.js) know where to scatter physics props.

import { rand, randInt, choice, resetSeed, buildFacadeTexture, buildRoadTexture, buildSidewalkTexture, buildSoftDotTexture } from './utils.js';

const GRID_N = 10;           // city is GRID_N x GRID_N blocks (was 7 — bigger city per request)
export const BLOCK_PITCH = 34;      // distance between block centers
export const ROAD_HALF_WIDTH = 5.5; // half width of the road strip between blocks
const GROUND_SEAM_GAP = 0.02; // keeps the road plane from z-fighting with sidewalks/buildings
const CURB_HEIGHT = 0.18;    // sidewalk slab height — also its real physics curb now
export const CITY_HALF = (GRID_N * BLOCK_PITCH) / 2;

export function buildCity(THREE, CANNON, world, scene, { shadowMapSize = 2048 } = {}) {
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
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  scene.add(skyMesh);
  // Slightly thinner than before (0.0038) — the city footprint grew with
  // GRID_N, and the old density fogged out most of the new far blocks.
  scene.fog = new THREE.FogExp2(0xd68a5c, 0.0028);

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
  // Was 2.4, then 1.9 — still reported as "too bright" (glossy clearcoat
  // paint + the hemisphere/ambient fill below stack on top of this, so the
  // sun alone wasn't the whole story). Brought all three light sources down
  // together this time rather than just the sun again: sun 1.9→1.4, hemi
  // 0.9→0.72, ambient fill 0.35→0.26 — plus the renderer's tone-mapping
  // exposure in main.js — so overall scene brightness actually drops
  // instead of just shifting which light source does the overexposing.
  const sun = new THREE.DirectionalLight(0xffd9a8, 1.4);
  sun.position.set(-140, 120, -80);
  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  // Bounds scale with the city (CITY_HALF grew from 119 to 170 with the
  // bigger grid) so the far edge of the map still gets real shadows instead
  // of just going flat/unshadowed past the old, smaller frustum.
  const shadowHalf = CITY_HALF + 50;
  sun.shadow.camera.left = -shadowHalf;
  sun.shadow.camera.right = shadowHalf;
  sun.shadow.camera.top = shadowHalf;
  sun.shadow.camera.bottom = -shadowHalf;
  sun.shadow.camera.near = 10;
  sun.shadow.camera.far = shadowHalf * 3;
  sun.shadow.bias = -0.0015;
  scene.add(sun);
  scene.add(sun.target);

  const hemi = new THREE.HemisphereLight(0x8fa8ff, 0x30261a, 0.72);
  scene.add(hemi);

  const fill = new THREE.AmbientLight(0x404860, 0.26);
  scene.add(fill);

  // ---------- Ground / roads ----------
  const roadTex = buildRoadTexture(THREE);
  roadTex.repeat.set(GRID_N * 3, GRID_N * 3);
  const groundSize = GRID_N * BLOCK_PITCH + 60;
  const groundGeo = new THREE.PlaneGeometry(groundSize, groundSize);
  const groundMat = new THREE.MeshStandardMaterial({ map: roadTex, roughness: 0.95, metalness: 0.02 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  // Sits a hair below y=0 (where sidewalk/building bases live) so its top
  // face is never exactly coplanar with theirs — coincident surfaces were
  // z-fighting (flickering) along every sidewalk and building edge.
  ground.position.y = -GROUND_SEAM_GAP;
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
  groundBody.position.set(0, -groundThickness / 2 - GROUND_SEAM_GAP, 0);
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

      // Sidewalk slab: visual + a REAL curb collider (this used to be
      // visual-only, so cars just glided straight through/over it with no
      // bump — the wheel raycasts now see an actual low step here, so
      // driving onto a sidewalk feels like mounting a curb instead of
      // clipping through a floating box).
      const sidewalkMat = new THREE.MeshStandardMaterial({ map: sidewalkTex, roughness: 1 });
      const sidewalk = new THREE.Mesh(new THREE.BoxGeometry(footprint, CURB_HEIGHT, footprint), sidewalkMat);
      sidewalk.position.set(cx, CURB_HEIGHT / 2, cz);
      sidewalk.receiveShadow = true;
      group.add(sidewalk);

      const curbBody = new CANNON.Body({
        mass: 0,
        shape: new CANNON.Box(new CANNON.Vec3(footprint / 2, CURB_HEIGHT / 2, footprint / 2)),
      });
      curbBody.position.set(cx, CURB_HEIGHT / 2, cz);
      world.addBody(curbBody);

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
      footprints.push({ x: cx, z: cz, w: bw, d: bd, h: bh });

      // A parked car (or two) tucked into the sidewalk margin along a
      // building edge — cheap "lived-in city" detail, and a solid obstacle
      // players can actually crash into (dents the body just like a wall).
      if (rand(0, 1) < 0.55) {
        addParkedCar(THREE, CANNON, group, world, footprint, bw, bd, cx, cz);
      }

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
  const streetCoords = [];
  for (let i = 0; i <= GRID_N; i++) streetCoords.push((i - half - 0.5) * BLOCK_PITCH);

  for (let i = 0; i <= GRID_N; i++) {
    for (let j = 0; j <= GRID_N; j++) {
      if ((i + j) % 2 !== 0) continue; // sparse, for perf
      const x = streetCoords[i];
      const z = streetCoords[j];
      addStreetlight(THREE, group, x, z);
    }
  }

  // ---------- Lane markings: correctly oriented per street direction ----------
  // A single shared road texture can't get this right for BOTH directions of
  // a grid at once (see the note in buildRoadTexture) — so dashes are real,
  // separately-oriented geometry instead: one batch elongated along Z for the
  // streets running north-south, one elongated along X for east-west streets.
  addLaneMarkings(THREE, group, streetCoords, GROUND_SEAM_GAP);

  // ---------- Crosswalks at every intersection ----------
  addCrosswalks(THREE, group, streetCoords, GROUND_SEAM_GAP);

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

  return {
    group, spawnPoints, propSpots, cityHalf: CITY_HALF, sun, buildingBodies, footprints, streetCoords,
    hemi, skyMat, groundMat,
  };
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

const PARKED_CAR_COLORS = [0x8a1c1c, 0x1c3d8a, 0x2e2e33, 0xd8d8d0, 0x1c6b3d, 0x8a6a1c];

function addParkedCar(THREE, CANNON, group, world, footprint, bw, bd, cx, cz) {
  const margin = (footprint - Math.min(bw, bd)) / 2;
  if (margin < 1.4) return; // not enough room next to this building — skip rather than clip into it

  const side = randInt(0, 3); // 0:+x 1:-x 2:+z 3:-z edge of the block
  const inset = Math.max(0.9, margin * 0.5);
  const alongHalf = (side < 2 ? bd : bw) / 2 - 3;
  if (alongHalf < 1) return;
  const along = rand(-alongHalf, alongHalf);

  let x, z, heading;
  if (side === 0) { x = cx + bw / 2 + inset; z = cz + along; heading = Math.PI / 2; }
  else if (side === 1) { x = cx - bw / 2 - inset; z = cz + along; heading = -Math.PI / 2; }
  else if (side === 2) { x = cx + along; z = cz + bd / 2 + inset; heading = 0; }
  else { x = cx + along; z = cz - bd / 2 - inset; heading = Math.PI; }

  const w = 1.9, h = 1.35, l = 4.2;
  const color = choice(PARKED_CAR_COLORS);
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.36, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.32 });
  const car = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.5, l), bodyMat);
  base.position.y = h * 0.32;
  base.castShadow = true;
  base.receiveShadow = true;
  car.add(base);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.8, h * 0.42, l * 0.48),
    new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.08, metalness: 0.15, clearcoat: 0.5 })
  );
  cabin.position.set(0, h * 0.68, -l * 0.05);
  cabin.castShadow = true;
  car.add(cabin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  [[-w / 2, l / 2 - 0.7], [w / 2, l / 2 - 0.7], [-w / 2, -l / 2 + 0.6], [w / 2, -l / 2 + 0.6]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 14), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    car.add(wheel);
  });
  car.position.set(x, 0, z);
  car.rotation.y = heading;
  group.add(car);

  const shape = new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, l / 2));
  const parkedBody = new CANNON.Body({ mass: 0, shape });
  parkedBody.position.set(x, h / 2, z);
  parkedBody.quaternion.setFromEuler(0, heading, 0);
  parkedBody.userData = { isBuilding: true }; // solid + dents the player's car like any other structure
  world.addBody(parkedBody);
}

function addLaneMarkings(THREE, group, streetCoords, groundSeamGap) {
  const dashLen = 1.6, dashGap = 1.6, dashW = 0.22;
  const y = groundSeamGap + 0.015; // just above the (slightly lowered) road surface, well below curb height
  const range = (GRID_N * BLOCK_PITCH) / 2 + 30; // matches groundSize/2, covers the outer perimeter streets too
  const step = dashLen + dashGap;
  const clearance = ROAD_HALF_WIDTH + 1.5; // keep dashes out of intersections

  const mat = new THREE.MeshStandardMaterial({ color: 0xe8c94a, roughness: 0.55, metalness: 0.04 });
  const geoNS = new THREE.BoxGeometry(dashW, 0.02, dashLen); // dash elongated along Z — for north/south streets
  const geoEW = new THREE.BoxGeometry(dashLen, 0.02, dashW); // dash elongated along X — for east/west streets

  const perStreet = Math.ceil((range * 2) / step) + 2;
  const maxCount = streetCoords.length * perStreet;
  const instNS = new THREE.InstancedMesh(geoNS, mat, maxCount);
  const instEW = new THREE.InstancedMesh(geoEW, mat, maxCount);
  instNS.receiveShadow = true;
  instEW.receiveShadow = true;

  const m = new THREE.Matrix4();
  let countNS = 0;
  for (const x of streetCoords) {
    for (let z = -range; z <= range; z += step) {
      if (streetCoords.some((zc) => Math.abs(z - zc) < clearance)) continue;
      m.makeTranslation(x, y, z);
      instNS.setMatrixAt(countNS++, m);
    }
  }
  instNS.count = countNS;
  instNS.instanceMatrix.needsUpdate = true;

  let countEW = 0;
  for (const z of streetCoords) {
    for (let x = -range; x <= range; x += step) {
      if (streetCoords.some((xc) => Math.abs(x - xc) < clearance)) continue;
      m.makeTranslation(x, y, z);
      instEW.setMatrixAt(countEW++, m);
    }
  }
  instEW.count = countEW;
  instEW.instanceMatrix.needsUpdate = true;

  group.add(instNS, instEW);
}

// Zebra crossings on all four approaches of every street intersection. Real
// stripes (not a baked texture) so they stay crisp up close and correctly
// oriented regardless of which of the two street directions they belong to:
// a batch elongated along Z (repeated across X) for streets running
// north-south, and one elongated along X (repeated across Z) for east-west
// streets — same idea as addLaneMarkings(), just perpendicular to it.
function addCrosswalks(THREE, group, streetCoords, groundSeamGap) {
  const bandDepth = 3.0;       // how far the striped band extends along the direction of travel
  const stripeW = 0.45;        // width of each stripe, and the gap between them
  const stripeGap = 0.4;
  const crossHalf = ROAD_HALF_WIDTH * 0.82; // stay shy of the curb edges
  const y = groundSeamGap + 0.015; // same height as lane dashes — they never overlap spatially

  const mat = new THREE.MeshStandardMaterial({ color: 0xe9e6dc, roughness: 0.65, metalness: 0.02 });
  const geoAlongZ = new THREE.BoxGeometry(stripeW, 0.02, bandDepth); // stripe parallel to N-S travel, repeated across X
  const geoAlongX = new THREE.BoxGeometry(bandDepth, 0.02, stripeW); // stripe parallel to E-W travel, repeated across Z

  const stripesPerBand = Math.max(3, Math.floor((crossHalf * 2) / (stripeW + stripeGap)));
  const bandsPerIntersection = 2; // one band on each side of the street (before/after the crossing)
  const maxCount = streetCoords.length * streetCoords.length * bandsPerIntersection * stripesPerBand;
  const instNS = new THREE.InstancedMesh(geoAlongZ, mat, maxCount); // crosswalks over north-south streets
  const instEW = new THREE.InstancedMesh(geoAlongX, mat, maxCount); // crosswalks over east-west streets
  instNS.receiveShadow = true;
  instEW.receiveShadow = true;

  const m = new THREE.Matrix4();
  let countNS = 0, countEW = 0;
  const offsets = [];
  const span = (stripesPerBand - 1) * (stripeW + stripeGap);
  for (let s = 0; s < stripesPerBand; s++) offsets.push(-span / 2 + s * (stripeW + stripeGap));

  for (const ix of streetCoords) {
    for (const iz of streetCoords) {
      // Crossing the north-south street (band sits just south, then just north, of this intersection)
      for (const sideZ of [iz - ROAD_HALF_WIDTH - bandDepth / 2, iz + ROAD_HALF_WIDTH + bandDepth / 2]) {
        for (const off of offsets) {
          m.makeTranslation(ix + off, y, sideZ);
          instNS.setMatrixAt(countNS++, m);
        }
      }
      // Crossing the east-west street (band sits just west, then just east, of this intersection)
      for (const sideX of [ix - ROAD_HALF_WIDTH - bandDepth / 2, ix + ROAD_HALF_WIDTH + bandDepth / 2]) {
        for (const off of offsets) {
          m.makeTranslation(sideX, y, iz + off);
          instEW.setMatrixAt(countEW++, m);
        }
      }
    }
  }
  instNS.count = countNS;
  instNS.instanceMatrix.needsUpdate = true;
  instEW.count = countEW;
  instEW.instanceMatrix.needsUpdate = true;

  group.add(instNS, instEW);
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
