import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { buildCity, ROAD_HALF_WIDTH } from './city.js';
import { Vehicle, RemoteCar } from './vehicle.js';
import { DestructibleField } from './destructibles.js';
import { EffectsSystem } from './effects.js';
import { AudioSystem } from './audio.js';
import { Network } from './network.js';
import { TrafficSystem } from './traffic.js';
import { choice, setAnisotropy } from './utils.js';
import { loadSettings, saveSettings, TRAFFIC_COUNTS } from './settings.js';
import { WeatherSystem } from './weather.js';
import { CAR_PRESETS, CAR_COLORS } from './carPresets.js';
import { spawnRoofUfo, spawnFlyoverUfo } from './easterEggs.js';

const settings = loadSettings();

// Shadow-map resolution per graphics tier — read at boot (city.js's sun is
// created with this size directly) and again on a live settings change
// (see graphicsSelectEl below, which disposes and lets the old map
// regenerate at the new size since a THREE.js shadow map can't just be
// resized in place once it exists).
const SHADOW_SIZES = { low: 512, medium: 1024, high: 2048, ultra: 4096 };

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const renderer = new THREE.WebGLRenderer({ antialias: settings.graphics !== 'low', powerPreference: 'high-performance' });
// Anisotropic filtering level for every procedural texture city.js/utils.js
// builds — has to be set before buildCity() runs below, since textures are
// generated once at world-build time (see utils.js's setAnisotropy doc).
setAnisotropy(Math.min(
  renderer.capabilities.getMaxAnisotropy() || 8,
  settings.graphics === 'ultra' ? 16 : settings.graphics === 'low' ? 2 : 8
));
applyGraphicsSettings(settings.graphics);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
// Was 1.05 — even after dimming the sun/hemi/ambient lights themselves
// (city.js), exposure on top of them was still pushing the overall image
// brighter than intended. Lowered together with those, not instead of them.
renderer.toneMappingExposure = 0.92;
renderer.outputColorSpace = THREE.SRGBColorSpace;
document.body.appendChild(renderer.domElement);
renderer.domElement.style.display = 'none';

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(62, innerWidth / innerHeight, 0.1, 1000);

// A generic studio-style environment map, applied globally via
// scene.environment, is what makes PBR metal/clearcoat materials (car paint,
// glass, streetlight poles, …) actually look real instead of flat — without
// it, MeshStandardMaterial/MeshPhysicalMaterial only have the sky/sun to
// reflect and everything reads as matte plastic regardless of metalness.
const pmremGenerator = new THREE.PMREMGenerator(renderer);
scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
pmremGenerator.dispose();

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
// threshold raised from 0.86→0.94, and now 0.97 — still getting reports of
// the overall scene reading as too bright, and lowering the lights
// themselves (city.js) plus exposure (above) only addresses the base image;
// bloom strength is also nudged down (0.5→0.42) so what DOES cross the
// threshold (headlights, taillights, lit windows) spreads less aggressively.
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.42, 0.6, 0.97);
composer.addPass(bloom);
composer.addPass(new OutputPass());

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
  composer.setSize(innerWidth, innerHeight);
});

// Graphics quality setting: pixel ratio cap + shadow map on/off/quality/size
// + texture anisotropy (see setAnisotropy() above — that part only really
// takes effect at boot, since textures are built once). Antialiasing can
// only be picked at renderer creation (see above), so a change to "low"
// mid-session won't retroactively turn it off — everything else here does
// apply immediately, including "ultra": the highest pixel-ratio cap, the
// largest shadow map, and soft (PCF) shadow filtering like "high" — it's a
// real step up in sharpness/shadow resolution on a machine that can afford
// it, not just a label, though it's still the same engine and lighting
// model underneath, not a different renderer.
function applyGraphicsSettings(level) {
  const caps = { low: 1, medium: 1.5, high: 2, ultra: 2.5 };
  renderer.setPixelRatio(Math.min(devicePixelRatio, caps[level] ?? 2));
  renderer.shadowMap.enabled = level !== 'low';
  renderer.shadowMap.type = (level === 'high' || level === 'ultra') ? THREE.PCFSoftShadowMap : THREE.PCFShadowMap;
  renderer.shadowMap.needsUpdate = true;
}

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
audio.setVolume(settings.volume);

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
const city = buildCity(THREE, CANNON, world, scene, { shadowMapSize: SHADOW_SIZES[settings.graphics] ?? 2048 });

