// Player settings: persisted in localStorage (this is a real page the player
// opens in their own browser across sessions — not an in-conversation
// preview — so browser storage is the right tool here, unlike an artifact).

export const DEFAULT_SETTINGS = {
  volume: 1,           // 0..1 master volume multiplier
  graphics: 'high',    // 'low' | 'medium' | 'high' — shadow map size + fog draw distance + pixel ratio cap
  traffic: 'medium',   // 'off' | 'low' | 'medium' | 'high'
  weather: 'clear',    // 'clear' | 'cloudy' | 'rain' | 'night'
  sensitivity: 1,      // free-cam mouse-look sensitivity multiplier
  minimap: true,
  carModel: 'sedan',   // 'sedan' | 'sport' | 'suv'
  carColorIndex: 0,
  suspension: 'standard', // 'soft' | 'standard' | 'stiff' — see SUSPENSION_PRESETS below
};

export const TRAFFIC_COUNTS = { off: 0, low: 8, medium: 16, high: 28 };

// In-game suspension softness picker ("сделай возможность прямо в игре
// мягкость подвески выбрать"): 'standard' is exactly the softened tune from
// the previous round's "сделай мягче подвеску" fix (kept as the default so
// nobody's ride quietly changes under them just because this setting shipped),
// 'stiff' restores the original, firmer pre-that-fix numbers for players who
// want the sportier feel back, and 'soft' goes further in the same direction
// for a plush, floaty ride. Applied to a RaycastVehicle's wheelInfos directly
// (see Vehicle.setSuspension in vehicle.js) — these are read fresh every
// physics step, so switching presets takes effect instantly, no respawn
// needed, unlike carModel above.
export const SUSPENSION_PRESETS = {
  stiff: { suspensionStiffness: 28, suspensionRestLength: 0.36, dampingRelaxation: 3.2, dampingCompression: 4.3, maxSuspensionTravel: 0.28 },
  standard: { suspensionStiffness: 19, suspensionRestLength: 0.42, dampingRelaxation: 2.6, dampingCompression: 3.5, maxSuspensionTravel: 0.36 },
  soft: { suspensionStiffness: 13, suspensionRestLength: 0.5, dampingRelaxation: 2.0, dampingCompression: 2.7, maxSuspensionTravel: 0.44 },
};

const STORAGE_KEY = 'cityDriveSettings';

export function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // localStorage can throw in private-browsing/quota-exceeded situations —
    // settings just won't persist across reloads, nothing else breaks.
  }
}
