// Round 12 ("ближе к GTA Сан Андреас" — пешеходы на тротуарах): simple,
// purely decorative pedestrians patrolling back and forth along sidewalk
// edges. No physics body, no collider, no interaction with the player's car
// at all — a car can't even reach the sidewalk strip these walk on (the
// curb along every block is already a real, solid collider — see city.js),
// so this is pure background city life, the same "not worth a collider"
// call already made for the bushes/benches/trash cans/hydrants scattered
// along the same curbs. It never becomes a mechanic of any kind: nothing
// here ever checks for or reacts to the player's car being nearby.
//
// Reuses the same block-footprint math city.js's own addStreetClutter()
// already does (derived independently from streetCoords rather than
// touching city.js) so a patrol path always lands on an actual sidewalk
// strip and never inside a building or out in the road.

import { rand, randInt, choice } from './utils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const SHIRT_COLORS = [0xd0421c, 0x1c6dd0, 0x2fae4a, 0xd7a52c, 0x6b4a8a, 0x2e2e33, 0xd8d8d0, 0xc94f8a];
const PANTS_COLORS = [0x2a2a2e, 0x3a3a44, 0x1c1c22, 0x4a3a2a, 0x5a5a5a, 0x223344];
// Deliberately kept simple/abstract rather than aiming for realistic human
// figures at all (blocky low-poly shapes, same visual register as this
// project's cars/props) — a handful of plain skin-tone options for a bit of
// crowd variety, nothing more specific attempted.
const SKIN_COLORS = [0xd8a878, 0xb87f56, 0x8a5a3a, 0xe8c4a0, 0x6a4530, 0xc9946a];

function buildPedestrianMesh(THREE) {
  const group = new THREE.Group();
  const shirtMat = new THREE.MeshStandardMaterial({ color: choice(SHIRT_COLORS), roughness: 0.85 });
  const pantsMat = new THREE.MeshStandardMaterial({ color: choice(PANTS_COLORS), roughness: 0.85 });
  const skinMat = new THREE.MeshStandardMaterial({ color: choice(SKIN_COLORS), roughness: 0.75 });

  const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.16, 0.36, 4, 8), shirtMat);
  torso.position.y = 1.04;
  torso.castShadow = true;
  group.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 10, 8), skinMat);
  head.position.y = 1.42;
  head.castShadow = true;
  group.add(head);

  // Arms: static (no swing) — merged into one mesh, cheap and unnoticeable
  // at the size/distance these are actually seen at.
  const armGeoL = new THREE.CapsuleGeometry(0.045, 0.3, 3, 6);
  armGeoL.translate(0.21, 1.0, 0);
  const armGeoR = new THREE.CapsuleGeometry(0.045, 0.3, 3, 6);
  armGeoR.translate(-0.21, 1.0, 0);
  group.add(new THREE.Mesh(mergeGeometries([armGeoL, armGeoR]), skinMat));

  // Legs: each in its own pivot group so update() can swing them for a
  // walk cycle — the exact same "rotate a small child group" trick
  // vehicle.js/traffic.js already use for steering front wheels.
  const legPivotL = new THREE.Group();
  legPivotL.position.set(0.08, 0.64, 0);
  const legL = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.48, 3, 6), pantsMat);
  legL.position.y = -0.24;
  legL.castShadow = true;
  legPivotL.add(legL);
  group.add(legPivotL);

  const legPivotR = new THREE.Group();
  legPivotR.position.set(-0.08, 0.64, 0);
  const legR = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 0.48, 3, 6), pantsMat);
  legR.position.y = -0.24;
  legR.castShadow = true;
  legPivotR.add(legR);
  group.add(legPivotR);

  return { group, legPivotL, legPivotR };
}

export class PedestrianSystem {
  // `roadHalfWidth`: same ROAD_HALF_WIDTH constant city.js exports — kept as
  // a parameter rather than a re-import so this module has zero coupling to
  // city.js beyond the streetCoords array every other system already shares.
  constructor(THREE, scene, streetCoords, roadHalfWidth, { count = 24 } = {}) {
    this.THREE = THREE;
    this.scene = scene;
    this.streetCoords = streetCoords;
    this.roadHalfWidth = roadHalfWidth;
    this.blocksPerRow = streetCoords.length - 1;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.peds = [];
    this.setCount(count);
  }