setBootProgress(40, 'Расставляем разрушаемые объекты…');
const destructibles = new DestructibleField(THREE, CANNON, world, scene, {
  onEffect: handleEffect,
  onRest: (id, pose) => net.sendRest({ id, p: pose.p, q: pose.q }),
});
destructibles.spawnField(city.propSpots);

setBootProgress(58, 'Выпускаем трафик…');
const traffic = new TrafficSystem(THREE, CANNON, world, scene, city.streetCoords, {
  laneOffset: ROAD_HALF_WIDTH / 2,
  count: TRAFFIC_COUNTS[settings.traffic] ?? TRAFFIC_COUNTS.medium,
});

setBootProgress(70, 'Настраиваем погоду…');
const weather = new WeatherSystem(THREE, scene, city, city.groundMat);
weather.set(settings.weather);

setBootProgress(80, 'Готовим машину…');
let myColor = choice(CAR_COLORS);
let selectedCarId = CAR_PRESETS[settings.carModel] ? settings.carModel : 'sedan';
function buildVehicleAt(spawnPoint, carId) {
  const preset = CAR_PRESETS[carId] || CAR_PRESETS.sedan;
  return new Vehicle(THREE, CANNON, world, scene, {
    color: myColor,
    position: { x: spawnPoint.x, y: 1.4, z: spawnPoint.z },
    heading: spawnPoint.heading,
    onEffect: handleEffect,
    dims: preset.dims,
    mass: preset.mass,
    maxForce: preset.maxForce,
    maxSteer: preset.maxSteer,
    maxBrakeForce: preset.maxBrakeForce,
  });
}
const spawn = choice(city.spawnPoints);
let car = buildVehicleAt(spawn, selectedCarId);

// Headlights default to on at night, off otherwise — H always lets the
// player override either way (see readInput()'s keydown handling below).
let headlightsOn = settings.weather === 'night';
car.setHeadlightsOn(headlightsOn);

// A hidden, deterministic easter egg — see easterEggs.js for why every
// player finds it in the same spot.
const roofUfo = spawnRoofUfo(THREE, scene, city);

setBootProgress(100, 'Готово');

// ---------------------------------------------------------------------------
// Admin/debug panel (~ key) — local-only conveniences for the player
// running this client; see index.html's #adminOverlay and destructibles.js's
// resetField() doc comment for why these don't touch the network.
// ---------------------------------------------------------------------------
let godMode = false;
let turboMode = false;

function applyAdminStateToCar() {
  car.godMode = godMode;
  const preset = CAR_PRESETS[selectedCarId] || CAR_PRESETS.sedan;
  car.maxForce = preset.maxForce * (turboMode ? 2.2 : 1);
  car.maxBrakeForce = preset.maxBrakeForce * (turboMode ? 2.2 : 1);
}
applyAdminStateToCar();

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
const keys = new Set();
addEventListener('keydown', (e) => {
  // Chat/phone/name-field inputs get their own dedicated key handling
  // (Enter to send, Escape to cancel) — while one is focused, every other
  // shortcut below (including WASD reaching the driving key state at all)
  // is switched off so typing "car" doesn't cycle the camera and respawn.
  const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
  if (typing) return;
  keys.add(e.code);
  if (e.code === 'KeyC') {
    cameraMode = (cameraMode + 1) % 3;
    if (cameraMode === 2) enterFreeCam();
    else exitFreeCam();
  }
  if (e.code === 'KeyR') respawnCar();
  if (e.code === 'KeyP') setPaused(!paused);
  if (e.code === 'KeyM') setPhone(!phoneOpen);
  if (e.code === 'KeyH') {
    headlightsOn = !headlightsOn;
    car.setHeadlightsOn(headlightsOn);
    setNetStatus(headlightsOn ? '💡 Фары включены' : 'Фары выключены');
  }
  if (e.code === 'Backquote') setAdmin(!adminOpen);
  if (e.code === 'Enter' && !paused && !phoneOpen) openChat();
  // Esc closes the menu too, but only when it isn't already busy exiting
  // free-fly's pointer lock (that has its own handler right below) — firing
  // both at once would just reopen the menu the instant free-cam drops out.
  if (e.code === 'Escape' && !freeCam.active) setPaused(!paused);
});
addEventListener('keyup', (e) => keys.delete(e.code));

let cameraMode = 0; // 0 = chase, 1 = close chase, 2 = free-fly

