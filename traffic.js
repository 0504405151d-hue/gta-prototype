// AI street traffic: cars that drive themselves around the same street grid
// city.js builds, on a simple node graph (one node per intersection). Each
// car keeps a lane offset to the right of the centerline so opposite-flowing
// traffic doesn't overlap, brakes for whatever's ahead of it in its own
// lane (including the player's own car and every other connected player —
// see the `obstacles` param on update()), and picks a new direction (mostly
// straight, sometimes a turn) every time it reaches an intersection. A turn
// is a short, slowed-down curved arc through the intersection rather than
// an instant snap to the new heading (see _beginTurn()/_placeCarOnArc()) —
// real drivers round a corner, they don't teleport into a new orientation.
// Movement is fully scripted (no real steering physics) but every car still
// owns a real KINEMATIC cannon-es body, so the player's own (dynamic) car
// can actually crash into one — cannon-es resolves that collision using the
// traffic car's real velocity, it just isn't itself pushed around by
// anything.

import { rand, randInt, choice } from './utils.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const CAR_W = 1.9, CAR_H = 1.3, CAR_L = 4.2;
const TRAFFIC_COLORS = [0x2b6fd8, 0xd0d0d6, 0x1a1c22, 0xb32020, 0xd7a52c, 0x2f7d4a, 0x6b6f76];
// Visual-only cap on how far the front wheels are ever shown turned — see
// the steering-angle block in update().
const MAX_STEER_VISUAL = 0.55;

// Round 6 ("make NPC cars as detailed/realistic as the player's own"):
// traffic used to be a single generic sedan-shaped box for every car on the
// road, just recolored — every one of a dozen+ cars on screen had the exact
// same silhouette. Four real body proportions now get picked per spawn (see
// _spawnCar), the same idea as the player's own sedan/sport/suv/truck/bus
// choice in carPresets.js, just simplified enough to stay cheap at
// dozen-plus-on-screen scale (see the draw-call notes further down).
const CAR_STYLES = {
  sedan: { w: 1.9, h: 1.3, l: 4.2, cabinWFrac: 0.8, cabinHFrac: 0.42, cabinLFrac: 0.48, cabinZFrac: -0.05 },
  suv: { w: 2.0, h: 1.6, l: 4.5, cabinWFrac: 0.86, cabinHFrac: 0.56, cabinLFrac: 0.64, cabinZFrac: -0.02 },
  van: { w: 2.05, h: 1.9, l: 5.1, cabinWFrac: 0.94, cabinHFrac: 0.76, cabinLFrac: 0.88, cabinZFrac: -0.02 },
  minibus: { w: 2.1, h: 2.05, l: 6.4, cabinWFrac: 0.94, cabinHFrac: 0.8, cabinLFrac: 0.92, cabinZFrac: -0.01 },
};
const CAR_STYLE_KEYS = Object.keys(CAR_STYLES);

