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
import { RadioSystem } from './radio.js';
import { Network } from './network.js';
import { TrafficSystem } from './traffic.js';
import { TrafficLightSystem } from './trafficLights.js';
import { choice, setAnisotropy } from './utils.js';
import { loadSettings, saveSettings, TRAFFIC_COUNTS } from './settings.js';
import { WeatherSystem } from './weather.js';
import { CAR_PRESETS, CAR_COLORS } from './carPresets.js';
import { spawnRoofUfo, spawnFlyoverUfo } from './easterEggs.js';

// Round 6: a visible build marker (bottom-right corner, plus shown per-player
// in the online list — see spawnRemote/refreshPlayerList below) so two
// people can actually SEE whether they're both on the same deployed build
// instead of guessing from symptoms like "your car looks different to me".
// Bump this string whenever a round of changes ships.
export const GAME_VERSION = 'r7 · 2026-09-06';
const versionTagEl = document.getElementById('versionTag');
if (versionTagEl) versionTagEl.textContent = `City Drive ${GAME_VERSION}`;

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
// threshold raised from 0.86→0.94→0.97, strength 0.5→0.42 — still getting
// reports of glare/hotspots (round 3), even after the clearcoat materials
// themselves were softened (vehicle.js/traffic.js/city.js). Pushed both
// again: threshold 0.97→0.99 (only the genuinely brightest points — actual
// light sources — bloom now, not a shiny paint highlight) and strength
// 0.42→0.34 (less spread on whatever does cross it).
const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.34, 0.6, 0.99);
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
// Raised from 12 (round 3: "убери проезжание сквозь домов" — cars were able
// to visibly sink into / clip through building corners at speed). More
// solver iterations converge to a smaller penetration depth per contact
// before the next step runs. This alone is NOT true continuous collision
// detection (cannon-es doesn't have that — a body moving fast enough can
// still tunnel clean through in one step), which is why the real fix is the
// per-frame building-overlap correction in resolveBuildingOverlap() below;
// this is just the cheap complementary half that makes ordinary low-speed
// contact against a wall feel a bit more solid too.
//
// NOTE: an earlier version of this fix also raised
// defaultContactMaterial.contactEquationStiffness (1e7 → 1e8). That turned
// out to be a real mistake, not just an untested guess left in — it was
// caught by this project's own smoke test: a turbo-mode ram into a building
// left the physics in a bad state that only surfaced a couple of scripted
// actions later (chat + graphics-switch + camera moves all still worked;
// the very next keyboard action then hung for the rest of the test run,
// which is consistent with the stiffer solver producing a huge or NaN
// velocity on a hard collision that the existing NaN/out-of-bounds safety
// net further down doesn't catch until the NEXT physics step, by which
// point a frame tried to render/shadow-map geometry at wild coordinates and
// the software rasterizer choked on it). Reverted to the default stiffness;
// resolveBuildingOverlap() below doesn't depend on it at all.
world.solver.iterations = 16;
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
// Round 7 ("добавь типо радио ... переключать или выключить" — Q key
// cycles an in-car radio through a few stations, or off). Shares audio's
// AudioContext/master gain rather than owning its own — see radio.js.
const radio = new RadioSystem(audio);

