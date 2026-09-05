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

function buildTrafficCarMesh(THREE, color) {
  const group = new THREE.Group();
  // Round-3 glare pass: same clearcoat/roughness/envMapIntensity softening
  // applied to the player's own paint (see vehicle.js) — traffic paint was
  // just as mirror-hot in direct sun as the player car used to be.
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.46, metalness: 0.55, clearcoat: 0.65, clearcoatRoughness: 0.55, envMapIntensity: 0.5 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(CAR_W, CAR_H * 0.5, CAR_L), bodyMat);
  base.position.y = CAR_H * 0.32;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_W * 0.8, CAR_H * 0.42, CAR_L * 0.48),
    new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.2, metalness: 0.15, clearcoat: 0.3, clearcoatRoughness: 0.45, envMapIntensity: 0.5 })
  );
  cabin.position.set(0, CAR_H * 0.68, -CAR_L * 0.05);
  cabin.castShadow = true;
  group.add(cabin);

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
  const fbGeo = new THREE.BoxGeometry(CAR_W * 0.98, CAR_H * 0.2, 0.22);
  fbGeo.translate(0, CAR_H * 0.22, CAR_L / 2 - 0.13);
  trimGeos.push(fbGeo);
  const rbGeo = new THREE.BoxGeometry(CAR_W * 0.98, CAR_H * 0.2, 0.22);
  rbGeo.translate(0, CAR_H * 0.22, -CAR_L / 2 + 0.13);
  trimGeos.push(rbGeo);
  [-1, 1].forEach((side) => {
    const mGeo = new THREE.BoxGeometry(0.14, 0.1, 0.22);
    mGeo.translate(side * (CAR_W / 2 + 0.05), CAR_H * 0.58, CAR_L * 0.14);
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
    hGeo.translate(side * (CAR_W / 2 + 0.015), CAR_H * 0.46, CAR_L * 0.02);
    trimGeos.push(hGeo);
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
  const cowlGeo = new THREE.BoxGeometry(CAR_W * 0.72, 0.03, 0.05);
  cowlGeo.translate(0, CAR_H * 0.47, -CAR_L * 0.05 + CAR_L * 0.24);
  chromeGeos.push(cowlGeo);
  [-1, 1].forEach((side) => {
    const railGeo = new THREE.BoxGeometry(0.035, 0.03, CAR_L * 0.48 + 0.1);
    railGeo.translate(side * (CAR_W * 0.8 / 2), CAR_H * 0.9, -CAR_L * 0.05);
    chromeGeos.push(railGeo);
  });
  group.add(new THREE.Mesh(mergeGeometries(chromeGeos), chromeTrimMat));
  chromeGeos.forEach((g) => g.dispose());

  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  const rimMat = new THREE.MeshStandardMaterial({ color: 0xaeb2b8, roughness: 0.4, metalness: 0.8, envMapIntensity: 0.55 });
  const wheelSpots = [[-CAR_W / 2, CAR_L / 2 - 0.7], [CAR_W / 2, CAR_L / 2 - 0.7], [-CAR_W / 2, -CAR_L / 2 + 0.6], [CAR_W / 2, -CAR_L / 2 + 0.6]];
  const rimGeos = [];
  wheelSpots.forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 14), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    group.add(wheel);
    const rGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.3, 12);
    rGeo.rotateZ(Math.PI / 2);
    rGeo.translate(wx, 0.34, wz);
    rimGeos.push(rGeo);
  });
  const rimMesh = new THREE.Mesh(mergeGeometries(rimGeos), rimMat);
  group.add(rimMesh);
  rimGeos.forEach((g) => g.dispose());
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
  [-0.6, 0.6].forEach((x) => {
    const hlGeo = new THREE.SphereGeometry(0.08, 8, 8);
    hlGeo.translate(x, 0.42, CAR_L / 2 - 0.05);
    headGeos.push(hlGeo);
    const drlGeo = new THREE.BoxGeometry(0.2, 0.022, 0.04);
    drlGeo.translate(x, 0.3, CAR_L / 2 - 0.05);
    headGeos.push(drlGeo);
    const tlGeo = new THREE.SphereGeometry(0.07, 8, 8);
    tlGeo.translate(x, 0.42, -CAR_L / 2 + 0.05);
    tailGeos.push(tlGeo);
  });
  group.add(new THREE.Mesh(mergeGeometries(headGeos), headMat));
  headGeos.forEach((g) => g.dispose());
  group.add(new THREE.Mesh(mergeGeometries(tailGeos), tailMat));
  tailGeos.forEach((g) => g.dispose());
  return { group, bodyMat };
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

    const { group: mesh, bodyMat } = buildTrafficCarMesh(this.THREE, color);
    this.scene.add(mesh);

    const shape = new this.CANNON.Box(new this.CANNON.Vec3(CAR_W / 2, CAR_H / 2, CAR_L / 2));
    const body = new this.CANNON.Body({ mass: 0, type: this.CANNON.Body.KINEMATIC, shape });
    this.world.addBody(body);

    const car = {
      mesh, body, bodyMat, baseColor: color,
      ix, iz, dx: dir.dx, dz: dir.dz,
      t: rand(0, 1),
      speed: rand(4.5, 8),
      targetSpeed: rand(4.5, 8),
      turnSpeed: 5,
      turn: null, // set while rounding a corner — see _beginTurn()/_placeCarOnArc()
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
    car.body.position.set(x, CAR_H / 2, z);
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
    car.body.position.set(x, CAR_H / 2, z);
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
   */
  update(dt, obstacles = []) {
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
      let blocked = car.stunTime > 0;
      if (!blocked) {
        for (const other of this.cars) {
          if (other === car) continue;
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
          car.t -= 1;
          car.ix += car.dx;
          car.iz += car.dz;
          const dirs = this._validDirs(car.ix, car.iz, car.dx);
          // Heavily favor continuing straight so traffic reads as cars
          // going somewhere, not randomly zig-zagging at every corner.
          const straight = dirs.find((d) => d.dx === car.dx && d.dz === car.dz);
          const pick = straight && rand(0, 1) < 0.72 ? straight : choice(dirs.length ? dirs : this._validDirs(car.ix, car.iz, null));
          if (pick.dx === car.dx && pick.dz === car.dz) {
            car.targetSpeed = rand(4.5, 8);
            this._placeCar(car);
          } else {
            this._beginTurn(car, pick);
            this._placeCarOnArc(car);
          }
        } else {
          this._placeCar(car);
        }
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