function buildTrafficCarMesh(THREE, color, styleKey) {
  const style = CAR_STYLES[styleKey] || CAR_STYLES.sedan;
  const W = style.w, H = style.h, L = style.l;
  const group = new THREE.Group();
  // Round-3 glare pass: same clearcoat/roughness/envMapIntensity softening
  // applied to the player's own paint (see vehicle.js) — traffic paint was
  // just as mirror-hot in direct sun as the player car used to be.
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.46, metalness: 0.55, clearcoat: 0.65, clearcoatRoughness: 0.55, envMapIntensity: 0.5 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(W, H * 0.5, L), bodyMat);
  base.position.y = H * 0.32;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  // Round-6: this used to be a flat matte-dark box standing in for the
  // whole greenhouse (windshield + side glass + rear glass all as one
  // opaque panel — basically "2 cubes" up close, the same complaint that
  // hit the multiplayer remote-car bug this round). Same geometry/position,
  // but now an actually glass-like transparent/tinted physical material —
  // it catches highlights and reads as real glass instead of a dark block.
  const cabinMat = new THREE.MeshPhysicalMaterial({
    color: 0x0b1622, roughness: 0.12, metalness: 0.05, transparent: true, opacity: 0.62,
    clearcoat: 0.55, clearcoatRoughness: 0.2, envMapIntensity: 0.9,
  });
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(W * style.cabinWFrac, H * style.cabinHFrac, L * style.cabinLFrac),
    cabinMat
  );
  cabin.position.set(0, H * 0.68, L * style.cabinZFrac);
  cabin.castShadow = true;
  group.add(cabin);
  // Round-7 ("NPC cars have no roof, just a glass cabin"): making the
  // cabin transparent (right above) means there's nothing solid left up
  // top — a real car's roof is an opaque panel, the glass is only the
  // sides/front/back. A thin cap, same paint as the body, flush with the
  // cabin's top face closes it back into a real-looking roof.
  const roofCap = new THREE.Mesh(
    new THREE.BoxGeometry(W * style.cabinWFrac * 0.97, 0.06, L * style.cabinLFrac * 0.97),
    bodyMat
  );
  roofCap.position.set(0, H * 0.68 + (H * style.cabinHFrac) / 2 - 0.03, L * style.cabinZFrac);
  roofCap.castShadow = true;
  group.add(roofCap);

  // Trim: bumper strips + wing mirrors + two-tone wheels — the same cheap
  // panel-breaking detail the player's own car got (round-3: "improve the
  // NPC car models too"). A city street can have a dozen-plus of these cars
  // on screen at once, and this project's own smoke test caught a real
  // performance cliff from adding these as one THREE.Mesh (= one draw call)
  // each: 8 extra draw calls × ~16-20 traffic cars was enough to make the
  // (software-rendered, worst-case) test browser become fully unresponsive
  // a couple of scripted actions later. Baking the bumpers+mirrors into one
  // merged geometry/mesh, and the 4 rim discs into another, keeps the exact
  // same visual detail at 2 extra draw calls per car instead of 8.
  const trimMat = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.55, metalness: 0.7 });
  const trimGeos = [];
  const fbGeo = new THREE.BoxGeometry(W * 0.98, H * 0.2, 0.22);
  fbGeo.translate(0, H * 0.22, L / 2 - 0.13);
  trimGeos.push(fbGeo);
  const rbGeo = new THREE.BoxGeometry(W * 0.98, H * 0.2, 0.22);
  rbGeo.translate(0, H * 0.22, -L / 2 + 0.13);
  trimGeos.push(rbGeo);
  [-1, 1].forEach((side) => {
    const mGeo = new THREE.BoxGeometry(0.14, 0.1, 0.22);
    mGeo.translate(side * (W / 2 + 0.05), H * 0.58, L * 0.14);
    trimGeos.push(mGeo);
  });
  // Round-4 polish pass ("NPC cars should look as good as the player's/the
  // UFO"): door handles folded into this SAME merged mesh (still one draw
  // call, same trick this file already uses for bumpers+mirrors) rather
  // than a chrome material change — a dark plastic handle reads fine at
  // traffic-car viewing distance and keeps the chrome material reserved for
  // the rim discs, so this doesn't cost anything extra to draw.
  [-1, 1].forEach((side) => {
    const hGeo = new THREE.BoxGeometry(0.05, 0.045, 0.22);
    hGeo.translate(side * (W / 2 + 0.015), H * 0.46, L * 0.02);
    trimGeos.push(hGeo);
  });
  // Round-6: A/C-pillars framing the now-actually-glass cabin (see cabinMat
  // above) — thin dark posts at the four corners of the greenhouse, folded
  // into this same merged mesh so they're still free (no extra draw call).
  // Without these the glass just floats edge-to-edge against the paint,
  // which reads flat; real pillars are what makes it look like a window
  // instead of a tinted panel.
  const cabinHalfW = (W * style.cabinWFrac) / 2;
  const cabinFrontZ = L * style.cabinZFrac + (L * style.cabinLFrac) / 2;
  const cabinRearZ = L * style.cabinZFrac - (L * style.cabinLFrac) / 2;
  const cabinTopY = H * 0.68 + (H * style.cabinHFrac) / 2;
  [-1, 1].forEach((side) => {
    const aPillar = new THREE.BoxGeometry(0.06, H * style.cabinHFrac, 0.06);
    aPillar.translate(side * cabinHalfW, H * 0.68, cabinFrontZ);
    trimGeos.push(aPillar);
    const cPillar = new THREE.BoxGeometry(0.06, H * style.cabinHFrac, 0.06);
    cPillar.translate(side * cabinHalfW, H * 0.68, cabinRearZ);
    trimGeos.push(cPillar);
  });
  const trimMesh = new THREE.Mesh(mergeGeometries(trimGeos), trimMat);
  group.add(trimMesh);
  trimGeos.forEach((g) => g.dispose());

  // Chrome cowl strip (where windshield meets the body) + roof drip rails —
  // same "frame the glass instead of leaving it floating against paint"
  // detail added to the player's own car this round. Merged into its own
  // single chrome mesh, so still just +1 draw call per traffic car.
  const chromeTrimMat = new THREE.MeshStandardMaterial({ color: 0xaeb2b8, roughness: 0.4, metalness: 0.8, envMapIntensity: 0.55 });
  const chromeGeos = [];
  const cowlGeo = new THREE.BoxGeometry(W * style.cabinWFrac * 0.9, 0.03, 0.05);
  cowlGeo.translate(0, H * 0.68 - (H * style.cabinHFrac) / 2, cabinFrontZ);
  chromeGeos.push(cowlGeo);
  [-1, 1].forEach((side) => {
    const railGeo = new THREE.BoxGeometry(0.035, 0.03, L * style.cabinLFrac + 0.1);
    railGeo.translate(side * cabinHalfW, cabinTopY, L * style.cabinZFrac);
    chromeGeos.push(railGeo);
  });
  group.add(new THREE.Mesh(mergeGeometries(chromeGeos), chromeTrimMat));
  chromeGeos.forEach((g) => g.dispose());

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xaeb2b8, roughness: 0.4, metalness: 0.8, envMapIntensity: 0.55 });
  const wheelRadius = Math.min(0.44, 0.34 + (H - 1.3) * 0.1);
  const frontZ = L / 2 - 0.7, rearZ = -L / 2 + 0.6;
  // Round 8 ("во время поворота передние колеса поворачивались"): the front
  // pair used to be plain meshes baked at a fixed heading, same as the rear
  // pair — nothing on the car ever visually steered, so even a perfectly
  // smooth curved path read as the whole car sliding sideways rather than
  // turning like a real one. The rear wheels stay exactly as before (their
  // rim geometry stays merged into one shared mesh for the draw-call
  // budget), but each FRONT wheel (tire + its own rim, unmerged so each can
  // rotate independently) now sits inside its own pivot Group positioned at
  // the wheel's local origin — update() below just sets that pivot's
  // rotation.y from the car's current steering angle every frame, exactly
  // the same "rotate a small child group around Y" trick vehicle.js already
  // uses for the player's own front wheels.
  const frontWheels = [];
  const rearRimGeos = [];
  [
    { x: -W / 2, z: frontZ, front: true },
    { x: W / 2, z: frontZ, front: true },
    { x: -W / 2, z: rearZ, front: false },
    { x: W / 2, z: rearZ, front: false },
  ].forEach(({ x: wx, z: wz, front }) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius, wheelRadius, 0.28, 14), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    const rim = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius * 0.56, wheelRadius * 0.56, 0.3, 12), rimMat);
    rim.rotation.z = Math.PI / 2;
    if (front) {
      const pivot = new THREE.Group();
      pivot.position.set(wx, wheelRadius, wz);
      pivot.add(wheel);
      pivot.add(rim);
      group.add(pivot);
      frontWheels.push(pivot);
    } else {
      wheel.position.set(wx, wheelRadius, wz);
      group.add(wheel);
      const rGeo = new THREE.CylinderGeometry(wheelRadius * 0.56, wheelRadius * 0.56, 0.3, 12);
      rGeo.rotateZ(Math.PI / 2);
      rGeo.translate(wx, wheelRadius, wz);
      rearRimGeos.push(rGeo);
    }
  });
  const rearRimMesh = new THREE.Mesh(mergeGeometries(rearRimGeos), rimMat);
  group.add(rearRimMesh);
  rearRimGeos.forEach((g) => g.dispose());
  // Fake (non-lit) head/tail lamps — an actual light source per traffic car
  // would tank performance with a dozen+ of them on screen, so these are
  // emissive-only, just like the parked cars. Round-4: added a slim DRL
  // strip under each headlight (the "premium modern car" tell the player's
  // own car just got) — merged into the SAME mesh as the headlight spheres
  // so this is still exactly one draw call for the front lights, not two.
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.2 });
  const headGeos = [];
  const tailGeos = [];
  [-W * 0.32, W * 0.32].forEach((x) => {
    const hlGeo = new THREE.SphereGeometry(0.08, 8, 8);
    hlGeo.translate(x, 0.42, L / 2 - 0.05);
    headGeos.push(hlGeo);
    const drlGeo = new THREE.BoxGeometry(0.2, 0.022, 0.04);
    drlGeo.translate(x, 0.3, L / 2 - 0.05);
    headGeos.push(drlGeo);
    const tlGeo = new THREE.SphereGeometry(0.07, 8, 8);
    tlGeo.translate(x, 0.42, -L / 2 + 0.05);
    tailGeos.push(tlGeo);
  });
  group.add(new THREE.Mesh(mergeGeometries(headGeos), headMat));
  headGeos.forEach((g) => g.dispose());
  group.add(new THREE.Mesh(mergeGeometries(tailGeos), tailMat));
  tailGeos.forEach((g) => g.dispose());
  return { group, bodyMat, dims: { w: W, h: H, l: L }, frontWheels };
}