// ---------------------------------------------------------------------------
// Pause menu — an overlay on top of the HUD, not a real engine pause: physics/
// networking/rendering all keep running (so multiplayer never drifts out of
// sync while it's open), only the local car's own input is zeroed out below.
// ---------------------------------------------------------------------------
let paused = false;
const pauseMenuEl = document.getElementById('pauseMenu');
const muteBtnEl = document.getElementById('muteBtn');

function setPaused(v) {
  paused = v;
  pauseMenuEl.style.display = v ? 'flex' : 'none';
}

document.getElementById('menuHintBtn').addEventListener('click', () => setPaused(!paused));
document.getElementById('resumeBtn').addEventListener('click', () => setPaused(false));
document.getElementById('menuRespawnBtn').addEventListener('click', () => {
  respawnCar();
  setPaused(false);
});
muteBtnEl.addEventListener('click', () => {
  const muted = audio.toggleMute();
  muteBtnEl.textContent = muted ? '🔇 Звук: выкл' : '🔊 Звук: вкл';
});

// ---------------------------------------------------------------------------
// Chat — a lightweight HUD log (Enter to open/send, Esc to cancel) that
// shares the same message list with the phone's Messages tab below. Not
// echoed back by the server (see server.js) — sending renders locally right
// away instead of waiting on a round trip.
// ---------------------------------------------------------------------------
let chatOpen = false;
const chatMessages = []; // { id, name, color, text }
const chatLogEl = document.getElementById('chatLog');
const chatInputWrapEl = document.getElementById('chatInputWrap');
const chatInputEl = document.getElementById('chatInput');
const phoneChatLogEl = document.getElementById('phoneChatLog');
const phoneChatInputEl = document.getElementById('phoneChatInput');

function openChat() {
  chatOpen = true;
  chatInputWrapEl.style.display = 'block';
  chatInputEl.value = '';
  chatInputEl.focus();
}
function closeChat() {
  chatOpen = false;
  chatInputWrapEl.style.display = 'none';
  chatInputEl.blur();
}
function renderChatInto(container, msgs) {
  container.innerHTML = '';
  for (const m of msgs) {
    const row = document.createElement('div');
    row.className = 'msg';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = (m.name || `Игрок ${m.id}`) + ':';
    who.style.color = `#${(m.color ?? 0x8fa8ff).toString(16).padStart(6, '0')}`;
    row.appendChild(who);
    row.appendChild(document.createTextNode(m.text)); // textContent-safe — never innerHTML with player-typed text
    container.appendChild(row);
  }
  container.scrollTop = container.scrollHeight;
}
function renderChat() {
  renderChatInto(chatLogEl, chatMessages.slice(-6));
  renderChatInto(phoneChatLogEl, chatMessages);
}
function addChatMessage(msg) {
  chatMessages.push(msg);
  if (chatMessages.length > 50) chatMessages.shift();
  renderChat();
}
function sendChatText(text) {
  const trimmed = text.trim().slice(0, 140);
  if (!trimmed) return;
  net.sendChat(trimmed);
  addChatMessage({ id: net.id, name: myName, color: myColor, text: trimmed });
  triggerEasterEgg(trimmed);
}

// ---------------------------------------------------------------------------
// Easter eggs — typing one of these exact words as a chat message triggers a
// LOCAL-only fun effect for the player who typed it (nothing is sent over
// the network beyond the chat message itself, which was already going out
// above). See easterEggs.js for the UFO mesh/flyover.
// ---------------------------------------------------------------------------
let activeFlyoverUfo = null;
let gravityResetTimer = null;
let partyInterval = null;
let partyTimer = null;

function triggerMoonGravity() {
  world.gravity.set(0, -1.6, 0); // roughly the Moon's surface gravity
  clearTimeout(gravityResetTimer);
  gravityResetTimer = setTimeout(() => world.gravity.set(0, -9.82, 0), 9000);
}

function triggerPartyMode() {
  clearInterval(partyInterval);
  clearTimeout(partyTimer);
  partyInterval = setInterval(() => car.bodyMat.color.setHex(choice(CAR_COLORS)), 130);
  partyTimer = setTimeout(() => {
    clearInterval(partyInterval);
    partyInterval = null;
    car.bodyMat.color.setHex(myColor);
  }, 9000);
}

const EASTER_EGGS = {
  ufo: () => { activeFlyoverUfo = spawnFlyoverUfo(THREE, scene, car.group.position); },
  нло: () => { activeFlyoverUfo = spawnFlyoverUfo(THREE, scene, car.group.position); },
  moon: triggerMoonGravity,
  луна: triggerMoonGravity,
  party: triggerPartyMode,
  пати: triggerPartyMode,
  диско: triggerPartyMode,
};