function handleEffect(kind, pos, strength) {
  const p = new THREE.Vector3(pos.x, pos.y, pos.z);
  if (kind === 'explosion') {
    // Round 7 ("сделай в 10 раз летальнее машини"): a totalled car (see
    // vehicle.js's _explode()) gets the loudest, biggest effect in the
    // game — a real destruction moment, not just another impact clank.
    effects.spawnExplosion(p);
    audio.playImpact(1);
  } else if (kind === 'shatter') {
    effects.spawnSmoke(p, 8);
    effects.spawnSparks(p, 6);
    audio.playImpact(Math.min(1, strength + 0.35));
  } else if (kind === 'smoke') {
    // Continuous engine-bay/trunk smoke from a heavily damaged car (see
    // vehicle.js's damage tracking) — no impact sound here, this isn't a
    // one-shot collision, just an ongoing "this car is wrecked" tell.
    effects.spawnSmoke(p, 2);
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
// Round 7 ("add traffic lights so NPCs don't crash into each other"): one
// shared signal phase for the whole (grid) city — see trafficLights.js for
// why a single global phase is enough here. traffic.update() below queries
// it every frame to decide whether an AI car approaching a crossing should
// brake.
// Round-7 follow-up ("на обочине, а не посередине перекрёстка" — the pole
// itself was planted well inside the road, only 3.4 units out on a road
// that's ROAD_HALF_WIDTH=5.5 units wide each way): plant the pole past the
// curb exactly like city.js's own streetlights do (ROAD_HALF_WIDTH + 0.9),
// so the post stands on the sidewalk corner and only the signal head's arm
// reaches out toward the road, instead of the whole fixture standing in
// the middle of the crossing.
const trafficLights = new TrafficLightSystem(THREE, city.group, city.streetCoords, {
  offset: ROAD_HALF_WIDTH + 0.9,
});

setBootProgress(70, 'Настраиваем погоду…');
const weather = new WeatherSystem(THREE, scene, city, city.groundMat, audio);
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
    bodyStyle: preset.bodyStyle,
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
// Round 6: spectate/follow — a purely client-side camera feature (see
// updateCamera below), no server involvement needed since the admin already
// receives everyone's state updates over the network regardless.
let spectateTargetId = null;

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
  // Round 7: Q cycles the in-car radio (off → 3 stations → off). Skipped
  // while free-flying (cameraMode === 2) since Q/E already control that
  // camera's altitude there (see readInput() below) — overloading the same
  // key would change the radio station every time the player flies down.
  if (e.code === 'KeyQ' && cameraMode !== 2 && !e.repeat) {
    setNetStatus('Радио: ' + radio.cycle());
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
  // Round 6: an admin-muted player used to still see their OWN message
  // appear locally (this function echoes it immediately, before any server
  // round trip) even though the server silently dropped it — so muting
  // looked broken from both sides. Check locally too, not just rely on the
  // server's drop, so the sender gets instant feedback instead of a message
  // that looks sent but nobody else ever saw.
  if (amIMuted) {
    setNetStatus('Вы в муте — сообщение не отправлено');
    return;
  }
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
  net.setCar(newId);
  setPhone(false);
});

// ---------------------------------------------------------------------------
// Admin/debug panel (~ key) — see the state vars + applyAdminStateToCar()
// declared up near where `car` is first built.
//
// Round 6: this used to open straight into the tools with no gate at all,
// and nothing in it had any effect beyond the local browser tab (see
// network.js's history — there was no network message for any of it). It's
// now password-gated — checked server-side in server.js's 'adminLogin'
// handler, so a modified client sending the raw adminKick/adminBan/etc.
// messages without ever passing that check still gets ignored there — and
// the tools include real moderation (kick/ban/mute) and a give-money
// economy that actually reach other players, on top of the pre-existing
// local-only god-mode/turbo/teleport/traffic toggles.
// ---------------------------------------------------------------------------
let adminOpen = false;
let isAdminAuthed = false;
const adminOverlayEl = document.getElementById('adminOverlay');
const adminLoginCardEl = document.getElementById('adminLoginCard');
const adminToolsCardEl = document.getElementById('adminToolsCard');
const adminPasswordInputEl = document.getElementById('adminPasswordInput');
const adminLoginErrorEl = document.getElementById('adminLoginError');
const adminGodEl = document.getElementById('adminGod');
const adminTurboEl = document.getElementById('adminTurbo');
const adminSelfMoneyEl = document.getElementById('adminSelfMoney');
const adminSelfMoneyInputEl = document.getElementById('adminSelfMoneyInput');
const adminPlayerListEl = document.getElementById('adminPlayerList');
const spectateBannerEl = document.getElementById('spectateBanner');
const spectateBannerTextEl = document.getElementById('spectateBannerText');

function setAdmin(v) {
  adminOpen = v;
  adminOverlayEl.style.display = v ? 'flex' : 'none';
  if (!v) return;
  adminGodEl.checked = godMode;
  adminTurboEl.checked = turboMode;
  adminLoginErrorEl.textContent = '';
  if (isAdminAuthed) {
    adminLoginCardEl.style.display = 'none';
    adminToolsCardEl.style.display = 'block';
    adminSelfMoneyEl.textContent = myMoney;
    renderAdminPlayerList();
  } else {
    adminLoginCardEl.style.display = 'block';
    adminToolsCardEl.style.display = 'none';
    adminPasswordInputEl.value = '';
    setTimeout(() => adminPasswordInputEl.focus(), 0);
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

document.getElementById('adminLoginBtn').addEventListener('click', () => {
  const pw = adminPasswordInputEl.value;
  if (!pw) return;
  adminLoginErrorEl.textContent = 'Проверка…';
  net.adminLogin(pw);
});
adminPasswordInputEl.addEventListener('keydown', (e) => {
  if (e.code === 'Enter') document.getElementById('adminLoginBtn').click();
});
document.getElementById('adminLoginCancelBtn').addEventListener('click', () => setAdmin(false));
document.getElementById('adminLogoutBtn').addEventListener('click', () => {
  // "стать обратно обычным игроком" — logging out clears the SERVER-side
  // isAdmin flag (so adminKick/etc. sent from this tab would be ignored
  // from now on even if replayed) AND the local god-mode/turbo cheats;
  // otherwise you'd still be driving an indestructible turbo car with no
  // admin badge, which isn't "a normal player" in anything but name.
  net.adminLogout();
  isAdminAuthed = false;
  godMode = false;
  turboMode = false;
  applyAdminStateToCar();
  stopSpectating();
  setAdmin(false);
  setNetStatus('Вы вышли из админ-режима — снова обычный игрок');
});
document.getElementById('adminSelfMoneyBtn').addEventListener('click', () => {
  const amount = Number(adminSelfMoneyInputEl.value);
  if (!Number.isFinite(amount) || !net.id) return;
  net.adminGiveMoney(net.id, amount);
});

function playerDisplayName(id) {
  return playerNames.get(id) || `Игрок ${id}`;
}

// A "click again to confirm" button instead of a native confirm() dialog —
// confirm()/alert() block the whole tab (including this game's own render
// loop) until dismissed, which is a bad way to gate a ban button in a
// real-time game.
function makeConfirmButton(label, confirmLabel, className, onConfirm) {
  const btn = document.createElement('button');
  if (className) btn.className = className;
  btn.textContent = label;
  let armed = false;
  let armTimer = null;
  btn.addEventListener('click', () => {
    if (!armed) {
      armed = true;
      btn.textContent = confirmLabel;
      clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
        btn.textContent = label;
      }, 3000);
      return;
    }
    armed = false;
    clearTimeout(armTimer);
    btn.textContent = label;
    onConfirm();
  });
  return btn;
}

function renderAdminPlayerList() {
  if (!isAdminAuthed) return;
  adminSelfMoneyEl.textContent = myMoney;
  adminPlayerListEl.innerHTML = '';
  if (remoteCars.size === 0) {
    adminPlayerListEl.innerHTML = '<div class="empty">Пока нет других игроков</div>';
    return;
  }
  for (const id of remoteCars.keys()) {
    const row = document.createElement('div');
    row.className = 'adminPlayerRow';

    const nameRow = document.createElement('div');
    nameRow.className = 'nameRow';
    const nameSpan = document.createElement('span');
    nameSpan.textContent = playerDisplayName(id);
    nameRow.appendChild(nameSpan);
    const version = playerVersions.get(id);
    if (version && version !== GAME_VERSION) {
      const tag = document.createElement('span');
      tag.className = 'tag mismatch';
      tag.textContent = `⚠ ${version}`;
      tag.title = `У вас: ${GAME_VERSION}`;
      nameRow.appendChild(tag);
    }
    if (playerMuted.get(id)) {
      const tag = document.createElement('span');
      tag.className = 'tag muted';
      tag.textContent = '🔇 мут';
      nameRow.appendChild(tag);
    }
    const moneyTag = document.createElement('span');
    moneyTag.className = 'tag';
    moneyTag.textContent = `💰${playerMoney.get(id) ?? 0}`;
    nameRow.appendChild(moneyTag);
    row.appendChild(nameRow);

    const btnRow = document.createElement('div');
    btnRow.className = 'btnRow';

    const kickBtn = document.createElement('button');
    kickBtn.textContent = 'Кик';
    kickBtn.addEventListener('click', () => net.adminKick(id));
    btnRow.appendChild(kickBtn);

    btnRow.appendChild(makeConfirmButton('Бан', 'Точно?', 'danger', () => net.adminBan(id)));

    const muted = !!playerMuted.get(id);
    const muteBtn = document.createElement('button');
    muteBtn.textContent = muted ? 'Размутить' : 'Мут';
    muteBtn.addEventListener('click', () => net.adminMute(id, !muted));
    btnRow.appendChild(muteBtn);

    const spectateBtn = document.createElement('button');
    spectateBtn.textContent = spectateTargetId === id ? '👁 Стоп' : '👁 Следить';
    spectateBtn.addEventListener('click', () => {
      if (spectateTargetId === id) stopSpectating();
      else startSpectating(id);
    });
    btnRow.appendChild(spectateBtn);

    const moneyInput = document.createElement('input');
    moneyInput.type = 'number';
    moneyInput.value = '1000';
    moneyInput.step = '100';
    btnRow.appendChild(moneyInput);

    const giveBtn = document.createElement('button');
    giveBtn.textContent = 'Дать $';
    giveBtn.addEventListener('click', () => {
      const amount = Number(moneyInput.value);
      if (Number.isFinite(amount)) net.adminGiveMoney(id, amount);
    });
    btnRow.appendChild(giveBtn);

    row.appendChild(btnRow);
    adminPlayerListEl.appendChild(row);
  }
}

function startSpectating(id) {
  if (!remoteCars.has(id)) return;
  spectateTargetId = id;
  spectateBannerTextEl.textContent = `👁 Слежка за игроком: ${playerDisplayName(id)}`;
  spectateBannerEl.style.display = 'flex';
  renderAdminPlayerList();
}
function stopSpectating() {
  if (spectateTargetId === null) return;
  spectateTargetId = null;
  spectateBannerEl.style.display = 'none';
  renderAdminPlayerList();
}
document.getElementById('spectateStopBtn').addEventListener('click', stopSpectating);

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
  // steer is just an input-side "which way did the player ask to turn"
  // value (right = +1, left = -1) — the actual sign flip needed to make
  // that produce the correct wheel turn under this project's cannon-es axis
  // convention lives in vehicle.js's update(), verified there by a
  // standalone headless simulation rather than assumed here.
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
// Anti-tunneling safety net (round 3: "убери проезжание сквозь домов" — the
// player could, under the right hit, end up clipped partway or fully into a
// building). cannon-es's collision detection is discrete, not continuous —
// building walls are solid static boxes and normal contacts already stop the
// car almost all of the time (confirmed over many minutes of test driving
// with no clipping), but a fast-enough hit, an odd corner angle, or turbo
// mode can still move the chassis past a wall within a single physics step
// with nothing there to catch it mid-flight.
//
// Rather than chase every possible cause of a rare discrete-collision miss,
// this runs a real overlap test every frame (2D, in the XZ plane — building
// footprints are uniform full-height boxes, so a horizontal check is enough
// PROVIDED the car is actually within that building's height range — see
// the vertical gate below) between the player's actual oriented car
// rectangle and every building footprint, using proper oriented-box vs
// axis-aligned-box separating-axis math rather than a conservative bounding
// circle (which would push the car away from buildings it isn't even
// touching whenever driving past close alongside one). If it finds real
// overlap, it shoves the chassis out along the axis of least penetration
// (capped — see MAX_OVERLAP_CORRECTION) and cancels the velocity component
// driving it further in — the same "never let the impossible state persist"
// idea as the out-of-bounds/NaN check below, just for "inside a wall"
// specifically.
//
// Bugs found and fixed here by this project's own smoke test and by direct
// user reports, not by guessing:
// 1) No vertical gate at all originally — a car launched briefly airborne
//    by a hard collision (exactly what a turbo-mode ram into a wall does)
//    would still register as "inside" any building whose XZ footprint it
//    happened to pass over mid-air, even 50m above the actual rooftop, and
//    get shoved sideways every single frame while airborne — compounding
//    into a runaway multi-hundred-meter teleport within about a second.
//    That's now gated by comparing p.y against the building's own height
//    (footprints carry `h` — see city.js).
// 2) The correction distance used to be capped at 20 (to fully clear even a
//    worst-case deep embedding in one frame). That size cap combined with a
//    now-removed high-speed cutoff (see #3) turned out to be exactly what
//    produced the "sometimes teleports back to the start" reports: a large
//    enough one-frame correction could itself look and feel like a
//    teleport, and occasionally push the chassis into the out-of-bounds/NaN
//    safety net's own territory below. Shrunk to MAX_OVERLAP_CORRECTION — a
//    deep overlap now resolves gently over a couple of frames instead of a
//    single big snap (the standard "max linear correction" pattern real
//    physics engines use, e.g. Box2D's b2_maxLinearCorrection).
// 3) An earlier version of this fix also disabled itself entirely above
//    ~80 km/h "to be safe" — backwards. Tunneling through a wall is
//    specifically a HIGH-speed problem (a fast-enough body can cross an
//    entire thin wall within one physics step); disabling the fix exactly
//    when it was needed left real "I still fly through houses" gameplay
//    unfixed. The turbo-mode exclusion at the call site below is the
//    correct, narrower guard for the actual instability that was found (a
//    deliberate admin-cheat sustained wall ram, not normal fast driving) —
//    there's no separate speed gate here anymore.
const MAX_OVERLAP_CORRECTION = 2.5;

// Reused every call instead of allocated fresh — resolveBuildingOverlap runs
// unconditionally every single frame of normal driving (not just during a
// collision), and this project's own smoke test showed that per-frame
// allocation churn in a hot path like this (a new Euler, plus a new 4-object
// axis array PER NEARBY BUILDING) adds up to real, compounding GC pressure
// on top of an already CPU-tight software-rendered scene — it was one of
// several contributing factors behind a browser hang the smoke test caught
// (see the other fixes/notes on this function).
const _overlapEuler = new THREE.Euler();
// carBody.quaternion is a cannon-es Quaternion, which stores its components
// as plain x/y/z/w fields. THREE.Euler.setFromQuaternion() goes through
// Matrix4.compose(), which reads the quaternion's PRIVATE _x/_y/_z/_w fields
// (the ones its own x/y/z/w getters proxy to) — fields a cannon-es Quaternion
// simply doesn't have. Handing it a cannon quaternion directly makes every
// one of those reads come back `undefined`, so the whole computation silently
// turns into NaN — every single call, not just during a collision. It stays
// invisible the rest of the time because nothing downstream of a NaN yaw
// actually gets used unless a building is close enough to be a real SAT
// candidate, which in practice means "the car is at/inside a building" —
// i.e. exactly the moment of a real collision, which is why this surfaced as
// "the car respawns on any crash". Fix: copy the components into an actual
// THREE.Quaternion (whose .set() does populate the private fields) before
// handing it to the Euler — reused every call for the same GC-pressure
// reasons as _overlapEuler above.
const _overlapQuat = new THREE.Quaternion();

function _axisOverlap(ax, az, halfW, halfL, fx, fz, rx, rz, halfFW, halfFD, dx, dz) {
  const carR = halfW * Math.abs(fx * ax + fz * az) + halfL * Math.abs(rx * ax + rz * az);
  const bR = halfFW * Math.abs(ax) + halfFD * Math.abs(az);
  const centerDist = Math.abs(dx * ax + dz * az);
  return carR + bR - centerDist;
}

function resolveBuildingOverlap(carBody, dims, footprints) {
  const p = carBody.position;
  const halfW = dims.chassisW / 2 + 0.08; // small margin so it settles just outside, not exactly flush
  const halfL = dims.chassisL / 2 + 0.08;
  // Car's world-space forward/right unit vectors in the XZ plane, from yaw
  // only — matches the (sin, cos) convention used everywhere else in this
  // project (city.js/traffic.js) for a body whose quaternion is set via
  // setFromEuler(0, heading, 0).
  const cq = carBody.quaternion;
  _overlapQuat.set(cq.x, cq.y, cq.z, cq.w);
  _overlapEuler.setFromQuaternion(_overlapQuat, 'YXZ');
  const yaw = _overlapEuler.y;
  const fx = Math.sin(yaw), fz = Math.cos(yaw); // car local +Z (nose) in world XZ
  const rx = Math.cos(yaw), rz = -Math.sin(yaw); // car local +X (right) in world XZ
  const boundingR = Math.hypot(halfW, halfL); // cheap coarse reject before the exact SAT check below

  for (const f of footprints) {
    // Vertical gate (see fix #1 above): only a building this car's vertical
    // position could plausibly be inside at all is a candidate — a car
    // flying well above the roofline, or somehow below ground, can't be
    // "inside" this building's walls no matter what its XZ position says.
    if (p.y > f.h + 1.5 || p.y < -1.5) continue;

    const dx = p.x - f.x, dz = p.z - f.z;
    const coarseR = boundingR + Math.hypot(f.w / 2, f.d / 2);
    if (dx * dx + dz * dz > coarseR * coarseR) continue;

    const halfFW = f.w / 2, halfFD = f.d / 2;
    // Separating-axis test over the 4 candidate axes for an OBB (car) vs
    // AABB (building) pair in 2D: the AABB's own two axes (world X/Z) plus
    // the OBB's two axes (the car's forward/right). Track whichever axis
    // has the SMALLEST positive overlap — that's the minimum-translation
    // axis to push the car out along. Axes are checked inline (not via an
    // array of them) to avoid allocating one every building every frame —
    // see the note above _axisOverlap().
    let minOverlap = Infinity, minAx = 0, minAz = 0, sepFound = false;
    let overlap = _axisOverlap(1, 0, halfW, halfL, fx, fz, rx, rz, halfFW, halfFD, dx, dz);
    if (overlap <= 0) { sepFound = true; }
    else { minOverlap = overlap; minAx = 1; minAz = 0; }

    if (!sepFound) {
      overlap = _axisOverlap(0, 1, halfW, halfL, fx, fz, rx, rz, halfFW, halfFD, dx, dz);
      if (overlap <= 0) sepFound = true;
      else if (overlap < minOverlap) { minOverlap = overlap; minAx = 0; minAz = 1; }
    }
    if (!sepFound) {
      overlap = _axisOverlap(fx, fz, halfW, halfL, fx, fz, rx, rz, halfFW, halfFD, dx, dz);
      if (overlap <= 0) sepFound = true;
      else if (overlap < minOverlap) { minOverlap = overlap; minAx = fx; minAz = fz; }
    }
    if (!sepFound) {
      overlap = _axisOverlap(rx, rz, halfW, halfL, fx, fz, rx, rz, halfFW, halfFD, dx, dz);
      if (overlap <= 0) sepFound = true;
      else if (overlap < minOverlap) { minOverlap = overlap; minAx = rx; minAz = rz; }
    }
    if (sepFound) continue;

    // Push out along the minimum-penetration axis, oriented away from the
    // building's center, and kill the velocity component still driving the
    // chassis further into it (otherwise it just re-penetrates next step).
    // Correction is capped (see fix #2 above) — a deep overlap resolves
    // gradually over a few frames rather than in one potentially-large jump.
    const correction = Math.min(minOverlap, MAX_OVERLAP_CORRECTION);
    const sign = (dx * minAx + dz * minAz) >= 0 ? 1 : -1;
    p.x += minAx * correction * sign;
    p.z += minAz * correction * sign;
    const v = carBody.velocity;
    const vDotN = v.x * minAx * sign + v.z * minAz * sign;
    if (vDotN < 0) {
      v.x -= vDotN * minAx * sign;
      v.z -= vDotN * minAz * sign;
    }
  }
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
// Round 6: version sync + economy/moderation state, all mirroring the exact
// id-keyed Map pattern playerNames already used.
const playerVersions = new Map(); // id -> version string
const playerMoney = new Map();    // id -> money (other players)
const playerMuted = new Map();    // id -> bool
let myName = '';
let myMoney = 0;
let amIMuted = false;

const net = new Network({
  onWelcome(msg) {
    myColor = msg.color;
    rebuildCarColor();
    for (const p of msg.players) {
      spawnRemote(p.id, p.color, p.carId, p.state);
      if (p.name) playerNames.set(p.id, p.name);
      if (p.version) playerVersions.set(p.id, p.version);
      if (typeof p.money === 'number') playerMoney.set(p.id, p.money);
      if (p.muted) playerMuted.set(p.id, true);
    }
    // Catch up on world destruction that happened before we joined.
    for (const id of msg.shatteredIds || []) destructibles.applyRemoteShatter(id);
    for (const r of msg.propRest || []) destructibles.applyRemoteRest(r.id, r.p, r.q);
    refreshPlayerList();
    renderAdminPlayerList();
    setNetStatus(`В сети: вы + ${msg.players.length}`);
  },
  onJoin(msg) {
    // carId isn't known yet at bare join — same reason `name` starts blank:
    // the client sends its setCar/setName right after connecting, which
    // hasn't arrived here yet. spawnRemote falls back to 'sedan' until the
    // 'car' message below arrives and (if needed) rebuilds it.
    spawnRemote(msg.id, msg.color, null, null);
    refreshPlayerList();
    renderAdminPlayerList();
  },
  onLeave(msg) {
    const rc = remoteCars.get(msg.id);
    if (rc) {
      rc.dispose(scene);
      remoteCars.delete(msg.id);
    }
    playerNames.delete(msg.id);
    playerVersions.delete(msg.id);
    playerMoney.delete(msg.id);
    playerMuted.delete(msg.id);
    if (spectateTargetId === msg.id) stopSpectating();
    refreshPlayerList();
    renderAdminPlayerList();
  },
  onState(msg) {
    const rc = remoteCars.get(msg.id);
    if (rc) rc.setTarget(msg.state);
  },
  onName(msg) {
    playerNames.set(msg.id, msg.name);
    refreshPlayerList();
    renderAdminPlayerList();
  },
  // Round 6: version sync — lets two players actually SEE a build mismatch
  // (highlighted in both the online players list and the admin panel)
  // instead of guessing from symptoms like "your car looks different".
  onVersion(msg) {
    playerVersions.set(msg.id, msg.version);
    refreshPlayerList();
    renderAdminPlayerList();
  },
  onMoney(msg) {
    if (msg.id === net.id) {
      myMoney = msg.money;
      if (isAdminAuthed) adminSelfMoneyEl.textContent = myMoney;
      setNetStatus(`💰 Баланс: ${myMoney}`);
    } else {
      playerMoney.set(msg.id, msg.money);
    }
    refreshPlayerList();
    renderAdminPlayerList();
  },
  onAdminAuth(msg) {
    if (msg.ok) {
      isAdminAuthed = !!msg.isAdmin;
      if (isAdminAuthed) {
        adminLoginCardEl.style.display = 'none';
        adminToolsCardEl.style.display = 'block';
        adminSelfMoneyEl.textContent = myMoney;
        renderAdminPlayerList();
        setNetStatus('Админ-доступ подтверждён');
      }
    } else {
      adminLoginErrorEl.textContent = 'Неверный пароль';
    }
  },
  // Server-authoritative moderation events — some are about ME (kicked,
  // banned, or my own chat getting dropped for being muted), others are
  // acks sent back only to the admin who performed an action on someone
  // else (see server.js's adminKick/adminBan/adminMute handlers).
  onModeration(msg) {
    switch (msg.action) {
      case 'kicked':
        setNetStatus('Администратор кикнул вас с сервера');
        break;
      case 'banned':
        setNetStatus('Вы забанены на этом сервере');
        net.disconnect(); // don't let the normal reconnect loop just retry into the same ban
        break;
      case 'muteBlocked':
        setNetStatus('Вы в муте — сообщение не отправлено');
        break;
      case 'kickedPlayer':
        setNetStatus(`Кикнут: ${msg.name || playerDisplayName(msg.targetId)}`);
        break;
      case 'bannedPlayer':
        setNetStatus(`Забанен: ${msg.name || playerDisplayName(msg.targetId)}`);
        break;
      case 'mutedPlayer':
        playerMuted.set(msg.targetId, true);
        setNetStatus(`Замучен: ${msg.name || playerDisplayName(msg.targetId)}`);
        refreshPlayerList();
        renderAdminPlayerList();
        break;
      case 'unmutedPlayer':
        playerMuted.set(msg.targetId, false);
        setNetStatus(`Размучен: ${msg.name || playerDisplayName(msg.targetId)}`);
        refreshPlayerList();
        renderAdminPlayerList();
        break;
    }
  },
  onMuted(msg) {
    amIMuted = !!msg.muted;
    setNetStatus(amIMuted ? 'Администратор вас замутил' : 'С вас снят мут');
    refreshPlayerList();
  },
  onCar(msg) {
    // A connected player switched cars mid-session (the settings panel
    // rebuilds the LOCAL car immediately — see applyCarBtn's click handler
    // below — this is the same thing happening for a REMOTE one). The body
    // shape is baked into the mesh at construction time, so the only way to
    // reflect a style change is to rebuild the RemoteCar — carrying its
    // interpolation buffer over so it doesn't visibly snap or vanish for a
    // frame while the new mesh is unbuffered.
    const rc = remoteCars.get(msg.id);
    if (!rc) return;
    const preset = CAR_PRESETS[msg.carId] || CAR_PRESETS.sedan;
    if (rc.bodyStyle === preset.bodyStyle) return; // e.g. sedan -> sport: same generic body, nothing to rebuild
    const { buffer, color } = rc;
    rc.dispose(scene);
    const newRc = new RemoteCar(THREE, scene, color, preset.bodyStyle);
    newRc.buffer = buffer;
    remoteCars.set(msg.id, newRc);
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
  // BUG FIX (round 6 — "chat doesn't work"): Network already parses and
  // dispatches incoming 'chat' messages via onChat (see network.js), but
  // nothing here was ever wired up to receive them — so every OTHER
  // player's message was silently dropped on arrival. Each player only ever
  // saw their own messages (added locally by sendChatText's immediate
  // echo), which reads exactly like "chat doesn't work" from either side.
  onChat(msg) {
    addChatMessage(msg);
  },
  onConnectionChange(connected) {
    setNetStatus(connected ? 'Соединение установлено' : 'Соединение потеряно — переподключаемся…');
  },
  onPing(rttMs) {
    const el = document.getElementById('ping');
    if (el) el.textContent = `${Math.round(rttMs)} мс`;
  },
});

function spawnRemote(id, color, carId, state) {
  if (remoteCars.has(id)) return;
  const preset = CAR_PRESETS[carId] || CAR_PRESETS.sedan;
  const rc = new RemoteCar(THREE, scene, color, preset.bodyStyle);
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
  const meMoney = document.createElement('span');
  meMoney.className = 'money';
  meMoney.textContent = `💰${myMoney}`;
  meRow.appendChild(meMoney);
  if (amIMuted) {
    const meMuteTag = document.createElement('span');
    meMuteTag.className = 'tag muted';
    meMuteTag.textContent = '🔇';
    meRow.appendChild(meMuteTag);
  }
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
    // Round 6: version mismatch is the whole point of tracking this at all
    // — a highlighted tag means "this player is NOT on the same build as
    // you", answering "how do I tell which version he has" directly in the
    // players list instead of comparing screenshots.
    const version = playerVersions.get(id);
    if (version) {
      const verTag = document.createElement('span');
      const mismatch = version !== GAME_VERSION;
      verTag.className = 'ver' + (mismatch ? ' mismatch' : '');
      verTag.textContent = mismatch ? `⚠${version}` : version;
      verTag.title = mismatch ? `Другая версия! У вас: ${GAME_VERSION}` : 'Та же версия, что у вас';
      row.appendChild(verTag);
    }
    const moneyTag = document.createElement('span');
    moneyTag.className = 'money';
    moneyTag.textContent = `💰${playerMoney.get(id) ?? 0}`;
    row.appendChild(moneyTag);
    if (playerMuted.get(id)) {
      const muteTag = document.createElement('span');
      muteTag.className = 'tag muted';
      muteTag.textContent = '🔇';
      row.appendChild(muteTag);
    }
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
  // Round 7 ("зависает на 10 сек без индикатора"): the click used to go
  // straight into a real, unavoidable hitch — rebuilding the vehicle and,
  // above all, the browser's FIRST-EVER shader compile + texture upload for
  // every material in the whole city (WebGL only ever does that lazily, on
  // first use) — with nothing on screen the whole time, which reads as a
  // crash rather than "still loading". Show the loading screen FIRST.
  const carLoadingEl = document.getElementById('carLoading');
  carLoadingEl.style.display = 'flex';

  // A nested double rAF forces the browser to actually PAINT that overlay
  // before any of the heavy synchronous work below runs — without this the
  // display:flex above and the blocking work below would just get batched
  // into the same frame and the loading screen would never actually appear
  // (the freeze would look identical to before, just with an invisible div
  // technically already "shown").
  requestAnimationFrame(() => requestAnimationFrame(() => {
    audio.resume(); // user gesture — required before Web Audio can produce sound
    net.setName(myName);
    net.setCar(selectedCarId);
    net.setVersion(GAME_VERSION);
    net.connect();
    // The car built during boot used whatever model was saved from last
    // time; rebuild it now against whatever the player actually picked
    // just above.
    settings.carModel = selectedCarId;
    saveSettings(settings);
    car.dispose(scene);
    car = buildVehicleAt(spawn, selectedCarId);
    car.setHeadlightsOn(headlightsOn);
    applyAdminStateToCar();
    // Pre-compile every material/shader in the scene right here, still
    // under the loading screen — this is what actually eats the several
    // seconds (hundreds of unique building facade materials, each compiled
    // once on first use). Doing it explicitly, in one place, means the
    // very first frame of real gameplay right after is already fast
    // instead of hitching on whatever happened to be the first thing drawn.
    renderer.compile(scene, camera);

    carLoadingEl.style.display = 'none';
    document.getElementById('hud').style.display = 'block';
    renderer.domElement.style.display = 'block';
    lastTime = performance.now();
    requestAnimationFrame(loop);
  }));
});

// ---------------------------------------------------------------------------
// Camera follow
// ---------------------------------------------------------------------------
const camOffset = new THREE.Vector3();
const camTarget = new THREE.Vector3();
function updateCamera(dt) {
  // Round 6: admin spectate/follow — when watching another player, chase
  // THEIR car's group instead of our own. Driving input still controls our
  // own car underneath (this only redirects where the camera looks), and
  // falls back to our own car automatically if the spectated player leaves
  // (see onLeave/stopSpectating below).
  const targetGroup = spectateTargetId && remoteCars.has(spectateTargetId) ? remoteCars.get(spectateTargetId).group : car.group;
  const back = cameraMode === 0 ? 8.5 : 4.5;
  const up = cameraMode === 0 ? 3.6 : 2.0;
  const forward = new THREE.Vector3(0, 0, 1).applyQuaternion(targetGroup.quaternion);
  // Camera sits BEHIND the car (opposite the forward/headlight direction) and
  // looks at a point AHEAD of it. This was inverted before — the camera sat
  // in front of the car looking at a point behind it, so driving forward
  // moved the car toward the camera tail-first, reading as "driving in
  // reverse" even though the physics/input direction was always correct.
  camOffset.copy(targetGroup.position).addScaledVector(forward, -back);
  camOffset.y += up;
  camera.position.lerp(camOffset, 1 - Math.pow(0.001, dt));
  camTarget.copy(targetGroup.position).addScaledVector(forward, 6);
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
  // Skipped in turbo mode: that's an admin/cheat feature that deliberately
  // multiplies engine force well past anything a normal drive produces, and
  // this project's own smoke test caught it fighting this correction into
  // an unstable state when used to ram a wall on purpose (see
  // resolveBuildingOverlap's own comment for the bugs already fixed there).
  // The anti-tunneling fix this exists for — a normal drive clipping into a
  // building, at any normal driving speed — doesn't involve turbo mode at all.
  if (!turboMode) resolveBuildingOverlap(car.chassisBody, car.dims, city.footprints);

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

  // Round 7 ("сделай в 10 раз летальнее машини" — a hard enough crash now
  // actually totals the car, see vehicle.js's _explode()/DESTROY_DAMAGE):
  // same polling pattern as the out-of-bounds check just above, just keyed
  // off car.destroyed instead. A short beat (not an instant swap) so the
  // explosion effect/sound actually gets seen before the wreck is pulled
  // off the road.
  if (car.destroyed && performance.now() / 1000 - car.destroyedAt > 2.2) {
    respawnCar();
    setNetStatus('Машина уничтожена — респавн');
  }

  destructibles.update(dt);
  effects.update(dt);
  trafficLights.update(dt);
  traffic.update(dt, getTrafficObstacles(), trafficLights);
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