// Four axis-aligned directions in street-grid INDEX space (exactly one of
// dx/dz is ±1 — the grid is uniform, so that's already a world-space unit
// vector too).
const DIRS = [
  { dx: 0, dz: 1 }, { dx: 0, dz: -1 }, { dx: 1, dz: 0 }, { dx: -1, dz: 0 },
];

export class TrafficSystem {
  constructor(THREE, CANNON, world, scene, streetCoords, { laneOffset = 2.6, count = 16 } = {}) {
    this.THREE = THREE;
    this.CANNON = CANNON;
    this.world = world;
    this.scene = scene;
    this.streetCoords = streetCoords;
    this.laneOffset = laneOffset;
    this.n = streetCoords.length;
    this.cars = [];
    this.setCount(count);
  }

  // World-space position of a lane point at grid node (ix,iz), offset to the
  // right of travel direction (dx,dz) so opposite-direction traffic on the
  // same street occupies two visually distinct lanes instead of one shared
  // centerline.
  _laneWorld(ix, iz, dx, dz) {
    const x = this.streetCoords[ix], z = this.streetCoords[iz];
    const rightX = dz, rightZ = -dx; // perpendicular to (dx,dz) in the XZ plane
    return { x: x + rightX * this.laneOffset, z: z + rightZ * this.laneOffset };
  }