function triggerEasterEgg(text) {
  const fn = EASTER_EGGS[text.trim().toLowerCase()];
  if (fn) {
    fn();
    setNetStatus('✨ Пасхалка: ' + text.trim().toLowerCase());
  }
}
chatInputEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Enter') {
    sendChatText(chatInputEl.value);
    closeChat();
  } else if (e.code === 'Escape') {
    closeChat();
  }
});
phoneChatInputEl.addEventListener('keydown', (e) => {
  e.stopPropagation();
  if (e.code === 'Enter') {
    sendChatText(phoneChatInputEl.value);
    phoneChatInputEl.value = '';
  }
});
document.getElementById('phoneChatSend').addEventListener('click', () => {
  sendChatText(phoneChatInputEl.value);
  phoneChatInputEl.value = '';
});

// ---------------------------------------------------------------------------
// Phone — a small in-fiction shell around chat/settings/map, toggled with M
// (or the HUD/pause-menu buttons). Opening it locks driving input, same as
// the pause menu, but leaves physics/networking running.
// ---------------------------------------------------------------------------
let phoneOpen = false;
let phoneTab = 'messages';
const phoneOverlayEl = document.getElementById('phoneOverlay');
const phonePages = {
  messages: document.getElementById('phonePageMessages'),
  settings: document.getElementById('phonePageSettings'),
  map: document.getElementById('phonePageMap'),
};

function setPhone(v) {
  phoneOpen = v;
  phoneOverlayEl.style.display = v ? 'flex' : 'none';
  if (v) {
    renderChat();
    refreshSettingsUI();
    if (phoneTab === 'map') drawPhoneMap();
  }
}

document.querySelectorAll('.phoneTab').forEach((btn) => {
  btn.addEventListener('click', () => {
    phoneTab = btn.dataset.tab;
    document.querySelectorAll('.phoneTab').forEach((b) => b.classList.toggle('active', b === btn));
    for (const [name, el] of Object.entries(phonePages)) el.style.display = name === phoneTab ? 'flex' : 'none';
    if (phoneTab === 'map') drawPhoneMap();
  });
});
document.getElementById('phoneCloseBtn').addEventListener('click', () => setPhone(false));
document.getElementById('phoneHintBtn').addEventListener('click', () => setPhone(!phoneOpen));
document.getElementById('menuPhoneBtn').addEventListener('click', () => {
  setPaused(false);
  setPhone(true);
});

function drawPhoneMap() {
  const canvas = document.getElementById('phoneMapCanvas');
  if (!canvas) return;
  drawMinimapInto(canvas, city.cityHalf * 1.15);
}

// ---------------------------------------------------------------------------
// Settings (phone → Настройки) — persisted to localStorage via settings.js.
// ---------------------------------------------------------------------------
const volumeRangeEl = document.getElementById('volumeRange');
const volumeValEl = document.getElementById('volumeVal');
const graphicsSelectEl = document.getElementById('graphicsSelect');
const trafficSelectEl = document.getElementById('trafficSelect');
const weatherSelectEl = document.getElementById('weatherSelect');
const sensRangeEl = document.getElementById('sensRange');
const sensValEl = document.getElementById('sensVal');
const minimapToggleEl = document.getElementById('minimapToggle');
const carSelectEl = document.getElementById('carSelect');
const minimapWrapEl = document.getElementById('minimapWrap');

function refreshSettingsUI() {
  volumeRangeEl.value = Math.round(settings.volume * 100);
  volumeValEl.textContent = Math.round(settings.volume * 100);
  graphicsSelectEl.value = settings.graphics;
  trafficSelectEl.value = settings.traffic;
  weatherSelectEl.value = settings.weather;
  sensRangeEl.value = Math.round(settings.sensitivity * 100);
  sensValEl.textContent = settings.sensitivity.toFixed(1);
  minimapToggleEl.checked = settings.minimap;
  carSelectEl.value = selectedCarId;
}

