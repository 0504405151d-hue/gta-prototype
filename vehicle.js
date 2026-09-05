// A drivable car: cannon-es RaycastVehicle (chassis + 4 raycast wheels with
// suspension) driving a Three.js mesh. Tuned for a "GTA San Andreas-ish"
// arcade-but-weighty feel: body roll, suspension travel, drift on handbrake.
//
// Also owns two bits of "juice" that read straight off the physics rather
// than being faked: a per-vertex body dent that grows out of real collision
// points/speeds against buildings, and per-wheel skid state (from cannon-es's
// own tire slip model) that main.js uses to trigger skid marks/dust/sound.

export const WHEEL_RADIUS = 0.36;

const DENT_RADIUS = 0.85;
const DENT_MAX_PUSH = 0.22;
const DENT_SPEED_THRESHOLD = 3.2;
const CHASSIS_Y_OFFSET = 0.4; // how far the collision box sits above the body origin (wheel-mount height)
const ANTI_ROLL_STIFFNESS = 9000; // empirically tuned in a headless test — see fix notes below

/**
 * Fix for a real flip-prone-car bug, found by reading cannon-es's own source
 * rather than guessing: Body.updateMassProperties() derives the chassis's
 * rotational inertia purely from the collision box's own size, ignoring that
 * the box is mounted CHASSIS_Y_OFFSET above the body's rotation origin. Real
 * physics requires the parallel-axis correction (I += mass * offset^2) for
 * any axis whose rotation would move that offset mass — here, pitch (x) and
 * roll (z), since the offset is purely vertical. Without this, roll inertia
 * alone came out ~32% too low (verified: 55.4 vs the physically-correct
 * 81.9 kg·m^2 for this chassis/mass), which is exactly the failure mode of
 * "tips/flips far more easily than a real car of this size and weight would"
 * — confirmed in a standalone headless test where a curb clip that stayed
 * fully stable with the fix flipped the car outright without it.
 */
function applyChassisInertiaFix(chassisBody, offsetY) {
  const parallelAxis = chassisBody.mass * offsetY * offsetY;
  chassisBody.inertia.x += parallelAxis;
  chassisBody.inertia.z += parallelAxis;
  chassisBody.invInertia.set(
    chassisBody.inertia.x > 0 ? 1 / chassisBody.inertia.x : 0,
    chassisBody.inertia.y > 0 ? 1 / chassisBody.inertia.y : 0,
    chassisBody.inertia.z > 0 ? 1 / chassisBody.inertia.z : 0
  );
  chassisBody.updateInertiaWorld(true);
}