  _validDirs(ix, iz, excludeReverse) {
    const out = [];
    for (const d of DIRS) {
      if (excludeReverse && d.dx === -excludeReverse.dx && d.dz === -excludeReverse.dz) continue;
      const nx = ix + d.dx, nz = iz + d.dz;
      if (nx >= 0 && nx < this.n && nz >= 0 && nz < this.n) out.push(d);
    }
    return out;
  }

  _spawnCar() {
    const ix = randInt(0, this.n - 1);
    const iz = randInt(0, this.n - 1);
    const dirs = this._validDirs(ix, iz, null);
    const dir = choice(dirs);
    const color = choice(TRAFFIC_COLORS);
    const styleKey = choice(CAR_STYLE_KEYS);

    const { group: mesh, bodyMat, dims, frontWheels } = buildTrafficCarMesh(this.THREE, color, styleKey);
    this.scene.add(mesh);

    const shape = new this.CANNON.Box(new this.CANNON.Vec3(dims.w / 2, dims.h / 2, dims.l / 2));
    const body = new this.CANNON.Body({ mass: 0, type: this.CANNON.Body.KINEMATIC, shape });
    this.world.addBody(body);

    const car = {
      mesh, body, bodyMat, baseColor: color, dims, frontWheels,
      ix, iz, dx: dir.dx, dz: dir.dz,
      t: rand(0, 1),
      speed: rand(4.5, 8),
      targetSpeed: rand(4.5, 8),
      turnSpeed: 5,
      turn: null, // set while rounding a corner — see _beginTurn()/_placeCarOnArc()
      // Round 8 ("ездили по правилам", no more constant pile-ups): a car
      // waiting to turn left across oncoming traffic locks in its chosen
      // direction here (see the t>=1 decision block in update()) instead of
      // re-rolling a new random direction every single frame it's stuck
      // waiting — and yieldWait forces it to keep braking on every
      // subsequent frame until the crossing is actually clear.
      pendingPick: null,
      yieldWait: false,
      zeroSpeedTime: 0,
      steerAngle: 0,
      lastYaw: Math.atan2(dir.dx, dir.dz),
      lastPos: new this.THREE.Vector3(),
      // Damage reaction state — see registerHit() and its use in update()
      // below. hitFlash drives a brief blinking dark-damage tint on the
      // body paint; stunTime forces the car to brake to a stop for a beat,
      // the way a real driver would after getting rammed, instead of a
      // traffic car sailing through a hard hit with zero reaction.
      hitFlash: 0,
      stunTime: 0,
    };
    body.userData = { isTraffic: true, trafficRef: car };
    car.registerHit = (impactSpeed) => {
      const severity = Math.min(1, impactSpeed / 14);
      car.hitFlash = Math.max(car.hitFlash, 0.5 + severity * 0.7);
      car.stunTime = Math.max(car.stunTime, severity * 1.6);
    };
    this._placeCar(car);
    car.lastPos.copy(car.mesh.position);
    return car;
  }

