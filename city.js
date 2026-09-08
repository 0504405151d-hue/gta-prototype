// Procedurally builds a small city grid: ground, roads, sidewalks, buildings,
// streetlights and a stylised dusk sky. Returns spawn points and prop spots
// so other modules (destructibles.js) know where to scatter physics props.

import { rand, randInt, choice, resetSeed, buildFacadeTexture, buildRoadTexture, buildSidewalkTexture, buildSoftDotTexture } from './utils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

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
          addTree(THREE, CANNON, world, group, tx, tz);
        }
        continue;
      }

      // Round-7 ("сделай город разнообразным ... в реальной жизни каждый
      // дом в другом месте другой формы, а у тебя всё сеткой" — the city
      // reads as a grid because it WAS one: exactly one centered box per
      // block, same footprint rules every time). The street grid itself
      // stays uniform on purpose (traffic.js's node graph, the traffic
      // lights, lane markings and crosswalks all key off evenly-spaced
      // streetCoords, and rebuilding that into an irregular road network is
      // a much bigger, riskier change than what was actually asked for) —
      // but nothing says every BLOCK has to hold one centered building. A
      // real city block usually holds several separate buildings of
      // different footprints jammed in at slightly different angles, not
      // one uniform tower dead-center. splitLots() below recursively
      // carves this block's square footprint into 1-3 irregular
      // rectangular lots (random split axis, random split point, a gap
      // between them for a walkway) — each lot then gets its own
      // independent height/style/rotation, so neighboring buildings on the
      // same block can be completely different sizes and shapes.
      const lotCount = choice([1, 1, 1, 1, 2, 2, 3]);
      const lots = splitLots(cx, cz, footprint, footprint, lotCount, rand(2, 4)).filter((l) => l.w > 5 && l.d > 5);
      const roofMat = new THREE.MeshStandardMaterial({ color: 0x1a1c22, roughness: 0.8, metalness: 0.2 });

      lots.forEach((lot, lotIdx) => {
        // Building footprint smaller than the lot to leave a walkable margin
        const bw = Math.max(4, lot.w - rand(2, 5));
        const bd = Math.max(4, lot.d - rand(2, 5));
        const bh = rand(10, 62);
        // A few degrees of yaw per lot — "each building at its own slight
        // angle" is a big part of what reads as real rather than gridded,
        // and stays small enough (±0.1 rad ≈ ±5.7°) that a building never
        // swings a corner out past its own lot into the road.
        const angle = rand(-0.1, 0.1);
        // Round-5 graphics pass: was a coin-flip between exactly 2 facade
        // colors for the whole city — every block ended up looking like a
        // repeat of the same two towers. A wider, still-muted palette (kept
        // low-saturation on purpose, same reasoning as the original two: a
        // neon-bright skyline would fight the glare fixes from round 3) gives
        // real block-to-block (now lot-to-lot) variety instead.
        const hue = choice([0x2b2f3a, 0x3a3226, 0x2f3a34, 0x33303f, 0x3a2f2f, 0x2a3540, 0x3a3730]);
        const tex = buildFacadeTexture(THREE, { base: `#${hue.toString(16)}` });
        // Round-5 ("windows are too small"): each texture tile now has 5
        // columns / 10 rows (down from 6/14 — see buildFacadeTexture) AND is
        // stretched over a much bigger patch of wall before repeating (9
        // units wide, 30 tall, instead of 6x6) — together that takes a window
        // column from ~1 unit wide/0.43 tall to ~1.8 wide/3 tall, close to a
        // real window+floor-height instead of a fine grid of tiny squares.
        tex.repeat.set(Math.max(1, bw / 9), Math.max(1, bh / 30));
        // Round-6 ("every building looks the same" + a real bug: windows on
        // the roof): three cosmetic "styles" reusing the same facade texture
        // so the palette work above still matters, plus a plain roof cap
        // material — a BoxGeometry with ONE material stretches the window
        // texture over all 6 faces, top and bottom included, which is exactly
        // why flat rooftops were showing a window grid instead of bare roofing
        // under the AC units. A material ARRAY (one per box face, order
        // px/nx/py/ny/pz/nz) puts the facade texture on the four vertical
        // sides only and a flat, unlit-looking cap on top/bottom.
        const style = choice(['concrete', 'concrete', 'glass', 'brick']);
        let sideMat;
        if (style === 'glass') {
          sideMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.28, metalness: 0.55, color: 0xcfe0ff });
        } else if (style === 'brick') {
          sideMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.95, metalness: 0.02, color: 0xffdcc0 });
        } else {
          sideMat = new THREE.MeshStandardMaterial({ map: tex, roughness: 0.75, metalness: 0.15 });
        }
        const roofCapMat = new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.9, metalness: 0.05 });

        // Everything for this one building is built in LOCAL space (offsets
        // from its own origin) inside a Group, and only the Group itself is
        // positioned/rotated onto the lot — much simpler than rotating each
        // child mesh's own position individually.
        const bGroup = new THREE.Group();
        const building = new THREE.Mesh(
          new THREE.BoxGeometry(bw, bh, bd),
          [sideMat, sideMat, roofCapMat, roofCapMat, sideMat, sideMat]
        );
        building.position.set(0, bh / 2, 0);
        building.castShadow = true;
        building.receiveShadow = true;
        bGroup.add(building);

        // Round-6 city-diversity pass: ~30% of towers over a minimum height
        // get a smaller stepped-back second tier instead of a flat top — a
        // cheap way to break up the skyline into more than just "same box,
        // different height" without touching the physics footprint (the
        // setback tier is short/light enough that driving into a building's
        // base is unaffected, and it sits above where the wheel raycasts and
        // resolveBuildingOverlap() in main.js ever look).
        const stepped = bh > 26 && rand(0, 1) < 0.3;
        if (stepped) {
          const topW = bw * rand(0.45, 0.68);
          const topD = bd * rand(0.45, 0.68);
          const topH = rand(6, 16);
          const topTex = buildFacadeTexture(THREE, { base: `#${hue.toString(16)}` });
          topTex.repeat.set(Math.max(1, topW / 9), Math.max(1, topH / 30));
          const topSideMat = new THREE.MeshStandardMaterial({ map: topTex, roughness: sideMat.roughness, metalness: sideMat.metalness, color: sideMat.color.getHex() });
          const top = new THREE.Mesh(
            new THREE.BoxGeometry(topW, topH, topD),
            [topSideMat, topSideMat, roofCapMat, roofCapMat, topSideMat, topSideMat]
          );
          top.position.set(0, bh + topH / 2, 0);
          top.castShadow = true;
          top.receiveShadow = true;
          bGroup.add(top);
        }
        const roofY = bh; // clutter always sits on the LOWER roof, even when a stepped-back tier exists above it — reads better than floating clutter up on the setback

        // A thin parapet ledge around the roofline — purely decorative (no
        // collider, same reasoning as the AC units below: it's well above
        // where any wheel raycast or building-overlap check ever samples),
        // but it's what actually reads as "a building" instead of "a box"
        // from a distance/rooftop view.
        if (rand(0, 1) < 0.7) {
          const parapetH = 0.5;
          const parapet = new THREE.Mesh(new THREE.BoxGeometry(bw + 0.15, parapetH, bd + 0.15), roofCapMat);
          parapet.position.set(0, bh + parapetH / 2, 0);
          bGroup.add(parapet);
        }

        // rooftop clutter — AC units + the occasional antenna, purely visual,
        // just enough to break up the flat roofline silhouette
        const acCount = randInt(1, 3);
        for (let a = 0; a < acCount; a++) {
          const acW = rand(0.8, 1.6);
          const ac = new THREE.Mesh(new THREE.BoxGeometry(acW, acW * 0.5, acW), roofMat);
          ac.position.set(rand(-bw / 2 + acW, bw / 2 - acW), roofY + acW * 0.25, rand(-bd / 2 + acW, bd / 2 - acW));
          ac.castShadow = true;
          bGroup.add(ac);
        }
        if (rand(0, 1) < 0.35) {
          const antHeight = rand(2, 5);
          const antenna = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, antHeight, 6), roofMat);
          antenna.position.set(rand(-bw / 3, bw / 3), roofY + antHeight / 2, rand(-bd / 3, bd / 3));
          bGroup.add(antenna);
        }

        bGroup.position.set(lot.cx, 0, lot.cz);
        bGroup.rotation.y = angle;
        group.add(bGroup);

        const body = new CANNON.Body({ mass: 0, shape: new CANNON.Box(new CANNON.Vec3(bw / 2, bh / 2, bd / 2)) });
        body.position.set(lot.cx, bh / 2, lot.cz);
        body.quaternion.setFromEuler(0, angle, 0);
        body.userData = { isBuilding: true };
        world.addBody(body);
        buildingBodies.push(body);
        footprints.push({ x: lot.cx, z: lot.cz, w: bw, d: bd, h: bh });

        // A parked car (or two) tucked into the sidewalk margin along a
        // building edge — cheap "lived-in city" detail, and a solid obstacle
        // players can actually crash into (dents the body just like a wall).
        // Only the first (largest) lot on a multi-building block gets one,
        // same overall chance as before — every lot rolling independently
        // would clutter a 3-way-split block with cars on every scrap of curb.
        if (lotIdx === 0 && rand(0, 1) < 0.55) {
          addParkedCar(THREE, CANNON, group, world, lot.w, bw, bd, lot.cx, lot.cz);
        }
      });
    }
  }

  // ---------- Streetlights at intersections ----------
  const streetCoords = [];
  for (let i = 0; i <= GRID_N; i++) streetCoords.push((i - half - 0.5) * BLOCK_PITCH);

  // Streetlights used to sit exactly on the intersection coordinate, i.e.
  // planted dead in the middle of the crossing — visually wrong (a real
  // pole stands on the sidewalk corner, not in the road) and reported as
  // such. Push each one out past the curb (ROAD_HALF_WIDTH) onto the
  // sidewalk strip, at one of the intersection's four corners. Which corner
  // alternates with the grid's (i, j) parity so poles end up on varied
  // corners around the city instead of all leaning the same direction.
  const streetlightCornerOffset = ROAD_HALF_WIDTH + 0.9;
  for (let i = 0; i <= GRID_N; i++) {
    for (let j = 0; j <= GRID_N; j++) {
      if ((i + j) % 2 !== 0) continue; // sparse, for perf
      const x = streetCoords[i];
      const z = streetCoords[j];
      const sx = (i % 2 === 0) ? 1 : -1;
      const sz = (j % 2 === 0) ? 1 : -1;
      // Arm swings back toward the intersection center so the lamp still
      // overhangs the road/crossing (like a real streetlight) instead of
      // hanging out over the sidewalk/building behind the pole.
      const armAngle = Math.atan2(-sz, -sx);
      addStreetlight(THREE, CANNON, world, group, x + sx * streetlightCornerOffset, z + sz * streetlightCornerOffset, armAngle);
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

// Round 7 ("каждый дом в другом месте другой формы" — irregular city
// blocks): recursive binary-space-partition of a square block footprint
// into `n` rectangular lots of DIFFERENT sizes at DIFFERENT offsets, each
// separated by `gap` (a walkway/alley) — the standard trick for generating
// plausible irregular city parcels out of one rectangle, rather than
// tiling it into n equal, still-gridded pieces. Splits alternate axis with
// some randomness (biased toward splitting the longer side, like a real
// subdivided lot) and the split point itself is randomized (not always
// half), so a 2-way split reliably gives one clearly bigger lot and one
// clearly smaller one instead of two identical halves.
function splitLots(cx, cz, w, d, n, gap) {
  if (n <= 1) return [{ cx, cz, w, d }];
  const nA = Math.ceil(n / 2), nB = n - nA;
  const frac = rand(0.35, 0.65);
  const splitAlongX = w >= d ? rand(0, 1) < 0.75 : rand(0, 1) < 0.25;
  if (splitAlongX) {
    const wA = w * frac - gap / 2, wB = w * (1 - frac) - gap / 2;
    if (wA < 4 || wB < 4) return [{ cx, cz, w, d }]; // too thin to usefully split further
    const xA = cx - w / 2 + wA / 2, xB = cx + w / 2 - wB / 2;
    return [...splitLots(xA, cz, wA, d, nA, gap), ...splitLots(xB, cz, wB, d, nB, gap)];
  }
  const dA = d * frac - gap / 2, dB = d * (1 - frac) - gap / 2;
  if (dA < 4 || dB < 4) return [{ cx, cz, w, d }];
  const zA = cz - d / 2 + dA / 2, zB = cz + d / 2 - dB / 2;
  return [...splitLots(cx, zA, w, dA, nA, gap), ...splitLots(cx, zB, w, dB, nB, gap)];
}

function addTree(THREE, CANNON, world, group, x, z) {
  const trunkH = rand(1.6, 2.4);
  const trunkR = 0.16; // between the geometry's 0.14/0.18 taper — close enough for a collider
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

  // Round-7 ("add colliders on streetlights and trees so I don't drive
  // through them") — only the trunk needs a real collider (a car clipping
  // through leaves above bumper height is normal in basically every driving
  // game; clipping through the trunk at ground level is what actually looks
  // broken). A thin static cylinder, same radius as the trunk mesh.
  const trunkBody = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(trunkR, trunkR, trunkH, 8) });
  trunkBody.position.set(x, trunkH / 2, z);
  // Follow-up fix ("после столкновения с деревом машина не взрывается"): this
  // body was solid (cars correctly stopped on it) but had no userData at
  // all, and vehicle.js's _onChassisCollide only dents/damages the car when
  // the other body's userData says isBuilding or isTraffic — so hitting a
  // tree trunk, however hard, silently did zero damage. Tagging it the same
  // way the parked-car body below already does ("solid + dents the player's
  // car like any other structure") makes trees actually dangerous to ram.
  trunkBody.userData = { isBuilding: true };
  world.addBody(trunkBody);
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
  // Round-3 glare pass: same softened clearcoat/roughness/envMapIntensity as
  // every other car material in the project now (see vehicle.js/traffic.js).
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.44, metalness: 0.6, clearcoat: 0.65, clearcoatRoughness: 0.5, envMapIntensity: 0.5 });
  const car = new THREE.Group();
  const base = new THREE.Mesh(new THREE.BoxGeometry(w, h * 0.5, l), bodyMat);
  base.position.y = h * 0.32;
  base.castShadow = true;
  base.receiveShadow = true;
  car.add(base);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(w * 0.8, h * 0.42, l * 0.48),
    new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.2, metalness: 0.15, clearcoat: 0.3, clearcoatRoughness: 0.45, envMapIntensity: 0.5 })
  );
  cabin.position.set(0, h * 0.68, -l * 0.05);
  cabin.castShadow = true;
  car.add(cabin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  // Rim discs merged into one mesh (one draw call for all 4) rather than one
  // Mesh per wheel — a city can have dozens of parked cars, and traffic.js's
  // own smoke test caught how fast per-instance draw calls add up under
  // software rendering (see the comment there); same fix applied here.
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xaeb2b8, roughness: 0.4, metalness: 0.8, envMapIntensity: 0.5 });
  const rimGeos = [];
  [[-w / 2, l / 2 - 0.7], [w / 2, l / 2 - 0.7], [-w / 2, -l / 2 + 0.6], [w / 2, -l / 2 + 0.6]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 14), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    car.add(wheel);
    const rGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.3, 12);
    rGeo.rotateZ(Math.PI / 2);
    rGeo.translate(wx, 0.34, wz);
    rimGeos.push(rGeo);
  });
  car.add(new THREE.Mesh(mergeGeometries(rimGeos), rimMat));
  rimGeos.forEach((g) => g.dispose());
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

