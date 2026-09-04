import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

import { buildCity } from './city.js';
import { Vehicle, RemoteCar } from './vehicle.js';
import { DestructibleField } from './destructibles.js';
import { EffectsSystem } from './effects.js';
import { AudioSystem } from './audio.js';
import { Network } from './network.js';
import { choice } from './utils.js';

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = 'none';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1000);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.6, 0.86);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------
const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -9.82, 0) });
world.broadphase = new CANNON.SAPBroadphase(world);
world.solver.iterations = 12;
world.defaultContactMaterial.friction = 0.5;
world.allowSleep = true;

// ---------------------------------------------------------------------------
// Effects / audio (visual & sound reactions to physics events — see vehicle.js
// and destructibles.js, which call onEffect()/onRest() but know nothing about
// particles, sound or the network; that wiring lives here).
// ---------------------------------------------------------------------------
const effects = new EffectsSystem(THREE, scene);
const audio = new AudioSystem();

function handleEffect(kind, pos, strength) {
  const p = new THREE.Vector3(pos.x, pos.y, pos.z);
  if (kind === 'shatter') {
    effects.spawnSmoke(p, 8);
    effects.spawnSparks(p, 6);
    audio.playImpact(Math.min(1, strength + 0.35));
  } else {
    effects.spawnSparks(p, Math.round(4 + strength * 8));
    effects.spawnDust(p, 4);
    audio.playImpact(strength);
  }
}

// ---------------------------------------------------------------------------
// World content
// ---------------------------------------------------------------------------
setBootProgress(12, 'Строим город…');
const city = buildCity(THREE, CANNON, world, scene);

setBootProgress(45, 'Расставляем разрушаемые объекты…');
const destructibles = new DestructibleField(THREE, CANNON, world, scene, {
  onEffect: handleEffect,
  onRest: (id, pose) => net.sendRest({ id, p: pose.p, q: pose.q }),
});
destructibles.spawnField(city.propSpots);

setBootProgress(75, 'Готовим машину…');
const CAR_COLORS = [0xff3b30, 0x34c759, 0x0a84ff, 0xffcc00, 0xaf52de, 0xff9500, 0x5ac8fa, 0xff2d55];
let myColor = choice(CAR_COLORS);
const spawn = choice(city.spawnPoints);
let car = new Vehicle(THREE, CANNON, world, scene, {
  color: myColor,
  position: { x: spawn.x, y: 1.4, z: spawn.z },
  heading: spawn.heading,
  onEffect: handleEffect,
});

setBootProgress(100, 'Готово');

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => {
  keys.add(e.code);
  if (e.code === 'KeyC') cameraMode = (cameraMode + 1) % 2;
  if (e.code === 'KeyR') respawnCar();
});
addEventListener('keyup', (e) => keys.delete(e.code));

let cameraMode = 0; // 0 = chase, 1 = close chase

function readInput() {
  const fwd = keys.has('KeyW') || keys.has('ArrowUp');
  const back = keys.has('KeyS') || keys.has('ArrowDown');
  const left = keys.has('KeyA') || keys.has('ArrowLeft');
  const right = keys.has('KeyD') || keys.has('ArrowRight');
  const handbrake = keys.has('Space');

  let throttle = 0;
  if (fwd) throttle -= 1;
  if (back) throttle += 1;
  // Verified against the underlying cannon-es RaycastVehicle convention:
  // a positive steering value turns the car to the right, so "left" must
  // send a negative value here.
  let steer = 0;
  if (left) steer -= 1;
  if (right) steer += 1;

  return { throttle, steer, brake: 0, handbrake };
}

function respawnCar() {
  const s = choice(city.spawnPoints);
  car.respawn({ x: s.x, y: 1.6, z: s.z }, s.heading);
}

// ---------------------------------------------------------------------------
// Multiplayer
// ---------------------------------------------------------------------------
const remoteCars = new Map(); // id -> RemoteCar
const playerNames = new Map();
let myName = '';