volumeRangeEl.addEventListener('input', () => {
  settings.volume = Number(volumeRangeEl.value) / 100;
  volumeValEl.textContent = volumeRangeEl.value;
  audio.setVolume(settings.volume);
  saveSettings(settings);
});
graphicsSelectEl.addEventListener('change', () => {
  settings.graphics = graphicsSelectEl.value;
  applyGraphicsSettings(settings.graphics);
  // Shadow map resolution can't just change size in place once it exists —
  // dispose the old one and let three.js regenerate it at the new size on
  // the next shadow pass.
  const size = SHADOW_SIZES[settings.graphics] ?? 2048;
  if (city.sun.shadow.mapSize.width !== size) {
    city.sun.shadow.mapSize.set(size, size);
    if (city.sun.shadow.map) {
      city.sun.shadow.map.dispose();
      city.sun.shadow.map = null;
    }
  }
  saveSettings(settings);
});
trafficSelectEl.addEventListener('change', () => {
  settings.traffic = trafficSelectEl.value;
  traffic.setCount(TRAFFIC_COUNTS[settings.traffic] ?? TRAFFIC_COUNTS.medium);
  saveSettings(settings);
});
weatherSelectEl.addEventListener('change', () => {
  settings.weather = weatherSelectEl.value;
  weather.set(settings.weather);
  saveSettings(settings);
});
sensRangeEl.addEventListener('input', () => {
  settings.sensitivity = Number(sensRangeEl.value) / 100;
  sensValEl.textContent = settings.sensitivity.toFixed(1);
  saveSettings(settings);
});
minimapToggleEl.addEventListener('change', () => {
  settings.minimap = minimapToggleEl.checked;
  minimapWrapEl.style.display = settings.minimap ? 'block' : 'none';
  saveSettings(settings);
});
document.getElementById('applyCarBtn').addEventListener('click', () => {
  const newId = carSelectEl.value;
  selectedCarId = newId;
  settings.carModel = newId;
  saveSettings(settings);
  const s = choice(city.spawnPoints);
  car.dispose(scene);
  car = buildVehicleAt(s, newId);
  car.setHeadlightsOn(headlightsOn);
  applyAdminStateToCar();
  setPhone(false);
});

// ---------------------------------------------------------------------------
// Admin/debug panel (~ key) — see the state vars + applyAdminStateToCar()
// declared up near where `car` is first built.
// ---------------------------------------------------------------------------
let adminOpen = false;
const adminOverlayEl = document.getElementById('adminOverlay');
const adminGodEl = document.getElementById('adminGod');
const adminTurboEl = document.getElementById('adminTurbo');

function setAdmin(v) {
  adminOpen = v;
  adminOverlayEl.style.display = v ? 'flex' : 'none';
  if (v) {
    adminGodEl.checked = godMode;
    adminTurboEl.checked = turboMode;
  }
}
adminGodEl.addEventListener('change', () => {
  godMode = adminGodEl.checked;
  applyAdminStateToCar();
});
adminTurboEl.addEventListener('change', () => {
  turboMode = adminTurboEl.checked;
  applyAdminStateToCar();
});
document.getElementById('adminTeleportBtn').addEventListener('click', () => {
  const s = choice(city.spawnPoints);
  car.respawn({ x: s.x, y: 1.8, z: s.z }, s.heading);
});
document.getElementById('adminTrafficBurstBtn').addEventListener('click', () => {
  traffic.setCount(traffic.cars.length + 10);
});
document.getElementById('adminClearTrafficBtn').addEventListener('click', () => {
  traffic.setCount(0);
});
document.getElementById('adminResetPropsBtn').addEventListener('click', () => {
  destructibles.resetField(city.propSpots);
});
document.getElementById('adminCloseBtn').addEventListener('click', () => setAdmin(false));

// ---------------------------------------------------------------------------
// Free-fly camera: mouse-look (pointer lock) + WASD/QE flight, independent of
// the car. While active, WASD drives the camera instead of the car — the car
// stays drivable via the arrow keys so you can still watch it move around.
// ---------------------------------------------------------------------------
const freeCam = { pos: new THREE.Vector3(), yaw: 0, pitch: 0, active: false };

function enterFreeCam() {
  freeCam.pos.copy(camera.position);
  const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
  freeCam.yaw = euler.y;
  freeCam.pitch = euler.x;
  freeCam.active = true;
  if (renderer.domElement.requestPointerLock) renderer.domElement.requestPointerLock();
  setNetStatus('Свободная камера: мышь — обзор, WASD — полёт, Q/E — высота, Shift — ускорение, C — выход');
}

function exitFreeCam() {
  freeCam.active = false;
  if (document.pointerLockElement === renderer.domElement) document.exitPointerLock();
}