function addStreetlight(THREE, CANNON, world, group, x, z, armAngleRad = 0) {
  const poleMat = new THREE.MeshStandardMaterial({ color: 0x1c1e24, roughness: 0.5, metalness: 0.6 });
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 6, 8), poleMat);
  pole.position.set(x, 3, z);
  pole.castShadow = true;
  group.add(pole);

  // Round-7: a real collider for the pole, same reasoning as addTree's
  // trunk collider just above — thin, but solid, so it stops a car instead
  // of the pole just being a visual prop cars drive straight through.
  const poleBody = new CANNON.Body({ mass: 0, shape: new CANNON.Cylinder(0.13, 0.13, 6, 8) });
  poleBody.position.set(x, 3, z);
  // Same fix as the tree trunk above: solid but untagged means zero damage
  // on impact, whatever the speed — tag it isBuilding so a lamp post is a
  // real hazard to ram, not just an invisible wall.
  poleBody.userData = { isBuilding: true };
  world.addBody(poleBody);

  // The arm/lamp/light used to be built straight along world +X, which was
  // fine back when the pole always stood at the intersection center (any
  // direction "toward the crossing" looked the same, more or less). Now
  // that poles sit off to a corner (see the call site), the arm needs to
  // actually swing toward the road it's lighting instead of always +X — so
  // it's built inside a pivot Object3D rotated by armAngleRad, with the arm
  // and lamp positioned in the pivot's local space exactly as they used to
  // be positioned in world space at angle 0 (reproduces the old look/height
  // exactly when armAngleRad is 0).
  const armPivot = new THREE.Object3D();
  armPivot.position.set(x, 5.9, z);
  armPivot.rotation.y = armAngleRad;
  group.add(armPivot);

  const armLen = 1.4;
  const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, armLen, 6), poleMat);
  arm.rotation.z = Math.PI / 2;
  arm.position.set(armLen / 2, 0, 0);
  armPivot.add(arm);

  const lampMat = new THREE.MeshStandardMaterial({ color: 0xffdca0, emissive: 0xffb347, emissiveIntensity: 2.2, roughness: 0.4 });
  const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 10), lampMat);
  lamp.position.set(armLen, -0.15, 0); // -0.15 matches the old 5.9 -> 5.75 drop
  armPivot.add(lamp);

  const light = new THREE.PointLight(0xffb066, 6, 16, 2);
  light.position.copy(lamp.position);
  armPivot.add(light);
}