const net = new Network({
  onWelcome(msg) {
    myColor = msg.color;
    rebuildCarColor();
    for (const p of msg.players) {
      spawnRemote(p.id, p.color, p.state);
      if (p.name) playerNames.set(p.id, p.name);
    }
    // Catch up on world destruction that happened before we joined.
    for (const id of msg.shatteredIds || []) destructibles.applyRemoteShatter(id);
    for (const r of msg.propRest || []) destructibles.applyRemoteRest(r.id, r.p, r.q);
    refreshPlayerList();
    setNetStatus(`В сети: вы + ${msg.players.length}`);
  },
  onJoin(msg) {
    spawnRemote(msg.id, msg.color, null);
    refreshPlayerList();
  },
  onLeave(msg) {
    const rc = remoteCars.get(msg.id);
    if (rc) {
      rc.dispose(scene);
      remoteCars.delete(msg.id);
    }
    playerNames.delete(msg.id);
    refreshPlayerList();
  },
  onState(msg) {
    const rc = remoteCars.get(msg.id);
    if (rc) rc.setTarget(msg.state);
  },
  onName(msg) {
    playerNames.set(msg.id, msg.name);
    refreshPlayerList();
  },
  onHit(msg) {
    if (!msg.payload || typeof msg.payload.id !== 'number') return;
    if (msg.payload.shatter) destructibles.applyRemoteShatter(msg.payload.id);
    else destructibles.applyRemoteHit(msg.payload.id, msg.payload.impulse);
  },
  onRest(msg) {
    if (msg.payload && typeof msg.payload.id === 'number') {
      destructibles.applyRemoteRest(msg.payload.id, msg.payload.p, msg.payload.q);
    }
  },
  onConnectionChange(connected) {
    setNetStatus(connected ? 'Соединение установлено' : 'Соединение потеряно — переподключаемся…');
  },
  onPing(rttMs) {
    const el = document.getElementById('ping');
    if (el) el.textContent = `${Math.round(rttMs)} мс`;
  },
});

function spawnRemote(id, color, state) {
  if (remoteCars.has(id)) return;
  const rc = new RemoteCar(THREE, scene, color);
  if (state) rc.setTarget(state);
  remoteCars.set(id, rc);
}

function rebuildCarColor() {
  // recolor the local car body to the server-assigned color (the car is
  // built with a random placeholder color before the server confirms one)
  car.bodyMat.color.setHex(myColor);
}

function refreshPlayerList() {
  const list = document.getElementById('playerList');
  list.innerHTML = '';
  const meRow = document.createElement('div');
  meRow.className = 'row';
  const meDot = document.createElement('span');
  meDot.className = 'dot';
  meDot.style.background = `#${myColor.toString(16).padStart(6, '0')}`;
  const meLabel = document.createElement('span');
  meLabel.textContent = `${myName || 'Вы'} (вы)`;
  meRow.append(meDot, meLabel);
  list.appendChild(meRow);
  for (const [id, rc] of remoteCars) {
    const row = document.createElement('div');
    row.className = 'row';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `#${rc.group.children[0].material.color.getHexString()}`;
    const label = document.createElement('span');
    label.textContent = playerNames.get(id) || `Игрок ${id}`;
    row.append(dot, label);
    list.appendChild(row);
  }
}

function setNetStatus(text) {
  const el = document.getElementById('netStatus');
  el.textContent = text;
  el.style.display = 'block';
  clearTimeout(setNetStatus._t);
  setNetStatus._t = setTimeout(() => (el.style.display = 'none'), 2500);
}

// ---------------------------------------------------------------------------
// Boot / start overlay wiring
// ---------------------------------------------------------------------------
function setBootProgress(pct, label) {
  const fill = document.getElementById('bootFill');
  if (fill) fill.style.width = pct + '%';
  const boot = document.getElementById('boot');
  if (boot && label) boot.firstElementChild.textContent = label;
  if (pct >= 100) {
    setTimeout(() => {
      boot.style.display = 'none';
      document.getElementById('startOverlay').style.display = 'flex';
    }, 200);
  }
}

document.getElementById('startBtn').addEventListener('click', () => {
  myName = document.getElementById('nameHint').value.trim().slice(0, 16);
  document.getElementById('startOverlay').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  renderer.domElement.style.display = 'block';
  audio.resume(); // user gesture — required before Web Audio can produce sound
  net.setName(myName);
  net.connect();
  lastTime = performance.now();
  requestAnimationFrame(loop);
});

// ---------------------------------------------------------------------------
// Camera follow
// ---------------------------------------------------------------------------
const camOffset = new THREE.Vector3();
const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  const back = cameraMode === 0 ? 8.5 : 4.5;
  const up = cameraMode === 0 ? 3.6 : 2.0;
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(car.group.quaternion);
  camOffset.copy(car.group.position).addScaledVector(forward, back);
  camOffset.y += up;
  camera.position.lerp(camOffset, 1 - Math.pow(0.001, dt));
  camTarget.copy(car.group.position).addScaledVector(forward, -6);
  camTarget.y += 1.2;
  camera.lookAt(camTarget);
}