addEventListener('mousemove', (e) => {
  if (!freeCam.active || document.pointerLockElement !== renderer.domElement) return;
  const sens = 0.0025 * settings.sensitivity;
  freeCam.yaw -= e.movementX * sens;
  freeCam.pitch -= e.movementY * sens;
  const limit = Math.PI / 2 - 0.01;
  freeCam.pitch = Math.max(-limit, Math.min(limit, freeCam.pitch));
});

document.addEventListener('pointerlockchange', () => {
  // user hit Esc (or lost focus) — fall back to chase cam rather than being
  // stuck in a free cam that can no longer look around
  if (freeCam.active && document.pointerLockElement !== renderer.domElement) {
    freeCam.active = false;
    cameraMode = 0;
  }
});

function updateFreeCam(dt) {
  const euler = new THREE.Euler(freeCam.pitch, freeCam.yaw, 0, 'YXZ');
  camera.quaternion.setFromEuler(euler);
  const forward = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  const speed = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 65 : 22;
  if (keys.has('KeyW')) freeCam.pos.addScaledVector(forward, speed * dt);
  if (keys.has('KeyS')) freeCam.pos.addScaledVector(forward, -speed * dt);
  if (keys.has('KeyA')) freeCam.pos.addScaledVector(right, -speed * dt);
  if (keys.has('KeyD')) freeCam.pos.addScaledVector(right, speed * dt);
  if (keys.has('KeyE')) freeCam.pos.y += speed * dt;
  if (keys.has('KeyQ')) freeCam.pos.y -= speed * dt;
  camera.position.copy(freeCam.pos);
}

function readInput() {
  if (paused || chatOpen || phoneOpen || adminOpen) return { throttle: 0, steer: 0, brake: 0, handbrake: false };

  // While free-flying, WASD steers the camera instead — the car is still
  // drivable through the arrow keys so it doesn't just sit there.
  const useWasdForDriving = cameraMode !== 2;
  const fwd = (useWasdForDriving && keys.has('KeyW')) || keys.has('ArrowUp');
  const back = (useWasdForDriving && keys.has('KeyS')) || keys.has('ArrowDown');
  const left = (useWasdForDriving && keys.has('KeyA')) || keys.has('ArrowLeft');
  const right = (useWasdForDriving && keys.has('KeyD')) || keys.has('ArrowRight');
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

// Real cars (the local player + every other connected player) for the AI
// traffic system to brake for, on top of the other traffic cars it already
// avoids — see traffic.js's update() doc comment for why the tolerances
// here are wider than the traffic-vs-traffic check.
function getTrafficObstacles() {
  const list = [{ x: car.group.position.x, z: car.group.position.z, panicRadius: 3.6, lateral: 3, lookahead: 11 }];
  for (const rc of remoteCars.values()) {
    list.push({ x: rc.group.position.x, z: rc.group.position.z, panicRadius: 3.6, lateral: 3, lookahead: 11 });
  }
  return list;
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

// Car picker on the start screen — just updates `selectedCarId`; the actual
// car gets (re)built for that choice once "Сесть за руль" is clicked below.
document.querySelectorAll('.carOption').forEach((el) => {
  el.classList.toggle('selected', el.dataset.car === selectedCarId);
  el.addEventListener('click', () => {
    selectedCarId = el.dataset.car;
    document.querySelectorAll('.carOption').forEach((o) => o.classList.toggle('selected', o === el));
  });
});

// Settings persisted from a previous session (a different minimap/car choice
// than the hardcoded defaults) need applying once, here, before the HUD
// becomes visible.
minimapWrapEl.style.display = settings.minimap ? 'block' : 'none';

document.getElementById('startBtn').addEventListener('click', () => {
  myName = document.getElementById('nameHint').value.trim().slice(0, 16);
  document.getElementById('startOverlay').style.display = 'none';
  document.getElementById('hud').style.display = 'block';
  renderer.domElement.style.display = 'block';
  audio.resume(); // user gesture — required before Web Audio can produce sound
  net.setName(myName);
  net.connect();
  // The car built during boot used whatever model was saved from last time;
  // rebuild it now against whatever the player actually picked just above.
  settings.carModel = selectedCarId;
  saveSettings(settings);
  car.dispose(scene);
  car = buildVehicleAt(spawn, selectedCarId);
  car.setHeadlightsOn(headlightsOn);
  applyAdminStateToCar();
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
  // Camera sits BEHIND the car (opposite the forward/headlight direction) and
  // looks at a point AHEAD of it. This was inverted before — the camera sat
  // in front of the car looking at a point behind it, so driving forward
  // moved the car toward the camera tail-first, reading as "driving in
  // reverse" even though the physics/input direction was always correct.
  camOffset.copy(car.group.position).addScaledVector(forward, -back);
  camOffset.y += up;
  camera.position.lerp(camOffset, 1 - Math.pow(0.001, dt));
  camTarget.copy(car.group.position).addScaledVector(forward, 6);
  camTarget.y += 1.2;
  camera.lookAt(camTarget);
}

// Heading (yaw) extracted straight from the car's quaternion — shared by the
// skid marks, minimap arrow and compass strip so it's only derived once.
function getCarYaw() {
  const q = car.group.quaternion;
  return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
}

// Upper bound used only to normalize the HUD speed gauge's ring fill (0..1).
const SPEED_GAUGE_MAX_KMH = 180;

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
      effects.addSkidMark(w.position, getCarYaw());
      if (skidTick % 6 === 0) effects.spawnDust({ x: w.position.x, y: w.position.y + 0.1, z: w.position.z }, 1);
    }
  }
  audio.updateScreech(maxSkid > 0.15 ? maxSkid : 0);
}