export class Vehicle {
  constructor(THREE, CANNON, world, scene, { color = 0xff3b30, position = { x: 0, y: 1.2, z: 0 }, heading = 0, onEffect } = {}) {
    this.THREE = THREE;
    this.CANNON = CANNON;
    this.world = world;
    this.onEffect = onEffect || (() => {});

    // ---------- Chassis ----------
    const chassisW = 1.9, chassisH = 0.65, chassisL = 4.2;
    this.dims = { chassisW, chassisH, chassisL };
    const chassisShape = new CANNON.Box(new CANNON.Vec3(chassisW / 2, chassisH / 2, chassisL / 2));
    const chassisBody = new CANNON.Body({ mass: 165, material: new CANNON.Material('chassis') });
    chassisBody.addShape(chassisShape, new CANNON.Vec3(0, CHASSIS_Y_OFFSET, 0));
    chassisBody.position.set(position.x, position.y, position.z);
    chassisBody.quaternion.setFromEuler(0, heading, 0);
    chassisBody.angularVelocity.set(0, 0, 0);
    chassisBody.linearDamping = 0.06;
    chassisBody.angularDamping = 0.5;
    chassisBody.userData = { isVehicle: true };
    applyChassisInertiaFix(chassisBody, CHASSIS_Y_OFFSET);
    this.chassisBody = chassisBody;
    chassisBody.addEventListener('collide', (e) => this._onChassisCollide(e));

    const vehicle = new CANNON.RaycastVehicle({
      chassisBody,
      indexRightAxis: 0,
      indexUpAxis: 1,
      indexForwardAxis: 2,
    });

    // Values below were verified in a standalone headless cannon-es
    // simulation (straight-line + steering-under-load tests) to give a
    // stable, non-flipping ride at speed rather than guessed blind.
    const wheelOptions = {
      radius: WHEEL_RADIUS,
      directionLocal: new CANNON.Vec3(0, -1, 0),
      suspensionStiffness: 28,
      suspensionRestLength: 0.36,
      frictionSlip: 3.2,
      dampingRelaxation: 3.2,
      dampingCompression: 4.3,
      maxSuspensionForce: 100000,
      rollInfluence: 0.01,
      axleLocal: new CANNON.Vec3(1, 0, 0),
      chassisConnectionPointLocal: new CANNON.Vec3(),
      maxSuspensionTravel: 0.28,
      customSlidingRotationalSpeed: -32,
      useCustomSlidingRotationalSpeed: true,
    };

    const axleX = chassisW / 2 - 0.05;
    const front = chassisL / 2 - 0.75;
    const rear = -chassisL / 2 + 0.65;
    const connY = 0.05;

    const points = [
      [-axleX, connY, front],  // front-left
      [axleX, connY, front],   // front-right
      [-axleX, connY, rear],   // rear-left
      [axleX, connY, rear],    // rear-right
    ];
    points.forEach((p) => {
      wheelOptions.chassisConnectionPointLocal.set(p[0], p[1], p[2]);
      vehicle.addWheel({ ...wheelOptions });
    });
    vehicle.addToWorld(world);
    this.vehicle = vehicle;

    // ---------- Visual mesh ----------
    const group = new THREE.Group();
    scene.add(group);
    this.group = group;

    // Real car paint reads as glossy + a distinct thin clear top coat on top
    // of the color layer, which is exactly what MeshPhysicalMaterial's
    // clearcoat models — combined with the studio environment map (see
    // main.js) this is what turns the body from "flat colored plastic" into
    // something that actually looks like painted sheet metal.
    // clearcoatRoughness was 0.12 (near-mirror) — under the sun's direct
    // light that concentrated into a tiny, extremely bright specular point
    // that bloom then blew up into a solid white patch covering the car.
    // Softening it spreads that highlight into a normal glossy sheen instead
    // of a hotspot, which is what actually reads as "paint in the sun"
    // rather than "camera flash".
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.36, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.32, envMapIntensity: 1.0,
    });
    this.bodyMat = bodyMat;
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a1018, roughness: 0.1, metalness: 0.15, clearcoat: 0.5, clearcoatRoughness: 0.2, envMapIntensity: 1.2,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.5, metalness: 0.75 }); // matte black plastic trim/bumpers
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.18, metalness: 0.95 }); // mirrors/exhaust/rim accents

    const baseGeo = new THREE.BoxGeometry(chassisW, chassisH * 0.55, chassisL, 3, 2, 6);
    const base = new THREE.Mesh(baseGeo, bodyMat);
    base.position.set(0, 0.4, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);
    this.baseMesh = base;
    this.baseGeo = baseGeo;
    this._dentBase = Float32Array.from(baseGeo.attributes.position.array);
    this._dentAccum = new Float32Array(baseGeo.attributes.position.count);

    // Greenhouse built from angled panels (hood, raked windshield, roof,
    // raked rear window, trunk lid) instead of one flat box sitting on the
    // body — this is what actually reads as "a real car silhouette" rather
    // than a shoebox with a smaller shoebox on top. All angles are plain
    // rotated boxes, chosen to visually match a small sedan/hatchback
    // profile; the dentable `base` mesh above is untouched by any of this.
    const bodyTopY = 0.4 + (chassisH * 0.55) / 2; // ≈ top surface of the base slab

    const hoodLen = chassisL * 0.26;
    const hood = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.92, 0.07, hoodLen), bodyMat);
    hood.position.set(0, bodyTopY + 0.05, chassisL / 2 - hoodLen / 2 - 0.2);
    hood.rotation.x = -0.14; // dips toward the front bumper
    hood.castShadow = true;
    group.add(hood);

    const windshieldLen = chassisL * 0.17;
    const windshieldZ = chassisL / 2 - hoodLen - 0.2 - windshieldLen * 0.32;
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.78, 0.05, windshieldLen), glassMat);
    windshield.position.set(0, bodyTopY + 0.24, windshieldZ);
    windshield.rotation.x = 0.62; // raked
    group.add(windshield);

    const roofLen = chassisL * 0.3;
    const roofZ = windshieldZ - windshieldLen * 0.5 - roofLen / 2 + 0.05;
    const roof = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.76, 0.4, roofLen), bodyMat);
    roof.position.set(0, bodyTopY + 0.42, roofZ);
    roof.castShadow = true;
    group.add(roof);

    const rearWindshieldLen = chassisL * 0.15;
    const rearWindshieldZ = roofZ - roofLen / 2 - rearWindshieldLen * 0.32;
    const rearWindshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.78, 0.05, rearWindshieldLen), glassMat);
    rearWindshield.position.set(0, bodyTopY + 0.22, rearWindshieldZ);
    rearWindshield.rotation.x = -0.58;
    group.add(rearWindshield);

    const trunkLen = chassisL * 0.16;
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.92, 0.07, trunkLen), bodyMat);
    trunk.position.set(0, bodyTopY + 0.05, rearWindshieldZ - rearWindshieldLen * 0.5 - trunkLen / 2 + 0.05);
    trunk.rotation.x = 0.12;
    trunk.castShadow = true;
    group.add(trunk);

    // Bumper strips — bottom-front/rear accents that break up the slab body
    // and read as a distinct plastic bumper rather than one flat painted box.
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.98, 0.18, 0.3), trimMat);
    frontBumper.position.set(0, 0.24, chassisL / 2 - 0.18);
    group.add(frontBumper);
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.98, 0.18, 0.3), trimMat);
    rearBumper.position.set(0, 0.24, -chassisL / 2 + 0.18);
    group.add(rearBumper);

    // Wing mirrors
    [-1, 1].forEach((side) => {
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.26), trimMat);
      mirror.position.set(side * (chassisW / 2 + 0.06), 0.72, chassisL * 0.12);
      mirror.castShadow = true;
      group.add(mirror);
    });

    // Rear spoiler on two struts — small, but exactly the kind of silhouette
    // detail that reads as "a real car" instead of a smooth toy block.
    const spoilerMat = bodyMat;
    [-0.55, 0.55].forEach((x) => {
      const strut = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.22, 0.08), trimMat);
      strut.position.set(x, 0.62, -chassisL / 2 + 0.35);
      group.add(strut);
    });
    const wing = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.78, 0.06, 0.34), spoilerMat);
    wing.position.set(0, 0.76, -chassisL / 2 + 0.32);
    wing.castShadow = true;
    group.add(wing);

    // Dual exhaust tips
    [-0.45, 0.45].forEach((x) => {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 0.22, 12), chromeMat);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(x, 0.16, -chassisL / 2 - 0.02);
      group.add(pipe);
    });

    // headlights (emissive + real lights for a bit of night-driving drama)
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 3 });
    [-0.6, 0.6].forEach((x) => {
      const hl = new THREE.Mesh(new THREE.SphereGeometry(0.09, 8, 8), lightMat);
      hl.position.set(x, 0.45, chassisL / 2 - 0.05);
      group.add(hl);
    });
    // Sits just past the front bumper (not at bumper height where the new
    // sloped hood now passes close underneath) and at a lower intensity —
    // with the old flat-box hood this was far enough from any other body
    // panel to not matter, but the raked hood introduced above put a large
    // surface ~20cm from this light, which at the old intensity of 12
    // blew the whole front of the car out to solid white under bloom.
    const headBeam = new THREE.SpotLight(0xfff2c0, 5, 40, Math.PI / 6, 0.4, 1.4);
    headBeam.position.set(0, 0.45, chassisL / 2 + 0.15);
    headBeam.target.position.set(0, 0, chassisL / 2 + 10);
    group.add(headBeam, headBeam.target);

    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.4 });
    [-0.6, 0.6].forEach((x) => {
      const tl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), tailMat);
      tl.position.set(x, 0.45, -chassisL / 2 + 0.05);
      group.add(tl);
    });

    // Two-tone wheel: dark rubber tire + a distinct metallic rim disc, rather
    // than one flat-colored cylinder — the single biggest cheap upgrade for
    // "does this look like a real car" on any procedural vehicle.
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.28, metalness: 0.9, envMapIntensity: 1.2 });
    this.wheelMeshes = [];
    for (let i = 0; i < 4; i++) {
      const wheelGroup = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS, WHEEL_RADIUS, 0.32, 20), tireMat);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wheelGroup.add(tire);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS * 0.56, WHEEL_RADIUS * 0.56, 0.34, 16), rimMat);
      rim.rotation.z = Math.PI / 2;
      wheelGroup.add(rim);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(WHEEL_RADIUS * 0.14, WHEEL_RADIUS * 0.14, 0.36, 10), rimMat);
      hub.rotation.z = Math.PI / 2;
      wheelGroup.add(hub);
      // IMPORTANT: added to the SCENE, not to `group`. cannon-es's
      // wheelInfo.worldTransform is already a WORLD-space transform; `group`
      // is itself moved/rotated to the chassis's world transform every
      // frame below, so parenting a wheel under it and then assigning that
      // same world transform to the child's LOCAL position/quaternion would
      // apply the chassis transform twice. That compounding is exactly what
      // was sending the wheels drifting away from the car (worse the
      // farther the car got from the world origin, and worse on turns).
      scene.add(wheelGroup);
      this.wheelMeshes.push(wheelGroup);
    }

    // control state
    this.input = { throttle: 0, steer: 0, brake: 0, handbrake: false };
    this.maxSteer = 0.32;
    this.maxForce = 1000;
    this.maxBrakeForce = 55;
  }

  setInput(input) {
    Object.assign(this.input, input);
  }

  update(dt) {
    const v = this.vehicle;
    const { throttle, steer, brake, handbrake } = this.input;

    const engineForce = -throttle * this.maxForce;
    v.applyEngineForce(engineForce, 2);
    v.applyEngineForce(engineForce, 3);

    const steerValue = steer * this.maxSteer;
    v.setSteeringValue(steerValue, 0);
    v.setSteeringValue(steerValue, 1);

    const brakeForce = handbrake ? this.maxBrakeForce * 4 : brake * this.maxBrakeForce;
    for (let i = 0; i < 4; i++) {
      // handbrake locks the rear wheels for drift; normal brake acts on all four
      v.setBrake(handbrake ? (i >= 2 ? brakeForce : 0) : brakeForce, i);
    }

    this._applyAntiRoll();

    // sync visuals
    const chassis = this.chassisBody;
    this.group.position.copy(chassis.position);
    this.group.quaternion.copy(chassis.quaternion);

    for (let i = 0; i < 4; i++) {
      v.updateWheelTransform(i);
      const t = v.wheelInfos[i].worldTransform;
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(t.position);
      mesh.quaternion.copy(t.quaternion);
      mesh.rotateZ(Math.PI / 2);
    }
  }

  /**
   * Anti-roll bar: standard raycast-vehicle technique — compare left/right
   * suspension compression on each axle and add a small opposing force pair
   * that resists further roll. Verified (headless test) to only be safe when
   * BOTH wheels of the axle are actually grounded: inventing a compression
   * value for an airborne wheel produced runaway forces that *caused* flips
   * instead of preventing them, so it deliberately no-ops otherwise.
   */
  _applyAntiRoll() {
    const v = this.vehicle;
    for (let axle = 0; axle < 2; axle++) {
      const iL = axle * 2, iR = axle * 2 + 1;
      const wL = v.wheelInfos[iL], wR = v.wheelInfos[iR];
      if (!wL.isInContact || !wR.isInContact) continue;
      const diff = wL.suspensionLength - wR.suspensionLength;
      const forceMag = diff * ANTI_ROLL_STIFFNESS;
      this.chassisBody.applyForce(new this.CANNON.Vec3(0, -forceMag, 0), wL.raycastResult.hitPointWorld);
      this.chassisBody.applyForce(new this.CANNON.Vec3(0, forceMag, 0), wR.raycastResult.hitPointWorld);
    }
  }

  /**
   * Per-wheel skid state for this frame, in world space — main.js uses this
   * to lay skid marks / kick up dust / drive the tire-screech sound without
   * duplicating cannon-es's own tire-slip math.
   */
  getWheelSkidStates() {
    const out = [];
    for (let i = 0; i < 4; i++) {
      const info = this.vehicle.wheelInfos[i];
      out.push({
        position: info.worldTransform.position,
        inContact: !!info.isInContact,
        // skidInfo is 1.0 at full grip, drops toward 0 as the tire slips
        skidding: !!info.isInContact && info.skidInfo < 0.85,
        skidAmount: 1 - Math.min(1, Math.max(0, info.skidInfo)),
        rear: i >= 2,
      });
    }
    return out;
  }

  getSpeedKmh() {
    return this.chassisBody.velocity.length() * 3.6;
  }

  getTransform() {
    const p = this.chassisBody.position;
    const q = this.chassisBody.quaternion;
    return { p: [p.x, p.y, p.z], q: [q.x, q.y, q.z, q.w], v: this.chassisBody.velocity.length() };
  }

  respawn(position, heading = 0) {
    const b = this.chassisBody;
    b.position.set(position.x, position.y, position.z);
    b.quaternion.setFromEuler(0, heading, 0);
    b.velocity.set(0, 0, 0);
    b.angularVelocity.set(0, 0, 0);
    this._resetDents();
  }

  // -------------------------------------------------------------------
  // Body damage: push mesh vertices near a hard collision point inward,
  // capped per-vertex so the mesh can't fold in on itself after many hits.
  // -------------------------------------------------------------------
  _onChassisCollide(e) {
    const other = e.body;
    if (!other.userData || !other.userData.isBuilding) return; // only solid structures dent the car
    const contact = e.contact;
    const impactSpeed = contact.getImpactVelocityAlongNormal ? Math.abs(contact.getImpactVelocityAlongNormal()) : 0;
    if (impactSpeed < DENT_SPEED_THRESHOLD) return;

    const isBi = contact.bi === this.chassisBody;
    const rWorld = isBi ? contact.ri : contact.rj;
    const worldPoint = new this.CANNON.Vec3();
    this.chassisBody.position.vadd(rWorld, worldPoint);

    this._applyDent(worldPoint, impactSpeed);
    this.onEffect('impact', { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }, Math.min(1, impactSpeed / 10));
  }

  _applyDent(worldPoint, speed) {
    const local = new this.CANNON.Vec3();
    this.chassisBody.pointToLocalFrame(worldPoint, local);
    // base mesh sits at a fixed offset from the chassis body origin; work in
    // its local space so we can compare directly against geometry vertices
    const off = this.baseMesh.position;
    const ix = local.x - off.x;
    const iy = local.y - off.y;
    const iz = local.z - off.z;

    const pos = this.baseGeo.attributes.position;
    const strength = Math.min(1, speed / 14) * DENT_MAX_PUSH;
    let touched = false;

    for (let i = 0; i < pos.count; i++) {
      const bx = this._dentBase[i * 3];
      const by = this._dentBase[i * 3 + 1];
      const bz = this._dentBase[i * 3 + 2];
      const dx = bx - ix, dy = by - iy, dz = bz - iz;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (dist > DENT_RADIUS) continue;
      const remaining = DENT_MAX_PUSH - this._dentAccum[i];
      if (remaining <= 0.001) continue;

      const falloff = 1 - dist / DENT_RADIUS;
      const push = Math.min(remaining, strength * falloff * falloff);
      if (push <= 0) continue;

      // move the current vertex toward the impact point (crater shape)
      const cx = pos.getX(i), cy = pos.getY(i), cz = pos.getZ(i);
      const tdx = ix - (bx), tdy = iy - (by), tdz = iz - (bz);
      const tlen = Math.sqrt(tdx * tdx + tdy * tdy + tdz * tdz) || 1;
      pos.setXYZ(i, cx + (tdx / tlen) * push, cy + (tdy / tlen) * push, cz + (tdz / tlen) * push);
      this._dentAccum[i] += push;
      touched = true;
    }

    if (touched) {
      pos.needsUpdate = true;
      this.baseGeo.computeVertexNormals();
    }
  }

  _resetDents() {
    const pos = this.baseGeo.attributes.position;
    pos.array.set(this._dentBase);
    pos.needsUpdate = true;
    this._dentAccum.fill(0);
    this.baseGeo.computeVertexNormals();
  }
}