  _placeCar(car) {
    const from = this._laneWorld(car.ix, car.iz, car.dx, car.dz);
    const to = this._laneWorld(car.ix + car.dx, car.iz + car.dz, car.dx, car.dz);
    const x = from.x + (to.x - from.x) * car.t;
    const z = from.z + (to.z - from.z) * car.t;
    const yaw = Math.atan2(car.dx, car.dz);
    car.mesh.position.set(x, 0, z);
    car.mesh.rotation.y = yaw;
    car.body.position.set(x, car.dims.h / 2, z);
    car.body.quaternion.setFromEuler(0, yaw, 0);
  }

  setCount(n) {
    while (this.cars.length < n) this.cars.push(this._spawnCar());
    while (this.cars.length > n) {
      const car = this.cars.pop();
      this.scene.remove(car.mesh);
      this.world.removeBody(car.body);
    }
  }

  // True if `pos` is roughly ahead of `car` along its current heading and
  // within `lateral` of its lane centerline — the shared test behind both
  // "brake for the traffic car ahead" and "brake for the player ahead".
  _isAheadAndClose(car, pos, lateral, lookahead) {
    const toX = pos.x - car.mesh.position.x, toZ = pos.z - car.mesh.position.z;
    const dist = Math.hypot(toX, toZ);
    if (dist > lookahead) return false;
    const aheadDot = toX * car.dx + toZ * car.dz; // >0 means ahead along our heading
    const lateralOff = Math.abs(toX * car.dz - toZ * car.dx); // perpendicular offset from our lane
    return aheadDot > 0.5 && lateralOff < lateral;
  }

  /**
   * Kick off a smooth, curved hand-off between two lanes instead of
   * snapping directly from one to the other. Before this existed, reaching
   * an intersection with a new direction picked just reassigned car.dx/dz
   * and re-ran _placeCar() on the SAME frame: since a lane's position is
   * offset sideways from the street centerline (see _laneWorld) and that
   * offset rotates 90° with the direction, the car's position visibly
   * "popped" sideways at the exact same instant its heading snapped 90° —
   * a real turn made no visual sense, closer to a car teleporting into a
   * new orientation than steering into a corner. Now the car instead
   * travels a short quadratic Bézier arc from where it actually is (the
   * old lane's arrival point) to where the new lane starts, with its
   * heading following the arc's own tangent the whole way — continuous,
   * no snap — and a slower speed target while committed to the curve, the
   * way a real driver eases off the gas through a corner instead of
   * carrying full straight-away speed into it.
   */
  _beginTurn(car, newDir) {
    const p0 = this._laneWorld(car.ix, car.iz, car.dx, car.dz);
    const p2 = this._laneWorld(car.ix, car.iz, newDir.dx, newDir.dz);
    const nodeX = this.streetCoords[car.ix], nodeZ = this.streetCoords[car.iz];
    const chord = Math.hypot(p2.x - p0.x, p2.z - p0.z);
    car.turn = { p0, p1: { x: nodeX, z: nodeZ }, p2, s: 0, len: Math.max(chord * 1.18, 2) };
    car.dx = newDir.dx;
    car.dz = newDir.dz;
    car.turnSpeed = rand(3, 5); // real drivers slow down for corners, not just intersections with cars in them
  }