// ---------------------------------------------------------------------------
// Compass strip — a horizontally-scrolling heading tape (N/E/S/W + degree
// ticks) centered on the car's current heading, drawn fresh each frame.
// ---------------------------------------------------------------------------
const compassCanvas = document.getElementById('compass');
const cpCtx = compassCanvas ? compassCanvas.getContext('2d') : null;
const CP_W = compassCanvas ? compassCanvas.width : 0;
const CP_H = compassCanvas ? compassCanvas.height : 0;
const CP_PX_PER_DEG = 2.1;
const COMPASS_LABELS = [
  { deg: 0, label: 'N' }, { deg: 45, label: 'СВ' }, { deg: 90, label: 'E' },
  { deg: 135, label: 'ЮВ' }, { deg: 180, label: 'S' }, { deg: 225, label: 'ЮЗ' },
  { deg: 270, label: 'W' }, { deg: 315, label: 'СЗ' },
];
function drawCompass() {
  if (!cpCtx) return;
  const headingDeg = ((-getCarYaw() * 180) / Math.PI + 360) % 360;
  cpCtx.clearRect(0, 0, CP_W, CP_H);
  cpCtx.save();
  cpCtx.beginPath();
  cpCtx.rect(0, 0, CP_W, CP_H);
  cpCtx.clip();

  cpCtx.strokeStyle = 'rgba(255,255,255,0.35)';
  cpCtx.fillStyle = 'rgba(255,255,255,0.85)';
  cpCtx.font = '11px -apple-system, Segoe UI, Roboto, sans-serif';
  cpCtx.textAlign = 'center';

  for (let deg = -360; deg <= 720; deg += 15) {
    let diff = deg - headingDeg;
    diff = ((diff + 180) % 360 + 360) % 360 - 180; // shortest signed diff, wraps at ±360
    const x = CP_W / 2 + diff * CP_PX_PER_DEG;
    if (x < -20 || x > CP_W + 20) continue;
    const norm = ((deg % 360) + 360) % 360;
    const major = COMPASS_LABELS.find((l) => l.deg === norm);
    const tickH = major ? 10 : 5;
    cpCtx.beginPath();
    cpCtx.moveTo(x, CP_H - tickH);
    cpCtx.lineTo(x, CP_H);
    cpCtx.stroke();
    if (major) cpCtx.fillText(major.label, x, CP_H - 13);
  }

  cpCtx.restore();
  // center marker (current heading)
  cpCtx.fillStyle = '#22d3ee';
  cpCtx.beginPath();
  cpCtx.moveTo(CP_W / 2 - 4, 2);
  cpCtx.lineTo(CP_W / 2 + 4, 2);
  cpCtx.lineTo(CP_W / 2, 8);
  cpCtx.closePath();
  cpCtx.fill();
}

// ---------------------------------------------------------------------------
// Minimap — simple top-down 2D canvas, centered on the local player, drawn
// straight from the same building footprints the physics world uses.
// ---------------------------------------------------------------------------
const minimapCanvas = document.getElementById('minimap');
const MM_RANGE = 90; // world units visible across the small HUD minimap

