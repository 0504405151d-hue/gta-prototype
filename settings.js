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
};

export const TRAFFIC_COUNTS = { off: 0, low: 8, medium: 16, high: 28 };

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