  // Picks a random block edge and returns the two patrol endpoints for a
  // walk back and forth along it — same side/inset logic as city.js's own
  // addStreetClutter(), just computed independently from streetCoords.
  _pickPatrol() {
    const { streetCoords, blocksPerRow, roadHalfWidth } = this;
    const i = randInt(0, blocksPerRow - 1);
    const j = randInt(0, blocksPerRow - 1);
    const cx = (streetCoords[i] + streetCoords[i + 1]) / 2;
    const cz = (streetCoords[j] + streetCoords[j + 1]) / 2;
    const blockPitch = streetCoords[i + 1] - streetCoords[i];
    const footprint = blockPitch - roadHalfWidth * 2 - 2;
    if (footprint < 6) return null; // degenerate/too-small block — skip rather than crowd it
    const inset = footprint / 2 - 1.4; // just inside the curb, clear of the clutter/parked-car strip
    const alongHalf = footprint / 2 - 2.4; // stay off the block corners
    if (alongHalf < 1.5) return null;
    const side = randInt(0, 3);
    let pA, pB;
    if (side === 0) { pA = { x: cx - alongHalf, z: cz - inset }; pB = { x: cx + alongHalf, z: cz - inset }; }
    else if (side === 1) { pA = { x: cx - alongHalf, z: cz + inset }; pB = { x: cx + alongHalf, z: cz + inset }; }
    else if (side === 2) { pA = { x: cx - inset, z: cz - alongHalf }; pB = { x: cx - inset, z: cz + alongHalf }; }
    else { pA = { x: cx + inset, z: cz - alongHalf }; pB = { x: cx + inset, z: cz + alongHalf }; }
    return { pA, pB };
  }

  _spawnPed() {
    const { THREE } = this;
    let patrol = null;
    for (let attempt = 0; attempt < 8 && !patrol; attempt++) patrol = this._pickPatrol();
    if (!patrol) return null; // pathological tiny-grid case — just skip this one
    const { pA, pB } = patrol;
    const { group: mesh, legPivotL, legPivotR } = buildPedestrianMesh(THREE);
    const t = rand(0, 1);
    const x = pA.x + (pB.x - pA.x) * t;
    const z = pA.z + (pB.z - pA.z) * t;
    mesh.position.set(x, 0, z);
    this.group.add(mesh);
    return {
      mesh, legPivotL, legPivotR, pA, pB, t,
      dir: choice([1, -1]),
      speed: rand(1.1, 1.7), // m/s — brisk walking pace
      phase: rand(0, Math.PI * 2),
    };
  }

  setCount(n) {
    while (this.peds.length < n) {
      const p = this._spawnPed();
      if (!p) break; // couldn't find room — don't spin forever
      this.peds.push(p);
    }
    while (this.peds.length > n) {
      const p = this.peds.pop();
      this.group.remove(p.mesh);
    }
  }

  update(dt) {
    for (const p of this.peds) {
      const segLen = Math.hypot(p.pB.x - p.pA.x, p.pB.z - p.pA.z) || 1;
      p.t += (p.dir * p.speed * dt) / segLen;
      if (p.t >= 1) { p.t = 1; p.dir = -1; }
      else if (p.t <= 0) { p.t = 0; p.dir = 1; }
      const x = p.pA.x + (p.pB.x - p.pA.x) * p.t;
      const z = p.pA.z + (p.pB.z - p.pA.z) * p.t;
      p.mesh.position.set(x, 0, z);
      // Face the direction of travel along the segment (flips 180° the
      // instant it turns around at an endpoint — a real pedestrian pacing a
      // sidewalk does exactly that, no gradual U-turn needed).
      const travelX = (p.pB.x - p.pA.x) * p.dir;
      const travelZ = (p.pB.z - p.pA.z) * p.dir;
      if (travelX !== 0 || travelZ !== 0) p.mesh.rotation.y = Math.atan2(travelX, travelZ);

      p.phase += dt * p.speed * 5.5;
      const swing = Math.sin(p.phase) * 0.55;
      p.legPivotL.rotation.x = swing;
      p.legPivotR.rotation.x = -swing;
    }
  }
}