// Shared drawing code for both the small HUD minimap and the phone's bigger
// map view — same logic, different canvas/range.
function drawMinimapInto(canvas, range) {
  const ctx = canvas ? canvas.getContext('2d') : null;
  if (!ctx) return;
  const size = canvas.width;
  const scale = size / (range * 2);
  const px = car.group.position.x;
  const pz = car.group.position.z;

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = 'rgba(8,10,18,0.55)';
  ctx.fillRect(0, 0, size, size);

  const toMM = (wx, wz) => [size / 2 + (wx - px) * scale, size / 2 + (wz - pz) * scale];

  ctx.fillStyle = 'rgba(120,130,160,0.55)';
  for (const f of city.footprints) {
    if (Math.abs(f.x - px) > range + 20 || Math.abs(f.z - pz) > range + 20) continue;
    const [x, z] = toMM(f.x - f.w / 2, f.z - f.d / 2);
    ctx.fillRect(x, z, f.w * scale, f.d * scale);
  }

  // AI traffic as small dim dots — helps read the road layout too
  ctx.fillStyle = 'rgba(230,230,235,0.6)';
  for (const t of traffic.cars) {
    const [x, z] = toMM(t.mesh.position.x, t.mesh.position.z);
    if (x < 0 || x > size || z < 0 || z > size) continue;
    ctx.fillRect(x - 1.5, z - 1.5, 3, 3);
  }

  for (const rc of remoteCars.values()) {
    const [x, z] = toMM(rc.group.position.x, rc.group.position.z);
    if (x < 0 || x > size || z < 0 || z > size) continue;
    ctx.fillStyle = `#${rc.group.children[0].material.color.getHexString()}`;
    ctx.beginPath();
    ctx.arc(x, z, 3.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // local player as a heading-oriented arrow, always centered
  const yaw = getCarYaw();
  const cx = size / 2, cz = size / 2;
  ctx.save();
  ctx.translate(cx, cz);
  ctx.rotate(yaw);
  ctx.fillStyle = `#${myColor.toString(16).padStart(6, '0')}`;
  ctx.beginPath();
  ctx.moveTo(0, -7);
  ctx.lineTo(5, 6);
  ctx.lineTo(-5, 6);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawMinimap() {
  drawMinimapInto(minimapCanvas, MM_RANGE);
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

  // Safety net for the admin panel's turbo mode stacked with the "moon"
  // easter egg's low gravity (or any other combination that pushes the
  // physics tuning outside what it was validated for) — if that ever
  // leaves the chassis with a non-finite position or flings it somewhere
  // absurd, auto-respawn instead of leaving the player permanently stuck or
  // staring at a broken car for the rest of the session. Bounds are
  // generous (well past the playable city) so this never fires during
  // normal driving.
  {
    const p = car.chassisBody.position;
    const OUT_OF_BOUNDS = city.cityHalf + 250;
    const broken = !Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z);
    const lost = Math.abs(p.x) > OUT_OF_BOUNDS || Math.abs(p.z) > OUT_OF_BOUNDS || p.y < -50 || p.y > 400;
    if (broken || lost) {
      respawnCar();
      setNetStatus('Машину занесло куда-то не туда — вернул на респавн');
    }
  }

  destructibles.update(dt);
  effects.update(dt);
  traffic.update(dt, getTrafficObstacles());
  weather.update(dt, car.group.position);
  if (roofUfo) roofUfo.update(dt);
  if (activeFlyoverUfo) {
    activeFlyoverUfo.update(dt);
    if (activeFlyoverUfo.done) activeFlyoverUfo = null;
  }
  for (const rc of remoteCars.values()) rc.update(dt);
  if (cameraMode === 2) updateFreeCam(dt);
  else updateCamera(dt);

  const speedKmh = car.getSpeedKmh();
  audio.updateEngine(car.chassisBody.velocity.length(), Math.abs(input.throttle));
  updateSkidFx(dt, speedKmh);
  drawMinimap();
  drawCompass();
  if (phoneOpen && phoneTab === 'map') drawPhoneMap();

  // network: send our transform ~20Hz
  netAccum += dt;
  if (netAccum > 1 / 20) {
    netAccum = 0;
    const t = car.getTransform();
    net.sendState({ p: t.p, q: t.q });
  }
  for (const hit of destructibles.drainHits()) net.sendHit(hit);

  document.getElementById('speedVal').textContent = Math.round(speedKmh);
  const speedGaugeEl = document.getElementById('speedGauge');
  if (speedGaugeEl) speedGaugeEl.style.setProperty('--pct', Math.min(1, speedKmh / SPEED_GAUGE_MAX_KMH));

  composer.render();
}
