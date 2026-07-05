import { V3, clamp01 } from '../core/dynamics.js';

// Analytic terrain (faithful port). A closed-form height function: smooth, exact
// normals, cheap to sample anywhere — the key to robust foot/body placement.
// WORLD_SCALE blows the whole world up uniformly (same shapes/slopes, bigger) so
// it reads at the right scale relative to the (unchanged) spider.
export const WORLD_SCALE = 2;
export const FIELD = 130 * WORLD_SCALE;

function fbm(x, z) {
  let h = 0, a = 1, f = 0.06, s = 0;
  for (let o = 0; o < 5; o++) { h += a * Math.sin(x * f + o * 1.3) * Math.cos(z * f * 1.07 + o * 2.1); s += a; a *= 0.5; f *= 2; }
  return h / s;
}
function ridge(x, z) { const r = 1 - Math.abs(Math.sin(x * 0.07) * Math.cos(z * 0.066)); return r * r; }

const FEATURES = [
  { x: 30, z: -26, amp: 10, r: 10 }, { x: -34, z: 20, amp: 8, r: 9 }, { x: -14, z: -40, amp: 6, r: 7 },
  { x: 40, z: 34, amp: 7, r: 8 }, { x: -30, z: -12, amp: -5, r: 6 }, { x: 20, z: 14, amp: -4, r: 5 },
];

// Optional override (used by the test harness for flat/ramp arenas; null in-game).
let _override = null;
export function setTerrainOverride(fn) { _override = fn; }
export function clearTerrainOverride() { _override = null; }

function baseH(x, z) {
  const wx = x + 6 * Math.sin(z * 0.05 + 1), wz = z + 6 * Math.cos(x * 0.045 + 2);
  let h = 6.0 * fbm(wx * 0.5, wz * 0.5) + 2.3 * fbm(wx * 1.3 + 10, wz * 1.3 + 10) + 3.4 * ridge(wx * 0.5, wz * 0.5);
  for (const f of FEATURES) { const d2 = (x - f.x) * (x - f.x) + (z - f.z) * (z - f.z); h += f.amp * Math.exp(-d2 / (2 * f.r * f.r)); }
  const dc = Math.hypot(x, z), flat = clamp01((dc - 8) / 12);
  return h * (0.2 + 0.8 * flat);
}

export function terrainH(x, z) {
  if (_override) return _override(x, z);
  // uniform 2x world: sample the base shape at half coords, scale the height up — same slopes, bigger.
  return WORLD_SCALE * baseH(x / WORLD_SCALE, z / WORLD_SCALE);
}

export function terrainN(x, z) {
  const e = 0.4, hx = terrainH(x + e, z) - terrainH(x - e, z), hz = terrainH(x, z + e) - terrainH(x, z - e);
  return V3(-hx / (2 * e), 1, -hz / (2 * e)).normalize();
}