// ---------------------------------------------------------------------------
// Skid marks / dust / screech — reads cannon-es's own per-wheel slip state
// off the car (see Vehicle.getWheelSkidStates) rather than guessing from
// speed, so marks only appear when the tires are actually sliding.
// ---------------------------------------------------------------------------
let skidTick = 0;
function updateSkidFx(dt, speedKmh) {
  skidTick++;
  const states = car.getWheelSkidStates();
  let maxSkid = 0;
  for (const w of states) {
    if (!w.inContact) continue;
    maxSkid = Math.max(maxSkid, w.skidAmount);
    if (w.skidding && speedKmh > 8 && skidTick % 2 === 0) {
      const yaw = Math.atan2(
        2 * (car.group.quaternion.w * car.group.quaternion.y + car.group.quaternion.x * car.group.quaternion.z),
        1 - 2 * (car.group.quaternion.y * car.group.quaternion.y + car.group.quaternion.x * car.group.quaternion.x)
      );
      effects.addSkidMark(w.position, yaw);
      if (skidTick % 6 === 0) effects.spawnDust({ x: w.position.x, y: w.position.y + 0.1, z: w.position.z }, 1);
    }
  }
  audio.updateScreech(maxSkid > 0.15 ? maxSkid : 0);
}

// ---------------------------------------------------------------------------
// Minimap — simple top-down 2D canvas, centered on the local player, drawn
// straight from the same building footprints the physics world uses.
// ---------------------------------------------------------------------------
const minimapCanvas = document.getElementById('minimap');
const mmCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
const MM_SIZE = minimapCanvas ? minimapCanvas.width : 0;
const MM_RANGE = 90; // world units visible across the minimap
function drawMinimap() {
  if (!mmCtx) return;
  const scale = MM_SIZE / (MM_RANGE * 2);
  const px = car.group.position.x;
  const pz = car.group.position.z;

  mmCtx.clearRect(0, 0, MM_SIZE, MM_SIZE);
  mmCtx.fillStyle = 'rgba(8,10,18,0.55)';
  mmCtx.fillRect(0, 0, MM_SIZE, MM_SIZE);

  const toMM = (wx, wz) => [MM_SIZE / 2 + (wx - px) * scale, MM_SIZE / 2 + (wz - pz) * scale];

  mmCtx.fillStyle = 'rgba(120,130,160,0.55)';
  for (const f of city.footprints) {
    if (Math.abs(f.x - px) > MM_RANGE + 20 || Math.abs(f.z - pz) > MM_RANGE + 20) continue;
    const [x, z] = toMM(f.x - f.w / 2, f.z - f.d / 2);
    mmCtx.fillRect(x, z, f.w * scale, f.d * scale);
  }

  for (const rc of remoteCars.values()) {
    const [x, z] = toMM(rc.group.position.x, rc.group.position.z);
    if (x < 0 || x > MM_SIZE || z < 0 || z > MM_SIZE) continue;
    mmCtx.fillStyle = `#${rc.group.children[0].material.color.getHexString()}`;
    mmCtx.beginPath();
    mmCtx.arc(x, z, 3.5, 0, Math.PI * 2);
    mmCtx.fill();
  }

  // local player as a heading-oriented arrow, always centered
  const yaw = Math.atan2(
    2 * (car.group.quaternion.w * car.group.quaternion.y + car.group.quaternion.x * car.group.quaternion.z),
    1 - 2 * (car.group.quaternion.y * car.group.quaternion.y + car.group.quaternion.x * car.group.quaternion.x)
  );
  const cx = MM_SIZE / 2, cz = MM_SIZE / 2;
  mmCtx.save();
  mmCtx.translate(cx, cz);
  mmCtx.rotate(yaw);
  mmCtx.fillStyle = `#${myColor.toString(16).padStart(6, '0')}`;
  mmCtx.beginPath();
  mmCtx.moveTo(0, -7);
  mmCtx.lineTo(5, 6);
  mmCtx.lineTo(-5, 6);
  mmCtx.closePath();
  mmCtx.fill();
  mmCtx.restore();
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
let lastTime = performance.now();
let netAccum = 0;
const FIXED_DT = 1 / 60;

function loop(now) {
  requestAnimationFrame(loop);
  let dt = (now - lastTime) / 1000;
  lastTime = now;
  dt = Math.min(dt, 0.05);

  const input = readInput();
  car.setInput(input);
  world.step(FIXED_DT, dt, 5);
  car.update(dt);
  destructibles.update(dt);
  effects.update(dt);
  for (const rc of remoteCars.values()) rc.update(dt);
  updateCamera(dt);

  const speedKmh = car.getSpeedKmh();
  audio.updateEngine(car.chassisBody.velocity.length(), Math.abs(input.throttle));
  updateSkidFx(dt, speedKmh);
  drawMinimap();

  // network: send our transform ~20Hz
  netAccum += dt;
  if (netAccum > 1 / 20) {
    netAccum = 0;
    const t = car.getTransform();
    net.sendState({ p: t.p, q: t.q });
  }
  for (const hit of destructibles.drainHits()) net.sendHit(hit);

  document.getElementById('speedVal').textContent = Math.round(speedKmh);

  composer.render();
}
