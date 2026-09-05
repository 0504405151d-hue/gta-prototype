// AI street traffic: cars that drive themselves around the same street grid
// city.js builds, on a simple node graph (one node per intersection). Each
// car keeps a lane offset to the right of the centerline so opposite-flowing
// traffic doesn't overlap, brakes for whatever's ahead of it in its own
// lane, and picks a new direction (mostly straight, sometimes a turn) every
// time it reaches an intersection. Movement is fully scripted (no real
// steering physics) but every car still owns a real KINEMATIC cannon-es
// body, so the player's own (dynamic) car can actually crash into one —
// cannon-es resolves that collision using the traffic car's real velocity,
// it just isn't itself pushed around by anything.

import { rand, randInt, choice } from './utils.js';

const CAR_W = 1.9, CAR_H = 1.3, CAR_L = 4.2;
const TRAFFIC_COLORS = [0x2b6fd8, 0xd0d0d6, 0x1a1c22, 0xb32020, 0xd7a52c, 0x2f7d4a, 0x6b6f76];

function buildTrafficCarMesh(THREE, color) {
  const group = new THREE.Group();
  const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.4, metalness: 0.6, clearcoat: 1, clearcoatRoughness: 0.35 });
  const base = new THREE.Mesh(new THREE.BoxGeometry(CAR_W, CAR_H * 0.5, CAR_L), bodyMat);
  base.position.y = CAR_H * 0.32;
  base.castShadow = true;
  base.receiveShadow = true;
  group.add(base);
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(CAR_W * 0.8, CAR_H * 0.42, CAR_L * 0.48),
    new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.1, metalness: 0.15, clearcoat: 0.5 })
  );
  cabin.position.set(0, CAR_H * 0.68, -CAR_L * 0.05);
  cabin.castShadow = true;
  group.add(cabin);
  const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.9 });
  [[-CAR_W / 2, CAR_L / 2 - 0.7], [CAR_W / 2, CAR_L / 2 - 0.7], [-CAR_W / 2, -CAR_L / 2 + 0.6], [CAR_W / 2, -CAR_L / 2 + 0.6]].forEach(([wx, wz]) => {
    const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.28, 14), wheelMat);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.set(wx, 0.34, wz);
    group.add(wheel);
  });
  // Fake (non-lit) head/tail lamps — an actual light source per traffic car
  // would tank performance with a dozen+ of them on screen, so these are
  // emissive-only, just like the parked cars.
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 2.2 });
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.2 });
  [-0.6, 0.6].forEach((x) => {
    const hl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), headMat);
    hl.position.set(x, 0.42, CAR_L / 2 - 0.05);
    group.add(hl);
    const tl = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 8), tailMat);
    tl.position.set(x, 0.42, -CAR_L / 2 + 0.05);
    group.add(tl);
  });
  return group;
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

    const mesh = buildTrafficCarMesh(this.THREE, color);
    this.scene.add(mesh);

    const shape = new this.CANNON.Box(new this.CANNON.Vec3(CAR_W / 2, CAR_H / 2, CAR_L / 2));
    const body = new this.CANNON.Body({ mass: 0, type: this.CANNON.Body.KINEMATIC, shape });
    body.userData = { isTraffic: true };
    this.world.addBody(body);

    const car = {
      mesh, body,
      ix, iz, dx: dir.dx, dz: dir.dz,
      t: rand(0, 1),
      speed: rand(4.5, 8),
      targetSpeed: rand(4.5, 8),
      lastPos: new this.THREE.Vector3(),
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

  update(dt) {
    const segLen = this.streetCoords[1] !== undefined ? Math.abs(this.streetCoords[1] - this.streetCoords[0]) : 34;

    for (const car of this.cars) {
      // Brake for the nearest car ahead of us in roughly the same lane —
      // a lightweight stand-in for real lane reservation/intersection
      // priority, just enough that traffic doesn't visibly drive through
      // itself in a straight line.
      let blocked = false;
      for (const other of this.cars) {
        if (other === car) continue;
        const toOther = { x: other.mesh.position.x - car.mesh.position.x, z: other.mesh.position.z - car.mesh.position.z };
        const dist = Math.hypot(toOther.x, toOther.z);
        if (dist > 7) continue;
        const aheadDot = toOther.x * car.dx + toOther.z * car.dz; // >0 means other is ahead along our heading
        const lateral = Math.abs(toOther.x * car.dz - toOther.z * car.dx); // perpendicular offset
        if (aheadDot > 0.5 && lateral < 2.2) { blocked = true; break; }
      }
      car.targetSpeed = blocked ? 0 : car.targetSpeed;
      car.speed += ((blocked ? 0 : Math.max(car.speed, 4.5)) - car.speed) * Math.min(1, dt * 2);
      if (blocked) car.speed = Math.max(0, car.speed - dt * 9);

      const advance = (car.speed * dt) / segLen;
      car.t += advance;

      while (car.t >= 1) {
        car.t -= 1;
        car.ix += car.dx;
        car.iz += car.dz;
        const dirs = this._validDirs(car.ix, car.iz, car.dx);
        // Heavily favor continuing straight so traffic reads as cars going
        // somewhere, not randomly zig-zagging at every single corner.
        const straight = dirs.find((d) => d.dx === car.dx && d.dz === car.dz);
        const pick = straight && rand(0, 1) < 0.72 ? straight : choice(dirs.length ? dirs : this._validDirs(car.ix, car.iz, null));
        car.dx = pick.dx;
        car.dz = pick.dz;
        car.targetSpeed = rand(4.5, 8);
      }

      this._placeCar(car);
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