// A remote player's car: no local physics simulation — its transform is
// driven entirely by network updates. Uses a small delayed interpolation
// buffer (the classic "entity interpolation" approach used in most online
// games) instead of a naive per-frame lerp, so playback stays smooth even
// when packets arrive at uneven intervals or one is lost.
const INTERP_DELAY_MS = 100;
const BUFFER_MAX_AGE_MS = 1000;

export class RemoteCar {
  constructor(THREE, scene, color = 0x999999) {
    this.THREE = THREE;
    const group = new THREE.Group();
    const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.36, metalness: 0.65, clearcoat: 1, clearcoatRoughness: 0.32 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.36, 4.2), bodyMat);
    base.position.y = 0.4;
    base.castShadow = true;
    group.add(base);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.56, 0.5, 2.1),
      new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.06, metalness: 0.15, clearcoat: 0.6 })
    );
    cabin.position.set(0, 0.65, -0.15);
    group.add(cabin);
    // Static wheels (no per-wheel telemetry travels over the network for
    // remote players, so these don't spin/steer) — still much better than a
    // body floating with no wheels at all.
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 });
    [[-0.95, 0.35, 1.4], [0.95, 0.35, 1.4], [-0.95, 0.35, -1.4], [0.95, 0.35, -1.4]].forEach(([wx, wy, wz]) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, wy, wz);
      group.add(wheel);
    });
    scene.add(group);
    this.group = group;

    this.buffer = []; // { t: local receive time (ms), p:[x,y,z], q:[x,y,z,w] }
    this._initialized = false;
  }

  setTarget(state) {
    if (!state || !state.p || !state.q) return;
    const now = performance.now();
    this.buffer.push({ t: now, p: state.p, q: state.q });
    const cutoff = now - BUFFER_MAX_AGE_MS;
    while (this.buffer.length > 2 && this.buffer[0].t < cutoff) this.buffer.shift();
    if (this.buffer.length > 40) this.buffer.shift();
  }

  update(dt) {
    const buf = this.buffer;
    if (buf.length === 0) return;

    if (!this._initialized) {
      const last = buf[buf.length - 1];
      this.group.position.set(last.p[0], last.p[1], last.p[2]);
      this.group.quaternion.set(last.q[0], last.q[1], last.q[2], last.q[3]);
      this._initialized = true;
      return;
    }

    const renderTime = performance.now() - INTERP_DELAY_MS;

    if (buf.length === 1) {
      // only one sample ever received — just sit there, nothing to interpolate
      const s = buf[0];
      this.group.position.set(s.p[0], s.p[1], s.p[2]);
      this.group.quaternion.set(s.q[0], s.q[1], s.q[2], s.q[3]);
      return;
    }

    // find the pair of samples bracketing renderTime
    let a = null, b = null;
    for (let i = 0; i < buf.length - 1; i++) {
      if (buf[i].t <= renderTime && buf[i + 1].t >= renderTime) {
        a = buf[i];
        b = buf[i + 1];
        break;
      }
    }

    if (!a || !b) {
      if (renderTime < buf[0].t) {
        // brand new remote player, not enough history yet — snap to oldest known
        a = b = buf[0];
      } else {
        // network lagging behind our render delay — extrapolate from the two newest samples
        a = buf[buf.length - 2];
        b = buf[buf.length - 1];
        const span = Math.max(1, b.t - a.t);
        const frac = Math.min(2, (renderTime - a.t) / span); // cap extrapolation to 2x the last interval
        this._setLerped(a, b, frac);
        return;
      }
    }

    const span = Math.max(1, b.t - a.t);
    const frac = Math.min(1, Math.max(0, (renderTime - a.t) / span));
    this._setLerped(a, b, frac);
  }

  _setLerped(a, b, frac) {
    const g = this.group;
    g.position.set(
      a.p[0] + (b.p[0] - a.p[0]) * frac,
      a.p[1] + (b.p[1] - a.p[1]) * frac,
      a.p[2] + (b.p[2] - a.p[2]) * frac
    );
    const qa = new this.THREE.Quaternion(a.q[0], a.q[1], a.q[2], a.q[3]);
    const qb = new this.THREE.Quaternion(b.q[0], b.q[1], b.q[2], b.q[3]);
    qa.slerp(qb, frac);
    g.quaternion.copy(qa);
  }

  dispose(scene) {
    scene.remove(this.group);
  }
}
