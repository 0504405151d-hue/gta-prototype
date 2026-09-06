// A drivable car: cannon-es RaycastVehicle (chassis + 4 raycast wheels with
// suspension) driving a Three.js mesh. Tuned for a "GTA San Andreas-ish"
// arcade-but-weighty feel: body roll, suspension travel, drift on handbrake.
//
// Also owns two bits of "juice" that read straight off the physics rather
// than being faked: a per-vertex body dent that grows out of real collision
// points/speeds against buildings, and per-wheel skid state (from cannon-es's
// own tire slip model) that main.js uses to trigger skid marks/dust/sound.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const WHEEL_RADIUS = 0.36;

const DENT_RADIUS = 0.85;
const DENT_MAX_PUSH = 0.22;
const DENT_SPEED_THRESHOLD = 3.2;
const CHASSIS_Y_OFFSET = 0.4; // how far the collision box sits above the body origin (wheel-mount height)
const ANTI_ROLL_STIFFNESS = 9000; // empirically tuned in a headless test — see fix notes below
// Anti-wheelie safety net (see _applyPitchSafety below). Threshold is ~7°:
// a headless full-vehicle simulation showed normal driving at this project's
// real maxForce values (1000-1320, no turbo) only ever pitches ~0.03-0.04
// rad under hard acceleration, so this never touches ordinary gameplay. It
// only engages once the nose is visibly lifting.
const PITCH_SAFETY_THRESHOLD = 0.12;
// Damping-only, not a spring: a headless test of a proportional (-pitch)
// restoring torque looked correct in isolation (a bare-body torque test)
// but caused a *worse* outcome once combined with the real RaycastVehicle's
// suspension — the correction pushed the lifted end back down hard enough
// for the suspension to kick the whole chassis into the air, turning a
// 0.63 rad wheelie into an uncontrolled tumble up past 5 units off the
// ground. Pure damping (opposing only the current pitch *rotation speed*,
// never adding a restoring force of its own) can only ever remove
// rotational energy, so the same test harness confirmed it stays bounded
// (~0.7-0.76 rad max, car settles back near normal ride height) across
// every force level tried, including well past this project's real
// turbo-mode ceiling.
const PITCH_SAFETY_DAMPING = 1500;
// Hard velocity cap (~230 km/h) — mainly there for the admin panel's turbo
// mode (2.2x engine force with no matching cap before this): ramming a wall
// at an unbounded turbo speed could keep re-triggering hard collisions every
// single physics step (the chassis re-entering the wall each frame faster
// than friction/contact response could fully arrest it), which is exactly
// the kind of runaway collision spam that overwhelmed this project's own
// smoke test (see IMPACT_EFFECT_COOLDOWN below for the other half of that
// fix). Bounding top speed keeps any single collision's energy sane
// regardless of what multiplies engineForce.
const MAX_SPEED_MS = 65;
// A car stuck jittering against a wall (turbo ramming it, or any other
// stuck state) can generate a hard 'collide' event on every physics
// sub-step. Denting/crumpling every one of those is cheap and fine — it's
// onEffect() that isn't: it drives audio.playImpact(), which allocates a
// fresh set of Web Audio nodes per call with zero throttling. Uncapped,
// dozens of impacts per second flooded the audio graph and stalled the
// (already CPU-constrained, software-rendered) test browser hard enough
// that Chromium's own hang watchdog killed the tab outright — caught by
// this project's own smoke test, not guessed at. This cooldown doesn't
// touch the dent/crumple visuals at all, only how often the sound+particle
// side of a hit is allowed to re-fire.
const IMPACT_EFFECT_COOLDOWN = 0.09;

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
  constructor(THREE, CANNON, world, scene, {
    color = 0xff3b30, position = { x: 0, y: 1.2, z: 0 }, heading = 0, onEffect,
    // Per-model overrides (see carPresets.js) — defaults below match the
    // original single "sedan" body this project shipped with, so passing
    // nothing keeps the exact same car as before presets existed.
    dims = { chassisW: 1.9, chassisH: 0.65, chassisL: 4.2 },
    mass = 165, maxForce = 1000, maxSteer = 0.32, maxBrakeForce = 55,
    // Round-5 ("add real vehicle types, not just recolored sedans"):
    // 'sedan' keeps the exact car-shaped body below (also used, just resized,
    // for the sport/suv presets); 'truck' and 'bus' branch to genuinely
    // different silhouettes built further down (_buildTruckBody/_buildBusBody).
    bodyStyle = 'sedan',
  } = {}) {
    this.THREE = THREE;
    this.CANNON = CANNON;
    this.world = world;
    this.onEffect = onEffect || (() => {});
    this.bodyStyle = bodyStyle;

    // ---------- Chassis ----------
    const { chassisW, chassisH, chassisL } = dims;
    this.dims = { chassisW, chassisH, chassisL };
    const chassisShape = new CANNON.Box(new CANNON.Vec3(chassisW / 2, chassisH / 2, chassisL / 2));
    const chassisBody = new CANNON.Body({ mass, material: new CANNON.Material('chassis') });
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
    // Round-3 follow-up ("уменьши блики" — still too much glare): pushed
    // clearcoat/clearcoatRoughness/envMapIntensity down another notch across
    // every car material in the project (player, remote players, traffic,
    // parked cars) — the previous pass tamed the single worst hotspot but
    // the paint was still noticeably mirror-like in direct sun.
    const bodyMat = new THREE.MeshPhysicalMaterial({
      color, roughness: 0.42, metalness: 0.6, clearcoat: 0.7, clearcoatRoughness: 0.5, envMapIntensity: 0.55,
    });
    this.bodyMat = bodyMat;
    const glassMat = new THREE.MeshPhysicalMaterial({
      color: 0x0a1018, roughness: 0.18, metalness: 0.15, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.6,
    });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.5, metalness: 0.75 }); // matte black plastic trim/bumpers
    const chromeMat = new THREE.MeshStandardMaterial({ color: 0xd8dce2, roughness: 0.3, metalness: 0.9 }); // mirrors/exhaust/rim accents (roughened — was near-mirror chrome)

    if (bodyStyle === 'sedan') {
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
    // Kept as instance fields (with their untouched base pose) so damage
    // crumple (see _applyCrumple() below) can nudge them per-frame without
    // fighting a running total — every crumple write is relative to this
    // original pose, not to whatever the last frame left it at.
    this.hoodMesh = hood;
    this._hoodBase = { y: hood.position.y, rotX: hood.rotation.x };

    const windshieldLen = chassisL * 0.17;
    const windshieldZ = chassisL / 2 - hoodLen - 0.2 - windshieldLen * 0.32;
    // Front/rear glass used to share one glassMat instance, which meant
    // there was no way to visibly crack just the windshield on front-impact
    // damage without also cracking the rear glass on a rear hit — cloned so
    // _applyCrumple() below can darken/frost each pane independently based
    // on the damage that end of the car actually took.
    const windshieldMat = glassMat.clone();
    this.windshieldMat = windshieldMat;
    const rearGlassMat = glassMat.clone();
    this.rearGlassMat = rearGlassMat;
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.78, 0.05, windshieldLen), windshieldMat);
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
    const rearWindshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.78, 0.05, rearWindshieldLen), rearGlassMat);
    rearWindshield.position.set(0, bodyTopY + 0.22, rearWindshieldZ);
    rearWindshield.rotation.x = -0.58;
    group.add(rearWindshield);

    const trunkLen = chassisL * 0.16;
    const trunk = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.92, 0.07, trunkLen), bodyMat);
    trunk.position.set(0, bodyTopY + 0.05, rearWindshieldZ - rearWindshieldLen * 0.5 - trunkLen / 2 + 0.05);
    trunk.rotation.x = 0.12;
    trunk.castShadow = true;
    group.add(trunk);
    this.trunkMesh = trunk;
    this._trunkBase = { y: trunk.position.y, rotX: trunk.rotation.x };

    // Bumper strips — bottom-front/rear accents that break up the slab body
    // and read as a distinct plastic bumper rather than one flat painted box.
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.98, 0.18, 0.3), trimMat);
    frontBumper.position.set(0, 0.24, chassisL / 2 - 0.18);
    group.add(frontBumper);
    this.frontBumperMesh = frontBumper;
    this._frontBumperBase = { z: frontBumper.position.z, rotX: frontBumper.rotation.x };
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.98, 0.18, 0.3), trimMat);
    rearBumper.position.set(0, 0.24, -chassisL / 2 + 0.18);
    group.add(rearBumper);
    this.rearBumperMesh = rearBumper;
    this._rearBumperBase = { z: rearBumper.position.z, rotX: rearBumper.rotation.x };

    // Front grille — a small dark slat between the headlights so the nose
    // isn't just one blank painted panel.
    const grille = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.42, 0.14, 0.06), trimMat);
    grille.position.set(0, 0.42, chassisL / 2 - 0.02);
    group.add(grille);

    // Door seam lines — thin dark strips sitting almost flush on each side,
    // roughly where a real door split would be. Cheap (4 thin boxes) but
    // it's the difference between "one smooth slab" and "a paneled car"
    // when viewed from the side.
    const seamMat = new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.7, metalness: 0.1 });
    [-1, 1].forEach((side) => {
      [-0.65, 0.55].forEach((z) => {
        const seam = new THREE.Mesh(new THREE.BoxGeometry(0.02, chassisH * 0.48, 0.03), seamMat);
        seam.position.set(side * (chassisW / 2 + 0.001), 0.4, z);
        group.add(seam);
      });
    });

    // Wing mirrors
    [-1, 1].forEach((side) => {
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.26), trimMat);
      mirror.position.set(side * (chassisW / 2 + 0.06), 0.72, chassisL * 0.12);
      mirror.castShadow = true;
      group.add(mirror);
    });

    // Round-4 polish pass ("make the cars as good-looking as the UFO easter
    // egg"): the UFO's appeal isn't a wilder material — it's clean chrome
    // trim reading crisply against the paint, plus small glowing accents.
    // Cranking the body's own reflectivity back up would just re-introduce
    // the exact glare that round 2/3 already had to tone down, so the win
    // here is added, cheap-but-legible detail instead: a chrome cowl strip
    // and roof drip rails (real cars have a visible seam/trim right where
    // glass meets metal — this procedural body just had glass floating
    // directly against paint with nothing framing it), chrome door handles,
    // and slim white LED-style daytime-running-light strips under the
    // headlights, which is exactly what makes a modern real car's front end
    // read as "premium" at a glance.
    const cowlTrim = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.8, 0.03, 0.05), chromeMat);
    cowlTrim.position.set(0, bodyTopY + 0.135, windshieldZ + windshieldLen / 2);
    group.add(cowlTrim);

    [-1, 1].forEach((side) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.03, roofLen + 0.1), chromeMat);
      rail.position.set(side * (chassisW * 0.76 / 2), bodyTopY + 0.62, roofZ);
      group.add(rail);
    });

    [-1, 1].forEach((side) => {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.045, 0.22), chromeMat);
      handle.position.set(side * (chassisW / 2 + 0.015), 0.58, 0.1);
      group.add(handle);
    });

    const drlMat = new THREE.MeshStandardMaterial({ color: 0xeaf6ff, emissive: 0xcfeeff, emissiveIntensity: 1.8 });
    [-0.6, 0.6].forEach((x) => {
      const drl = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.025, 0.04), drlMat);
      drl.position.set(x, 0.335, chassisL / 2 - 0.05);
      group.add(drl);
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

    // headlights (emissive + real lights for a bit of night-driving drama).
    // Used to be permanently on; the player now toggles them with H (see
    // setHeadlightsOn() below and main.js), so both the lamp material and
    // the actual light are kept on the instance instead of staying local
    // consts here.
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 3 });
    this.lightMat = lightMat;
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
    this.headBeam = headBeam;
    this._headlightsOn = true;

    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.4 });
    this.tailMat = tailMat;
    [-0.6, 0.6].forEach((x) => {
      const tl = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 8), tailMat);
      tl.position.set(x, 0.45, -chassisL / 2 + 0.05);
      group.add(tl);
    });
    } else if (bodyStyle === 'truck') {
      this._buildTruckBody(group, chassisW, chassisH, chassisL, bodyMat, glassMat, trimMat, chromeMat);
    } else {
      this._buildBusBody(group, chassisW, chassisH, chassisL, bodyMat, glassMat, trimMat, chromeMat);
    }

    // Two-tone wheel: dark rubber tire + a distinct metallic rim disc, rather
    // than one flat-colored cylinder — the single biggest cheap upgrade for
    // "does this look like a real car" on any procedural vehicle.
    const tireMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92, metalness: 0.05 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.6 });
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
      // A perfectly round rim is rotationally symmetric, so even with
      // correct spin math the wheel would look completely static — nothing
      // on it moves as it "rotates". Five spokes radiating from the hub
      // give the eye something asymmetric to actually see turning.
      const spokeLen = WHEEL_RADIUS * 0.5;
      const radialDist = WHEEL_RADIUS * 0.14 + spokeLen / 2;
      const spokeGeo = new THREE.BoxGeometry(0.05, spokeLen, 0.05); // long axis along Y before rotation
      for (let s = 0; s < 5; s++) {
        const angle = (s / 5) * Math.PI * 2;
        const spoke = new THREE.Mesh(spokeGeo, rimMat);
        // rotation.x spins the box's long axis into the Y-Z plane (the
        // wheel's face, perpendicular to the X axle) at this angle; the
        // position must follow that SAME rotated direction, not the
        // parent's plain Y axis, or all five would overlap in one spot.
        spoke.rotation.x = angle;
        spoke.position.set(0, Math.cos(angle) * radialDist, Math.sin(angle) * radialDist);
        wheelGroup.add(spoke);
      }
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
    this.maxSteer = maxSteer;
    this.maxForce = maxForce;
    this.maxBrakeForce = maxBrakeForce;
    // Admin-panel "god mode" (main.js) — collision physics still happens
    // (the car still bounces off things), this only skips the cosmetic
    // dent/damage reaction in _onChassisCollide below.
    this.godMode = false;

    // ---------- Damage state (round-3: "improve car destruction") ----------
    // The per-vertex dent in _applyDent() below only ever sculpted the flat
    // base slab. That alone stopped reading as "damage" once a car had taken
    // a lot of hits — real wrecks visibly sag: the hood/trunk cave in and
    // droop, the bumpers get shoved in and tilt. frontDamage/rearDamage are
    // tracked separately (0..1 each) so a car hit only from the front doesn't
    // show a crumpled trunk too, and _applyCrumple() below reads them to pose
    // the hood/bumper/trunk meshes directly off their ORIGINAL base pose
    // (stored above) every time, rather than nudging them repeatedly.
    this.frontDamage = 0;
    this.rearDamage = 0;
    this._smokeTimer = 0;
    this._lastImpactEffectAt = -Infinity; // see IMPACT_EFFECT_COOLDOWN above
  }

  /**
   * Round-5 ("add real vehicle types, not just recolored sedans"): a boxy
   * cab-over-flatbed truck body — flat vertical front (no raked hood/glass),
   * a small cab greenhouse, then a tall open cargo bed with side rails
   * running the rest of the chassis length. Deliberately simpler than the
   * sedan body (no spoiler/exhaust/seam-line flourishes — those read as
   * "sports car", not "work truck"), but still wires up every field the
   * shared damage/crumple/headlight code below expects, so a truck dents,
   * crumples and lights up exactly like every other body style.
   */
  _buildTruckBody(group, chassisW, chassisH, chassisL, bodyMat, glassMat, trimMat, chromeMat) {
    const THREE = this.THREE;
    const cabLen = chassisL * 0.28;
    const cabZ = chassisL / 2 - cabLen / 2 - 0.1;
    const bedLen = chassisL - cabLen - 0.25;
    const bedZ = cabZ - cabLen / 2 - 0.05 - bedLen / 2;

    // Dentable "base" — the cab front + chassis rail slab combined into one
    // subdivided box so _applyDent()'s per-vertex push has enough geometry
    // to work with regardless of where on the truck an impact lands.
    const baseGeo = new THREE.BoxGeometry(chassisW, chassisH * 0.55, chassisL, 3, 2, 8);
    const base = new THREE.Mesh(baseGeo, bodyMat);
    base.position.set(0, 0.4, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);
    this.baseMesh = base;
    this.baseGeo = baseGeo;
    this._dentBase = Float32Array.from(baseGeo.attributes.position.array);
    this._dentAccum = new Float32Array(baseGeo.attributes.position.count);

    const bodyTopY = 0.4 + (chassisH * 0.55) / 2;

    // Flat vertical cab front instead of a raked hood — stands in for
    // "hood" in the crumple system (it's the front-most panel, exactly what
    // takes a front-end hit).
    const hood = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.94, chassisH * 0.5, 0.1), bodyMat);
    hood.position.set(0, bodyTopY + chassisH * 0.25, chassisL / 2 - 0.05);
    hood.castShadow = true;
    group.add(hood);
    this.hoodMesh = hood;
    this._hoodBase = { y: hood.position.y, rotX: hood.rotation.x };

    const windshieldMat = glassMat.clone();
    this.windshieldMat = windshieldMat;
    const rearGlassMat = glassMat.clone();
    this.rearGlassMat = rearGlassMat;
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, chassisH * 0.42, 0.05), windshieldMat);
    windshield.position.set(0, bodyTopY + chassisH * 0.72, cabZ + cabLen / 2 - 0.03);
    windshield.rotation.x = 0.2; // cab-over trucks sit nearly upright, just a slight rake
    group.add(windshield);

    const cabRoof = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.9, 0.35, cabLen * 0.85), bodyMat);
    cabRoof.position.set(0, bodyTopY + chassisH * 0.95, cabZ);
    cabRoof.castShadow = true;
    group.add(cabRoof);

    // Rear cab glass (small, cab-overs barely have one)
    const rearWindshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.8, chassisH * 0.3, 0.05), rearGlassMat);
    rearWindshield.position.set(0, bodyTopY + chassisH * 0.62, cabZ - cabLen / 2 + 0.05);
    rearWindshield.rotation.x = -0.15;
    group.add(rearWindshield);

    // Open cargo bed: floor + side rails + a rear tailgate (stands in for
    // "trunk" in the crumple system — it's the rear-most panel).
    const bedFloor = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.96, 0.08, bedLen), trimMat);
    bedFloor.position.set(0, bodyTopY + 0.04, bedZ);
    bedFloor.castShadow = true;
    group.add(bedFloor);
    const railH = chassisH * 0.55;
    [-1, 1].forEach((side) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, railH, bedLen), bodyMat);
      rail.position.set(side * (chassisW / 2 - 0.04), bodyTopY + railH / 2, bedZ);
      rail.castShadow = true;
      group.add(rail);
    });
    const tailgate = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.96, railH, 0.08), bodyMat);
    tailgate.position.set(0, bodyTopY + railH / 2, bedZ - bedLen / 2);
    tailgate.castShadow = true;
    group.add(tailgate);
    this.trunkMesh = tailgate;
    this._trunkBase = { y: tailgate.position.y, rotX: tailgate.rotation.x };

    // Bumpers
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW, 0.22, 0.3), trimMat);
    frontBumper.position.set(0, 0.26, chassisL / 2 - 0.15);
    group.add(frontBumper);
    this.frontBumperMesh = frontBumper;
    this._frontBumperBase = { z: frontBumper.position.z, rotX: frontBumper.rotation.x };
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW, 0.22, 0.3), trimMat);
    rearBumper.position.set(0, 0.26, -chassisL / 2 + 0.15);
    group.add(rearBumper);
    this.rearBumperMesh = rearBumper;
    this._rearBumperBase = { z: rearBumper.position.z, rotX: rearBumper.rotation.x };

    // Grille + mirrors
    const grille = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.7, 0.3, 0.05), trimMat);
    grille.position.set(0, 0.5, chassisL / 2 - 0.02);
    group.add(grille);
    [-1, 1].forEach((side) => {
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.28, 0.16), trimMat);
      mirror.position.set(side * (chassisW / 2 + 0.1), bodyTopY + 0.55, cabZ + cabLen / 2 - 0.1);
      mirror.castShadow = true;
      group.add(mirror);
    });

    this._buildLights(group, chassisW, chassisL, chromeMat);
  }

  /**
   * Round-5 bus body: one long, tall, flat-sided box (no separate hood/cab
   * step at all — a real transit bus's greenhouse runs almost the full
   * length) with a row of side windows punched down each flank and a flat
   * destination-sign panel up front. Longest, tallest, heaviest silhouette
   * of the three styles, which is also what its carPresets.js tuning (slow
   * accel, wide turning circle) is meant to visually match.
   */
  _buildBusBody(group, chassisW, chassisH, chassisL, bodyMat, glassMat, trimMat, chromeMat) {
    const THREE = this.THREE;
    const baseGeo = new THREE.BoxGeometry(chassisW, chassisH * 0.5, chassisL, 3, 2, 10);
    const base = new THREE.Mesh(baseGeo, bodyMat);
    base.position.set(0, 0.35, 0);
    base.castShadow = true;
    base.receiveShadow = true;
    group.add(base);
    this.baseMesh = base;
    this.baseGeo = baseGeo;
    this._dentBase = Float32Array.from(baseGeo.attributes.position.array);
    this._dentAccum = new Float32Array(baseGeo.attributes.position.count);

    const bodyTopY = 0.35 + (chassisH * 0.5) / 2;
    const cabinH = chassisH * 1.5;

    // Tall flat-sided greenhouse spanning almost the whole chassis length —
    // this, more than anything else, is what reads as "bus" instead of
    // "van": the roofline barely changes shape from nose to tail.
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.94, cabinH, chassisL * 0.92), bodyMat);
    cabin.position.set(0, bodyTopY + cabinH / 2, 0);
    cabin.castShadow = true;
    group.add(cabin);

    // Flat front windshield/destination-sign panel — stands in for "hood".
    const hood = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, cabinH * 0.5, 0.06), glassMat);
    hood.position.set(0, bodyTopY + cabinH * 0.6, chassisL / 2 - 0.05);
    group.add(hood);
    this.hoodMesh = hood;
    this._hoodBase = { y: hood.position.y, rotX: hood.rotation.x };
    const windshieldMat = glassMat.clone();
    this.windshieldMat = windshieldMat;
    hood.material = windshieldMat;

    const rearGlassMat = glassMat.clone();
    this.rearGlassMat = rearGlassMat;
    const rearPanel = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, cabinH * 0.45, 0.06), rearGlassMat);
    rearPanel.position.set(0, bodyTopY + cabinH * 0.55, -chassisL / 2 + 0.05);
    group.add(rearPanel);
    this.trunkMesh = rearPanel;
    this._trunkBase = { y: rearPanel.position.y, rotX: rearPanel.rotation.x };

    // Row of side windows down each flank, merged into one mesh per side
    // pair (one draw call for the whole strip instead of one per pane).
    const windowMat = glassMat.clone();
    const winCount = Math.max(3, Math.round(chassisL / 1.1));
    const winLen = (chassisL * 0.8) / winCount * 0.7;
    const winGeos = [];
    for (let i = 0; i < winCount; i++) {
      const z = -chassisL * 0.4 + (i + 0.5) * ((chassisL * 0.8) / winCount);
      [-1, 1].forEach((side) => {
        const wGeo = new THREE.BoxGeometry(0.04, cabinH * 0.4, winLen);
        wGeo.translate(side * (chassisW * 0.94 / 2 + 0.01), bodyTopY + cabinH * 0.58, z);
        winGeos.push(wGeo);
      });
    }
    group.add(new THREE.Mesh(mergeGeometries(winGeos), windowMat));
    winGeos.forEach((g) => g.dispose());

    // A dark strip along the base of the windows breaks up the tall flat
    // flank a little instead of it reading as one giant slab of paint.
    [-1, 1].forEach((side) => {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, chassisL * 0.9), trimMat);
      stripe.position.set(side * (chassisW * 0.94 / 2 + 0.005), bodyTopY + cabinH * 0.3, 0);
      group.add(stripe);
    });

    // Bumpers
    const frontBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW, 0.24, 0.3), trimMat);
    frontBumper.position.set(0, 0.26, chassisL / 2 - 0.15);
    group.add(frontBumper);
    this.frontBumperMesh = frontBumper;
    this._frontBumperBase = { z: frontBumper.position.z, rotX: frontBumper.rotation.x };
    const rearBumper = new THREE.Mesh(new THREE.BoxGeometry(chassisW, 0.24, 0.3), trimMat);
    rearBumper.position.set(0, 0.26, -chassisL / 2 + 0.15);
    group.add(rearBumper);
    this.rearBumperMesh = rearBumper;
    this._rearBumperBase = { z: rearBumper.position.z, rotX: rearBumper.rotation.x };

    // Flat destination-sign trim above the windshield + door-line mirrors
    const signTrim = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.7, 0.14, 0.04), chromeMat);
    signTrim.position.set(0, bodyTopY + cabinH * 0.88, chassisL / 2 - 0.03);
    group.add(signTrim);
    [-1, 1].forEach((side) => {
      const mirror = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.26, 0.16), trimMat);
      mirror.position.set(side * (chassisW / 2 + 0.1), bodyTopY + cabinH * 0.7, chassisL / 2 - 0.3);
      mirror.castShadow = true;
      group.add(mirror);
    });

    this._buildLights(group, chassisW, chassisL, chromeMat);
  }

  /**
   * Head/tail lights + the front spotlight beam, shared by the truck and bus
   * bodies above (the sedan body builds its own inline, since it also adds
   * DRL strips and other flourishes those two styles skip). Wires up every
   * field _refreshHeadlightGlow()/_applyCrumple()/setHeadlightsOn() expect,
   * so lighting behaves identically across all three body styles.
   */
  _buildLights(group, chassisW, chassisL, chromeMat) {
    const THREE = this.THREE;
    const lightMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 3 });
    this.lightMat = lightMat;
    [-chassisW * 0.32, chassisW * 0.32].forEach((x) => {
      const hl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.04), lightMat);
      hl.position.set(x, 0.45, chassisL / 2 - 0.03);
      group.add(hl);
    });
    const headBeam = new THREE.SpotLight(0xfff2c0, 5, 40, Math.PI / 6, 0.4, 1.4);
    headBeam.position.set(0, 0.45, chassisL / 2 + 0.15);
    headBeam.target.position.set(0, 0, chassisL / 2 + 10);
    group.add(headBeam, headBeam.target);
    this.headBeam = headBeam;
    this._headlightsOn = true;

    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.4 });
    this.tailMat = tailMat;
    [-chassisW * 0.32, chassisW * 0.32].forEach((x) => {
      const tl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.12, 0.04), tailMat);
      tl.position.set(x, 0.45, -chassisL / 2 + 0.03);
      group.add(tl);
    });

    [-1, 1].forEach((side) => {
      const handle = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.18, 0.04), chromeMat);
      handle.position.set(side * (chassisW / 2 + 0.01), 0.6, chassisL * 0.15);
      group.add(handle);
    });
  }

  setInput(input) {
    Object.assign(this.input, input);
  }

  update(dt) {
    const v = this.vehicle;
    const { throttle, steer, brake, handbrake } = this.input;

    // Sign verified by directly simulating cannon-es's RaycastVehicle rather
    // than guessing: with indexForwardAxis=2/indexUpAxis=1/indexRightAxis=0
    // and this project's directionLocal=(0,-1,0)/axleLocal=(1,0,0), the
    // friction code builds forwardWS = up × axle, which comes out to
    // world/local (0,0,-1) at identity orientation — i.e. a POSITIVE
    // engineForce pushes the chassis toward LOCAL −Z. The car's nose (head-
    // lights, hood) is built at local +Z, so a positive engineForce was
    // actually driving the car tail-first: pressing "forward" moved it
    // backward and "back" moved it forward — inverted controls, confirmed
    // with a standalone headless simulation (chassis ended up at z<0 after
    // a positive engineForce). Removing the negation makes forward input
    // (throttle<0, see readInput()) produce a negative engineForce, which
    // the same simulation confirms drives the chassis toward +Z (the nose).
    const engineForce = throttle * this.maxForce;
    v.applyEngineForce(engineForce, 2);
    v.applyEngineForce(engineForce, 3);

    // Same class of bug as the engineForce sign above, found the same way
    // (a standalone headless cannon-es simulation, not guessing): with this
    // project's axis config (indexForwardAxis=2, nose at local/world +Z),
    // "right" for a car facing +Z is world −X (right = forward × up =
    // Z × Y = −X in a right-handed system) — but a POSITIVE
    // setSteeringValue on the front wheels was verified to swing the nose
    // toward +X, i.e. the car's own LEFT. readInput() sends steer=+1 for
    // "turn right" (D/→), so that has to produce a NEGATIVE steering value
    // here, or right/left were swapped for every player the whole time.
    const steerValue = -steer * this.maxSteer;
    v.setSteeringValue(steerValue, 0);
    v.setSteeringValue(steerValue, 1);

    const brakeForce = handbrake ? this.maxBrakeForce * 4 : brake * this.maxBrakeForce;
    for (let i = 0; i < 4; i++) {
      // handbrake locks the rear wheels for drift; normal brake acts on all four
      v.setBrake(handbrake ? (i >= 2 ? brakeForce : 0) : brakeForce, i);
    }

    this._applyAntiRoll();
    this._applyPitchSafety();

    // Hard top-speed cap — see MAX_SPEED_MS above.
    const speed = this.chassisBody.velocity.length();
    if (speed > MAX_SPEED_MS) {
      this.chassisBody.velocity.scale(MAX_SPEED_MS / speed, this.chassisBody.velocity);
    }

    // Brake lights actually light up under braking instead of sitting at a
    // fixed glow all the time — a small thing, but it's the difference
    // between "a car with red spheres on the back" and a car that reads as
    // driven.
    // Scaled down by rear damage too — a smashed tail light shouldn't keep
    // glowing at full brightness (or full brake-light flare) just because
    // this line runs every frame regardless of damage state.
    this.tailMat.emissiveIntensity = (handbrake ? 3.4 : 1.4) * (1 - Math.min(1, this.rearDamage) * 0.85);

    // sync visuals
    const chassis = this.chassisBody;
    this.group.position.copy(chassis.position);
    this.group.quaternion.copy(chassis.quaternion);

    for (let i = 0; i < 4; i++) {
      v.updateWheelTransform(i);
      const t = v.wheelInfos[i].worldTransform;
      const mesh = this.wheelMeshes[i];
      mesh.position.copy(t.position);
      // t.quaternion already IS the correct wheel orientation — cannon-es
      // composes it as chassis * steering * rolling-spin-around-the-axle,
      // and the tire/rim/hub children below carry their own single
      // rotation.z=90° to align the cylinder's axis with that axle. An
      // extra rotateZ(90°) used to be applied here too; stacked with the
      // children's own 90°, that's a 180° twist that points the tire's
      // rolling axis off the true axle — instead of spinning cleanly, the
      // wheel tumbled end-over-end as it rolled (and looked like it was
      // being dragged rather than driven). Just copy the transform as-is.
      mesh.quaternion.copy(t.quaternion);
    }

    // Heavily damaged cars smoke from the engine bay (front damage) or the
    // trunk (rear damage) — a continuous, ongoing tell that this car is
    // wrecked, on top of the one-shot spark/dust puff each impact already
    // gets from _onChassisCollide.
    const damageLevel = Math.max(this.frontDamage, this.rearDamage);
    if (damageLevel > 0.55) {
      this._smokeTimer -= dt;
      if (this._smokeTimer <= 0) {
        this._smokeTimer = 0.4 - damageLevel * 0.15;
        const fromFront = this.frontDamage >= this.rearDamage;
        const localZ = (fromFront ? 1 : -1) * (this.dims.chassisL / 2 - 0.3);
        const world = this.group.localToWorld(new this.THREE.Vector3(0, 0.55, localZ));
        this.onEffect('smoke', { x: world.x, y: world.y, z: world.z }, damageLevel);
      }
    }
  }

  /**
   * Poses the hood/front-bumper (front damage) and trunk/rear-bumper (rear
   * damage) off their stored base transform — see the fields set where each
   * mesh is built above. Called every time frontDamage/rearDamage change so
   * the visible crumple always matches the current damage total exactly,
   * instead of drifting from repeated relative nudges.
   *
   * Round-4 addition ("improve destruction further"): the crumple used to
   * be the ONLY thing that changed with damage — a heavily wrecked car
   * still had a perfectly clear windshield and full-brightness lights,
   * which reads as "dented" rather than "wrecked". Past ~60% damage on
   * either end this now also frosts that end's glass (cracked-windshield
   * look: darker, much rougher, so it scatters light instead of showing a
   * clean reflection) and knocks out that end's lights, scaled smoothly by
   * damage rather than snapping instantly at the threshold.
   */
  _applyCrumple() {
    const f = this.frontDamage, r = this.rearDamage;
    this.hoodMesh.rotation.x = this._hoodBase.rotX - f * 0.4;
    this.hoodMesh.position.y = this._hoodBase.y - f * 0.14;
    this.frontBumperMesh.position.z = this._frontBumperBase.z - f * 0.2;
    this.frontBumperMesh.rotation.x = this._frontBumperBase.rotX + f * 0.3;
    this.trunkMesh.rotation.x = this._trunkBase.rotX + r * 0.35;
    this.trunkMesh.position.y = this._trunkBase.y - r * 0.12;
    this.rearBumperMesh.position.z = this._rearBumperBase.z + r * 0.2;
    this.rearBumperMesh.rotation.x = this._rearBumperBase.rotX - r * 0.3;

    const crackAmount = (dmg) => Math.max(0, (dmg - 0.6) / 0.4); // 0 below 60% damage, ramps to 1 by 100%
    const frontCrack = crackAmount(f);
    const rearCrack = crackAmount(r);
    this.windshieldMat.roughness = 0.18 + frontCrack * 0.7;
    this.windshieldMat.clearcoat = 0.35 * (1 - frontCrack);
    this.windshieldMat.color.setRGB(0.04 + frontCrack * 0.1, 0.06 + frontCrack * 0.1, 0.09 + frontCrack * 0.1);
    this.rearGlassMat.roughness = 0.18 + rearCrack * 0.7;
    this.rearGlassMat.clearcoat = 0.35 * (1 - rearCrack);
    this.rearGlassMat.color.setRGB(0.04 + rearCrack * 0.1, 0.06 + rearCrack * 0.1, 0.09 + rearCrack * 0.1);

    this._refreshHeadlightGlow();
  }

  /** Headlight brightness is a function of BOTH the driver's H-key toggle
   * (setHeadlightsOn) and front-end damage — a heavily wrecked nose reads as
   * "the headlight is smashed", not "still shining fine through a crumpled
   * bumper". Kept as its own method since both of those need to re-apply it
   * independently without knowing about each other's state. */
  _refreshHeadlightGlow() {
    const on = this._headlightsOn;
    const brokenMul = 1 - Math.min(1, this.frontDamage) * 0.85;
    this.lightMat.emissiveIntensity = (on ? 3 : 0.15) * brokenMul;
    this.lightMat.emissive.setHex(on ? 0xfff2c0 : 0x2a2418);
    if (this.headBeam) this.headBeam.intensity = on ? 5 * brokenMul : 0;
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
   * Anti-wheelie safety net for "hard acceleration rears the car up and it
   * flips" reports. Only engages while at least one axle is fully grounded
   * (same grounded-only caveat as _applyAntiRoll — see its comment; guessing
   * a correction while airborne is what causes flips, not what prevents
   * them) and only once pitch has actually crossed PITCH_SAFETY_THRESHOLD,
   * so normal driving (measured ~0.03-0.04 rad even at this project's real
   * max engine force) is never touched.
   *
   * Applies pure damping against the chassis's own current pitch rotation
   * speed — not a spring pulling it back to level. Verified by a standalone
   * headless simulation (full RaycastVehicle + suspension, not a bare body)
   * that a spring-style restoring torque actively made things worse: it
   * shoved the lifted end back down hard enough for the suspension to
   * relaunch the whole chassis into an uncontrolled tumble. Damping can only
   * remove rotational energy, never add it, so the same test harness showed
   * it keeps pitch bounded well short of a flip (roughly 0.7-0.76 rad peak)
   * across every engine-force level tried, well past this project's real
   * turbo-mode ceiling.
   */
  _applyPitchSafety() {
    const v = this.vehicle;
    const rearGrounded = v.wheelInfos[2].isInContact && v.wheelInfos[3].isInContact;
    const frontGrounded = v.wheelInfos[0].isInContact && v.wheelInfos[1].isInContact;
    if (!rearGrounded && !frontGrounded) return;

    const q = this.chassisBody.quaternion;
    // Same YXZ-order pitch extraction this project's building-overlap fix
    // uses (THREE.Euler(...,'YXZ').x), reproduced here without needing a
    // THREE.Quaternion so this stays a plain math check. Verified sign via
    // headless test: positive pitch = nose DOWN, negative = nose UP (a
    // wheelie), for this chassis's local +Z-is-the-nose convention.
    const pitch = Math.asin(Math.max(-1, Math.min(1, 2 * (q.x * q.w - q.y * q.z))));
    if (Math.abs(pitch) < PITCH_SAFETY_THRESHOLD) return;

    const rightLocal = new this.CANNON.Vec3(1, 0, 0);
    const rightWorld = new this.CANNON.Vec3();
    q.vmult(rightLocal, rightWorld);

    const av = this.chassisBody.angularVelocity;
    const pitchRate = av.x * rightWorld.x + av.y * rightWorld.y + av.z * rightWorld.z;
    const dampMag = -pitchRate * PITCH_SAFETY_DAMPING;
    this.chassisBody.applyTorque(new this.CANNON.Vec3(
      rightWorld.x * dampMag, rightWorld.y * dampMag, rightWorld.z * dampMag
    ));
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
    this.frontDamage = 0;
    this.rearDamage = 0;
    this._applyCrumple();
  }

  // -------------------------------------------------------------------
  // Body damage: push mesh vertices near a hard collision point inward,
  // capped per-vertex so the mesh can't fold in on itself after many hits.
  // -------------------------------------------------------------------
  _onChassisCollide(e) {
    const other = e.body;
    // Solid structures AND AI traffic dent the car — a moving car should
    // feel just as real a thing to hit as a wall does.
    if (!other.userData || !(other.userData.isBuilding || other.userData.isTraffic)) return;
    if (this.godMode) return; // admin "god mode" — physics collision still happens, just no cosmetic dent/damage
    const contact = e.contact;
    const impactSpeed = contact.getImpactVelocityAlongNormal ? Math.abs(contact.getImpactVelocityAlongNormal()) : 0;
    if (impactSpeed < DENT_SPEED_THRESHOLD) return;

    const isBi = contact.bi === this.chassisBody;
    const rWorld = isBi ? contact.ri : contact.rj;
    const worldPoint = new this.CANNON.Vec3();
    this.chassisBody.position.vadd(rWorld, worldPoint);

    this._applyDent(worldPoint, impactSpeed);

    // Directional crumple damage: which end got hit decides whether the
    // hood/front bumper or the trunk/rear bumper visibly cave in — see
    // _applyCrumple() and the frontDamage/rearDamage fields above.
    const localPoint = new this.CANNON.Vec3();
    this.chassisBody.pointToLocalFrame(worldPoint, localPoint);
    const dmgInc = Math.min(0.4, impactSpeed / 35);
    if (localPoint.z >= 0) this.frontDamage = Math.min(1, this.frontDamage + dmgInc);
    else this.rearDamage = Math.min(1, this.rearDamage + dmgInc);
    this._applyCrumple();

    // Give the traffic car itself a visible/behavioral reaction (damage
    // flash + a brief stun) instead of the player's own car being the only
    // thing that ever shows a hit was taken — see registerHit() in traffic.js.
    // Not cooldown-gated: it just flips some numbers on a plain object, no
    // audio/particle allocation, so it's cheap even if it fires every step.
    if (other.userData.isTraffic && other.userData.trafficRef) {
      other.userData.trafficRef.registerHit(impactSpeed);
    }

    // Sound + sparks/dust are cooldown-gated (see IMPACT_EFFECT_COOLDOWN) —
    // the dent/crumple/traffic-reaction above still applies on every single
    // qualifying hit, only the audio+particle side is rate-limited.
    const now = performance.now() / 1000;
    if (now - this._lastImpactEffectAt >= IMPACT_EFFECT_COOLDOWN) {
      this._lastImpactEffectAt = now;
      this.onEffect('impact', { x: worldPoint.x, y: worldPoint.y, z: worldPoint.z }, Math.min(1, impactSpeed / 10));
    }
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

  /** Tears this car back down — used when switching car models mid-session
   * (the RaycastVehicle's wheels are pure raycasts against the chassis body,
   * not separate bodies, so only the chassis itself needs removing). */
  dispose(scene) {
    this.vehicle.removeFromWorld(this.world); // this also removes chassisBody itself, per cannon-es's own addToWorld/removeFromWorld pairing
    scene.remove(this.group);
    for (const w of this.wheelMeshes) scene.remove(w);
  }

  /**
   * Toggle the headlights (H key in main.js). Turns off both the actual
   * SpotLight (so it stops lighting the road/other cars) and dims the lamp
   * mesh's own emissive glow — leaving it fully bright while "off" would
   * look like the lamp housing itself is lit from within, backwards.
   */
  setHeadlightsOn(on) {
    this._headlightsOn = on;
    this.headBeam.visible = on;
    this._refreshHeadlightGlow();
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
  constructor(THREE, scene, color = 0x999999, bodyStyle = 'sedan') {
    this.THREE = THREE;
    const group = new THREE.Group();
    if (bodyStyle === 'truck') {
      this._buildRemoteTruck(group, color);
    } else if (bodyStyle === 'bus') {
      this._buildRemoteBus(group, color);
    } else {
    const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.6, clearcoat: 0.7, clearcoatRoughness: 0.5, envMapIntensity: 0.55 });
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.36, 4.2), bodyMat);
    base.position.y = 0.4;
    base.castShadow = true;
    group.add(base);
    const cabin = new THREE.Mesh(
      new THREE.BoxGeometry(1.56, 0.5, 2.1),
      new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.18, metalness: 0.15, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.6 })
    );
    cabin.position.set(0, 0.65, -0.15);
    group.add(cabin);

    // Round-4 polish pass: other connected players' cars used to be just
    // this bare box + cabin + wheels — no lights, no trim at all, noticeably
    // cruder than even the AI traffic cars. Brought up to the same level of
    // detail (bumpers/mirrors/handles/drip-rails merged into one trim mesh,
    // chrome cowl+rails in another, head/tail lights in a third pair) using
    // the exact same merged-geometry approach traffic.js uses, since a
    // multiplayer game can have several of these on screen at once and each
    // one is a full draw-call multiplier.
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x121317, roughness: 0.55, metalness: 0.7 });
    const trimGeos = [];
    const fbGeo = new THREE.BoxGeometry(1.86, 0.26, 0.22);
    fbGeo.translate(0, 0.29, 1.97);
    trimGeos.push(fbGeo);
    const rbGeo = new THREE.BoxGeometry(1.86, 0.26, 0.22);
    rbGeo.translate(0, 0.29, -1.97);
    trimGeos.push(rbGeo);
    [-1, 1].forEach((side) => {
      const mGeo = new THREE.BoxGeometry(0.16, 0.12, 0.26);
      mGeo.translate(side * 1.01, 0.9, 0.5);
      trimGeos.push(mGeo);
      const hGeo = new THREE.BoxGeometry(0.05, 0.045, 0.22);
      hGeo.translate(side * 0.965, 0.6, 0.08);
      trimGeos.push(hGeo);
    });
    group.add(new THREE.Mesh(mergeGeometries(trimGeos), trimMat));
    trimGeos.forEach((g) => g.dispose());

    const chromeTrimMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.6 });
    const chromeGeos = [];
    const cowlGeo = new THREE.BoxGeometry(1.5, 0.03, 0.05);
    cowlGeo.translate(0, 0.9, 0.65);
    chromeGeos.push(cowlGeo);
    [-1, 1].forEach((side) => {
      const railGeo = new THREE.BoxGeometry(0.035, 0.03, 2.1);
      railGeo.translate(side * 0.78, 1.16, -0.15);
      chromeGeos.push(railGeo);
    });
    group.add(new THREE.Mesh(mergeGeometries(chromeGeos), chromeTrimMat));
    chromeGeos.forEach((g) => g.dispose());

    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 2.2 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.2 });
    const headGeos = [];
    const tailGeos = [];
    [-0.6, 0.6].forEach((x) => {
      const hlGeo = new THREE.SphereGeometry(0.08, 8, 8);
      hlGeo.translate(x, 0.42, 2.05);
      headGeos.push(hlGeo);
      const drlGeo = new THREE.BoxGeometry(0.2, 0.022, 0.04);
      drlGeo.translate(x, 0.3, 2.05);
      headGeos.push(drlGeo);
      const tlGeo = new THREE.SphereGeometry(0.07, 8, 8);
      tlGeo.translate(x, 0.42, -2.05);
      tailGeos.push(tlGeo);
    });
    group.add(new THREE.Mesh(mergeGeometries(headGeos), headMat));
    headGeos.forEach((g) => g.dispose());
    group.add(new THREE.Mesh(mergeGeometries(tailGeos), tailMat));
    tailGeos.forEach((g) => g.dispose());
    // Static wheels (no per-wheel telemetry travels over the network for
    // remote players, so these don't spin/steer) — still much better than a
    // body floating with no wheels at all. Two-tone (tire + rim disc) to
    // match the player's own wheel treatment instead of one flat cylinder.
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 });
    // Rims merged into one mesh (one draw call) rather than four — with
    // several other players connected this adds up fast under software
    // rendering; see the same fix (and why) in traffic.js.
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.6 });
    const rimGeos = [];
    [[-0.95, 0.35, 1.4], [0.95, 0.35, 1.4], [-0.95, 0.35, -1.4], [0.95, 0.35, -1.4]].forEach(([wx, wy, wz]) => {
      const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.36, 0.36, 0.28, 14), wheelMat);
      wheel.rotation.z = Math.PI / 2;
      wheel.position.set(wx, wy, wz);
      group.add(wheel);
      const rGeo = new THREE.CylinderGeometry(0.2, 0.2, 0.3, 12);
      rGeo.rotateZ(Math.PI / 2);
      rGeo.translate(wx, wy, wz);
      rimGeos.push(rGeo);
    });
    group.add(new THREE.Mesh(mergeGeometries(rimGeos), rimMat));
    rimGeos.forEach((g) => g.dispose());
    }
    this.bodyStyle = bodyStyle;
    this.color = color; // kept for onCar's rebuild-on-car-change in main.js
    scene.add(group);
    this.group = group;

    this.buffer = []; // { t: local receive time (ms), p:[x,y,z], q:[x,y,z,w] }
    this._initialized = false;
  }

  /**
   * Round-5 (remote players should show the vehicle type they actually
   * picked, not always the generic detailed sedan above): simplified
   * stand-ins for the player-facing _buildTruckBody/_buildBusBody — no
   * per-vertex dent/crumple bookkeeping (remote cars have never shown damage
   * state; there's nowhere for that data to come over the network from
   * anyway), but the same recognizable silhouette, so a truck/bus driver
   * reads as one to everyone else too.
   */
  _buildRemoteTruck(group, color) {
    const THREE = this.THREE;
    const chassisW = 2.15, chassisH = 1.05, chassisL = 5.6;
    const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.6, clearcoat: 0.7, clearcoatRoughness: 0.5, envMapIntensity: 0.55 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.5, metalness: 0.75 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.18, metalness: 0.15, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.6 });

    const cabLen = chassisL * 0.28;
    const cabZ = chassisL / 2 - cabLen / 2 - 0.1;
    const bedLen = chassisL - cabLen - 0.25;
    const bedZ = cabZ - cabLen / 2 - 0.05 - bedLen / 2;
    const bodyTopY = 0.4 + (chassisH * 0.55) / 2;

    const base = new THREE.Mesh(new THREE.BoxGeometry(chassisW, chassisH * 0.55, chassisL), bodyMat);
    base.position.set(0, 0.4, 0);
    base.castShadow = true;
    group.add(base);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.94, chassisH * 0.5, 0.1), bodyMat);
    hood.position.set(0, bodyTopY + chassisH * 0.25, chassisL / 2 - 0.05);
    group.add(hood);
    const windshield = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, chassisH * 0.42, 0.05), glassMat);
    windshield.position.set(0, bodyTopY + chassisH * 0.72, cabZ + cabLen / 2 - 0.03);
    windshield.rotation.x = 0.2;
    group.add(windshield);
    const cabRoof = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.9, 0.35, cabLen * 0.85), bodyMat);
    cabRoof.position.set(0, bodyTopY + chassisH * 0.95, cabZ);
    group.add(cabRoof);

    const bedFloor = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.96, 0.08, bedLen), trimMat);
    bedFloor.position.set(0, bodyTopY + 0.04, bedZ);
    group.add(bedFloor);
    const railH = chassisH * 0.55;
    [-1, 1].forEach((side) => {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(0.08, railH, bedLen), bodyMat);
      rail.position.set(side * (chassisW / 2 - 0.04), bodyTopY + railH / 2, bedZ);
      group.add(rail);
    });
    const tailgate = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.96, railH, 0.08), bodyMat);
    tailgate.position.set(0, bodyTopY + railH / 2, bedZ - bedLen / 2);
    group.add(tailgate);

    this._buildRemoteWheelsAndLights(group, chassisW, chassisL, [chassisL / 2 - 0.9, -chassisL / 2 + 0.7], 0.4);
  }

  _buildRemoteBus(group, color) {
    const THREE = this.THREE;
    const chassisW = 2.3, chassisH = 1.3, chassisL = 8.5;
    const bodyMat = new THREE.MeshPhysicalMaterial({ color, roughness: 0.42, metalness: 0.6, clearcoat: 0.7, clearcoatRoughness: 0.5, envMapIntensity: 0.55 });
    const trimMat = new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.5, metalness: 0.75 });
    const glassMat = new THREE.MeshPhysicalMaterial({ color: 0x0a1018, roughness: 0.18, metalness: 0.15, clearcoat: 0.35, clearcoatRoughness: 0.4, envMapIntensity: 0.6 });

    const bodyTopY = 0.35 + (chassisH * 0.5) / 2;
    const cabinH = chassisH * 1.5;

    const base = new THREE.Mesh(new THREE.BoxGeometry(chassisW, chassisH * 0.5, chassisL), bodyMat);
    base.position.set(0, 0.35, 0);
    base.castShadow = true;
    group.add(base);

    const cabin = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.94, cabinH, chassisL * 0.92), bodyMat);
    cabin.position.set(0, bodyTopY + cabinH / 2, 0);
    group.add(cabin);

    const hood = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, cabinH * 0.5, 0.06), glassMat);
    hood.position.set(0, bodyTopY + cabinH * 0.6, chassisL / 2 - 0.05);
    group.add(hood);
    const rearPanel = new THREE.Mesh(new THREE.BoxGeometry(chassisW * 0.86, cabinH * 0.45, 0.06), glassMat);
    rearPanel.position.set(0, bodyTopY + cabinH * 0.55, -chassisL / 2 + 0.05);
    group.add(rearPanel);

    const winCount = Math.max(3, Math.round(chassisL / 1.1));
    const winLen = (chassisL * 0.8) / winCount * 0.7;
    const winGeos = [];
    for (let i = 0; i < winCount; i++) {
      const z = -chassisL * 0.4 + (i + 0.5) * ((chassisL * 0.8) / winCount);
      [-1, 1].forEach((side) => {
        const wGeo = new THREE.BoxGeometry(0.04, cabinH * 0.4, winLen);
        wGeo.translate(side * (chassisW * 0.94 / 2 + 0.01), bodyTopY + cabinH * 0.58, z);
        winGeos.push(wGeo);
      });
    }
    group.add(new THREE.Mesh(mergeGeometries(winGeos), glassMat));
    winGeos.forEach((g) => g.dispose());

    [-1, 1].forEach((side) => {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.02, 0.1, chassisL * 0.9), trimMat);
      stripe.position.set(side * (chassisW * 0.94 / 2 + 0.005), bodyTopY + cabinH * 0.3, 0);
      group.add(stripe);
    });

    this._buildRemoteWheelsAndLights(group, chassisW, chassisL, [-1, 1].map((s) => s * (chassisL * 0.35)), 0.35);
  }

  /**
   * Shared wheels + head/tail lights for the truck/bus remote-car stand-ins
   * above — static (no spin/steer telemetry travels over the network for
   * remote players, same limitation the sedan-style body above already has).
   */
  _buildRemoteWheelsAndLights(group, chassisW, chassisL, wheelZs, groundY) {
    const THREE = this.THREE;
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x161616, roughness: 0.92 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0xc7cbd1, roughness: 0.4, metalness: 0.85, envMapIntensity: 0.6 });
    const axleX = chassisW / 2 - 0.15;
    const rimGeos = [];
    wheelZs.forEach((wz) => {
      [-axleX, axleX].forEach((wx) => {
        const wheel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.4, 0.32, 14), wheelMat);
        wheel.rotation.z = Math.PI / 2;
        wheel.position.set(wx, groundY, wz);
        group.add(wheel);
        const rGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.34, 12);
        rGeo.rotateZ(Math.PI / 2);
        rGeo.translate(wx, groundY, wz);
        rimGeos.push(rGeo);
      });
    });
    group.add(new THREE.Mesh(mergeGeometries(rimGeos), rimMat));
    rimGeos.forEach((g) => g.dispose());

    const headMat = new THREE.MeshStandardMaterial({ color: 0xfff6dd, emissive: 0xfff2c0, emissiveIntensity: 2.2 });
    const tailMat = new THREE.MeshStandardMaterial({ color: 0x550000, emissive: 0xff2222, emissiveIntensity: 1.2 });
    const headGeos = [], tailGeos = [];
    [-chassisW * 0.32, chassisW * 0.32].forEach((x) => {
      const hlGeo = new THREE.BoxGeometry(0.16, 0.12, 0.04);
      hlGeo.translate(x, 0.5, chassisL / 2 - 0.03);
      headGeos.push(hlGeo);
      const tlGeo = new THREE.BoxGeometry(0.16, 0.12, 0.04);
      tlGeo.translate(x, 0.5, -chassisL / 2 + 0.03);
      tailGeos.push(tlGeo);
    });
    group.add(new THREE.Mesh(mergeGeometries(headGeos), headMat));
    headGeos.forEach((g) => g.dispose());
    group.add(new THREE.Mesh(mergeGeometries(tailGeos), tailMat));
    tailGeos.forEach((g) => g.dispose());
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