  // Position + heading partway along the current turn arc (quadratic
  // Bézier through the intersection); heading comes from the curve's own
  // tangent so it turns continuously instead of jumping between the two
  // lanes' fixed headings.
  _placeCarOnArc(car) {
    const s = Math.min(1, car.turn.s);
    const { p0, p1, p2 } = car.turn;
    const x = (1 - s) * (1 - s) * p0.x + 2 * (1 - s) * s * p1.x + s * s * p2.x;
    const z = (1 - s) * (1 - s) * p0.z + 2 * (1 - s) * s * p1.z + s * s * p2.z;
    const tx = 2 * (1 - s) * (p1.x - p0.x) + 2 * s * (p2.x - p1.x);
    const tz = 2 * (1 - s) * (p1.z - p0.z) + 2 * s * (p2.z - p1.z);
    const yaw = Math.hypot(tx, tz) > 1e-4 ? Math.atan2(tx, tz) : car.mesh.rotation.y;
    car.mesh.position.set(x, 0, z);
    car.mesh.rotation.y = yaw;
    car.body.position.set(x, car.dims.h / 2, z);
    car.body.quaternion.setFromEuler(0, yaw, 0);
  }

  /**
   * @param obstacles optional list of `{x, z, lateral?, lookahead?,
   *   panicRadius?}` points to also brake for — main.js passes the local
   *   player's car (and, so AI "reacts to players" plural, every connected
   *   remote player's car too) here every frame. Wider tolerances than the
   *   traffic-vs-traffic check on purpose: a human driver doesn't reliably
   *   stay lane-perfect the way scripted traffic does, so a real driver
   *   reacting to one gives it more room to be sloppy — and `panicRadius`
   *   is an omnidirectional "someone is right on top of us" check that
   *   ignores lane/heading entirely, for when a player rams in sideways or
   *   stops across the lane rather than staying neatly in front.
   * @param trafficLights optional TrafficLightSystem (see trafficLights.js) —
   *   Round 7 ("add traffic lights so NPCs don't crash into each other").
   *   When present, a car approaching (but not yet turning/committed into)
   *   an intersection also brakes if its direction of travel's axis isn't
   *   the one currently lit green — cars driving along z ("ns") and cars
   *   driving along x ("ew") never both get a green at once (see
   *   trafficLights.js's PHASES), so this alone is enough to stop AI cars
   *   from T-boning each other at a crossing without any per-intersection
   *   state here.
   */
  update(dt, obstacles = [], trafficLights = null) {
    const segLen = this.streetCoords[1] !== undefined ? Math.abs(this.streetCoords[1] - this.streetCoords[0]) : 34;

    for (const car of this.cars) {
      // Damage reaction: a blinking dark tint while hitFlash counts down,
      // and a forced stop while stunTime counts down — see registerHit(),
      // called from vehicle.js's _onChassisCollide() when the player rams
      // this car hard enough. Restores the car's real paint color the
      // instant the flash ends rather than leaving it stuck mid-blink.
      if (car.hitFlash > 0) {
        car.hitFlash = Math.max(0, car.hitFlash - dt);
        const blink = Math.floor(car.hitFlash * 12) % 2 === 0;
        car.bodyMat.color.setHex(blink ? 0x2a0a0a : car.baseColor);
        if (car.hitFlash === 0) car.bodyMat.color.setHex(car.baseColor);
      }
      if (car.stunTime > 0) car.stunTime = Math.max(0, car.stunTime - dt);

      // Brake for the nearest car ahead of us in roughly the same lane —
      // a lightweight stand-in for real lane reservation/intersection
      // priority, just enough that traffic doesn't visibly drive through
      // itself (or the player) in a straight line.
      //
      // Round 8 ("постоянные аварии" once traffic density goes up): this
      // used to be ONLY the heading-based "ahead in my lane" check below —
      // fine for two cars following each other down the same straight lane,
      // but blind to anything whose heading differs from ours, which is
      // exactly every car turning through (or crossing) an intersection.
      // With enough cars on the road two turning arcs — or a turning car and
      // a straight one on the crossing street — would silently pass through
      // each other with zero braking, because neither was ever "ahead" of
      // the other along either car's own heading. A plain omnidirectional
      // "something is right on top of us" distance check (same idea already
      // used for the player/remote-player `obstacles` below) closes that
      // gap regardless of either car's heading.
      let blocked = car.stunTime > 0 || car.yieldWait;
      if (!blocked) {
        for (const other of this.cars) {
          if (other === car) continue;
          // The omnidirectional distance check only matters for the case it
          // was added for — at least one of the two cars mid-turn, where
          // headings genuinely don't line up with either car's own "ahead"
          // cone. Applying it unconditionally to EVERY pair turned out to
          // cause its own, worse bug: two cars that are simply stopped near
          // the same corner for unrelated reasons (e.g. each waiting on its
          // own street's red light, and the two streets' stop-line points
          // happen to sit within a couple of units of each other by plain
          // intersection geometry) would then permanently hold each other
          // "too close to move" — neither one is a real collision risk to
          // the other, but neither can ever get far enough away to clear the
          // check either, since neither is actually driving anywhere. Two
          // cars actually converging while at least one is turning don't
          // have that failure mode: a turn is a short, bounded maneuver, so
          // this check can't wedge two genuinely turning cars into a
          // standoff that lasts forever the way two independently-parked
          // ones could.
          if (car.turn || other.turn) {
            const ddx = other.mesh.position.x - car.mesh.position.x;
            const ddz = other.mesh.position.z - car.mesh.position.z;
            if (Math.hypot(ddx, ddz) < 2.6) { blocked = true; break; }
          }
          if (this._isAheadAndClose(car, other.mesh.position, 2.2, 7)) { blocked = true; break; }
        }
      }
      if (!blocked) {
        for (const obs of obstacles) {
          const dx = obs.x - car.mesh.position.x, dz = obs.z - car.mesh.position.z;
          if (Math.hypot(dx, dz) < (obs.panicRadius ?? 3.4)) { blocked = true; break; }
          if (this._isAheadAndClose(car, obs, obs.lateral ?? 3, obs.lookahead ?? 10)) { blocked = true; break; }
        }
      }
      // Round 7: red-light braking. Only while cruising a straight segment
      // toward the next node (not already mid-turn — a car committed into
      // the intersection finishes crossing rather than freezing halfway
      // through it) and only in a "stop line" window shortly before arrival:
      // too early and cars visibly brake far from the corner for no reason,
      // too late (t very close to 1) and a car that just missed the yellow
      // ends up stopped blocking the box instead of clearing it.
      if (!blocked && trafficLights && !car.turn && car.t > 0.55 && car.t < 0.93) {
        const axis = car.dx !== 0 ? 'ew' : 'ns';
        if (!trafficLights.isGreenForAxis(axis)) blocked = true;
      }

      // Anti-gridlock safety net: if a car has sat essentially stationary
      // AND "blocked" for an implausibly long stretch — longer than one full
      // red-light cycle could ever legitimately hold it (see PHASES in
      // trafficLights.js: worst case is well under 12s) — something has
      // wedged it (a scripted-AI edge case neither of the checks above
      // anticipated, not a real, currently-relevant obstruction), and it
      // should ease back onto the road rather than sit there forever.
      if (blocked && Math.abs(car.speed) < 0.1 && car.stunTime <= 0 && !car.yieldWait) {
        car.zeroSpeedTime = (car.zeroSpeedTime || 0) + dt;
        if (car.zeroSpeedTime > 14) blocked = false;
      } else {
        car.zeroSpeedTime = 0;
      }

      const cruiseTarget = car.turn ? car.turnSpeed : car.targetSpeed;
      car.targetSpeed = blocked ? 0 : cruiseTarget;
      car.speed += ((blocked ? 0 : Math.max(car.speed, 3)) - car.speed) * Math.min(1, dt * 2.2);
      if (blocked) car.speed = Math.max(0, car.speed - dt * 9);

      if (car.turn) {
        car.turn.s += (car.speed * dt) / car.turn.len;
        if (car.turn.s >= 1) {
          car.turn = null;
          car.t = 0;
          car.targetSpeed = rand(4.5, 8);
          this._placeCar(car);
        } else {
          this._placeCarOnArc(car);
        }
      } else {
        car.t += (car.speed * dt) / segLen;

        if (car.t >= 1) {
          const nix = car.ix + car.dx, niz = car.iz + car.dz;
          // Decide (or keep re-using a still-pending) direction for this
          // corner BEFORE actually committing to it. Round 8 ("ездили по
          // правилам"): an unprotected left turn has to give way to a car
          // still coming the other way down the same street — the single
          // rule the old code never modeled at all, and (together with the
          // omnidirectional check above) the other big source of "constant
          // crashes" once there's enough traffic for that to come up often.
          // The pick is cached on the car (not re-rolled every frame it's
          // stuck waiting) so a car doesn't flicker between different
          // random directions while yielding — same real driver, same
          // intention, just waiting for a gap.
          let pick = car.pendingPick;
          if (!pick) {
            const dirs = this._validDirs(nix, niz, car.dx);
            // Heavily favor continuing straight so traffic reads as cars
            // going somewhere, not randomly zig-zagging at every corner.
            const straight = dirs.find((d) => d.dx === car.dx && d.dz === car.dz);
            pick = straight && rand(0, 1) < 0.72 ? straight : choice(dirs.length ? dirs : this._validDirs(nix, niz, null));
            car.pendingPick = pick;
          }

          const isLeftTurn = car.dx * pick.dz - car.dz * pick.dx > 0.5;
          const oncomingClose = isLeftTurn && this.cars.some((other) => (
            other !== car && !other.turn &&
            other.dx === -car.dx && other.dz === -car.dz &&
            other.ix + other.dx === nix && other.iz + other.dz === niz &&
            other.t > 0.35
          ));

          if (oncomingClose) {
            // Hold right at the corner — a real driver doesn't turn left
            // across oncoming traffic just because the light happens to be
            // green for both directions at once.
            car.t = 0.999;
            car.yieldWait = true;
          } else {
            car.yieldWait = false;
            car.pendingPick = null;
            car.t -= 1;
            car.ix = nix;
            car.iz = niz;
            if (pick.dx === car.dx && pick.dz === car.dz) {
              car.targetSpeed = rand(4.5, 8);
              this._placeCar(car);
            } else {
              this._beginTurn(car, pick);
              this._placeCarOnArc(car);
            }
          }
        } else {
          this._placeCar(car);
        }
      }

      // Round 8 ("во время поворота передние колеса поворачивались"): a
      // visual-only front-wheel steering angle, derived from how fast the
      // car's own heading actually changed this frame rather than from any
      // separate "am I turning" flag — that keeps it perfectly in sync with
      // the curved arc's own smoothly-changing tangent (see
      // _placeCarOnArc()) during a turn, and naturally relaxes back to
      // dead-ahead the instant the car is driving straight again, with no
      // special-casing needed for either state.
      let dyaw = car.mesh.rotation.y - car.lastYaw;
      if (dyaw > Math.PI) dyaw -= Math.PI * 2;
      else if (dyaw < -Math.PI) dyaw += Math.PI * 2;
      car.lastYaw = car.mesh.rotation.y;
      const yawRate = dyaw / Math.max(dt, 1 / 240);
      const wheelBase = car.dims.l * 0.58;
      const speedForSteer = Math.max(Math.abs(car.speed), 1.5);
      const rawSteer = Math.max(-MAX_STEER_VISUAL, Math.min(MAX_STEER_VISUAL, Math.atan2(yawRate * wheelBase, speedForSteer)));
      car.steerAngle += (rawSteer - car.steerAngle) * Math.min(1, dt * 10);
      if (car.frontWheels) {
        car.frontWheels[0].rotation.y = car.steerAngle;
        car.frontWheels[1].rotation.y = car.steerAngle;
      }

      // Kinematic bodies aren't pushed by cannon-es, but they DO need a
      // real velocity set so the player's car (a dynamic body) gets a
      // correct impulse when it hits one, instead of bouncing off
      // something the engine thinks is standing still.
      car.body.velocity.set(
        (car.mesh.position.x - car.lastPos.x) / Math.max(dt, 1 / 240),
        0,
        (car.mesh.position.z - car.lastPos.z) / Math.max(dt, 1 / 240)
      );
      car.lastPos.copy(car.mesh.position);
    }
  }

  dispose() {
    for (const car of this.cars) {
      this.scene.remove(car.mesh);
      this.world.removeBody(car.body);
    }
    this.cars = [];
  }
}
