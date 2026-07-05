import * as THREE from 'three';

// Faithful port of the ARACHNID reference math layer (proven robust).
export const V3 = (x, y, z) => new THREE.Vector3(x, y, z);
export const Q = () => new THREE.Quaternion();
export const Y_UP = V3(0, 1, 0);
export const DOWN = V3(0, -1, 0);
export const TAU = Math.PI * 2;

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const frac = (v) => v - Math.floor(v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = (t) => t * t * (3 - 2 * t);
export const wrapPi = (a) => { while (a > Math.PI) a -= TAU; while (a < -Math.PI) a += TAU; return a; };

export function signedAngle(a, b, axis) {
  const c = clamp(a.dot(b), -1, 1);
  let ang = Math.acos(c);
  if (a.clone().cross(b).dot(axis) < 0) ang = -ang;
  return ang;
}

/** Second-order spring (t3ssel8r): f frequency, z damping, r response. Semi-implicit Euler + dt guard. */
export class SO1 {
  constructor(f, z, r, x0) {
    const w = TAU * f;
    this.k1 = z / (Math.PI * f);
    this.k2 = 1 / (w * w);
    this.k3 = (r * z) / w;
    this.xp = x0; this.y = x0; this.yd = 0;
  }
  step(dt, x) {
    const xd = (x - this.xp) / Math.max(dt, 1e-5);
    this.xp = x;
    const k2 = Math.max(this.k2, dt * dt * 0.5 + dt * this.k1 * 0.5, dt * this.k1);
    this.y += dt * this.yd;
    this.yd += (dt * (x + this.k3 * xd - this.y - this.k1 * this.yd)) / k2;
    return this.y;
  }
}

/** Analytic two-bone IK — returns the knee position bending toward poleDir. */
const _t = V3(), _d = V3(), _bend = V3();
export function twoBoneKnee(root, target, l1, l2, poleDir, out) {
  _t.subVectors(target, root);
  const dist = clamp(_t.length(), 1e-3, l1 + l2 - 1e-3);
  _d.copy(_t).normalize();
  _bend.copy(poleDir).addScaledVector(_d, -poleDir.dot(_d));
  if (_bend.lengthSq() < 1e-6) _bend.set(0, 1, 0).addScaledVector(_d, -_d.y);
  _bend.normalize();
  const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  out.copy(root).addScaledVector(_d, Math.cos(a) * l1).addScaledVector(_bend, Math.sin(a) * l1);
  return out;
}

/**
 * Decomposed two-bone IK (after Kiaran Ritchie, 2026).
 * Instead of solving the whole chain at once, split it into two simpler sub-problems:
 *
 *   (1) CHAIN LENGTH  — pose the bent chain in a *canonical frame* (the limb's REST direction)
 *                       so that |root → end| equals |root → target|. This is a 1-DOF solve: the
 *                       same cosine-law bend angle, but decoupled from where the target is.
 *   (2) CHAIN DIRECTION — aim the whole posed chain at the target with ONE rotation about the
 *                       BASE joint (root): delta = fromTo(canonicalAxis, targetDir), then FK.
 *
 * Because the aiming happens at the base — like a real hip/shoulder socket — most of the motion
 * comes from the root and the elbow/knee bend is "carried" by the aim rather than recomputed in the
 * target plane every frame. The end-effector still lands exactly on the target, so it's a drop-in
 * swap for `twoBoneKnee`; only the *character* of the bend changes (base-driven, more natural).
 * `restAxis` = the limb's neutral chain direction in world space (falls back to the aim direction).
 */
const _dt2 = V3(), _dir2 = V3(), _a0 = V3(), _b0 = V3(), _kn0 = V3();
const _qd = new THREE.Quaternion();
export function twoBoneKneeDecomposed(root, target, l1, l2, poleDir, restAxis, out) {
  _dt2.subVectors(target, root);
  const dist = clamp(_dt2.length(), 1e-3, l1 + l2 - 1e-3);
  _dir2.copy(_dt2).normalize();                                   // final aim direction
  _a0.copy(restAxis);                                             // canonical chain axis (rest pose)
  if (_a0.lengthSq() < 1e-8) _a0.copy(_dir2); else _a0.normalize();
  _b0.copy(poleDir).addScaledVector(_a0, -poleDir.dot(_a0));      // bend ⟂ canonical axis
  if (_b0.lengthSq() < 1e-6) { _b0.set(0, 1, 0).addScaledVector(_a0, -_a0.y); if (_b0.lengthSq() < 1e-6) _b0.set(1, 0, 0); }
  _b0.normalize();
  // (1) chain LENGTH: cosine-law bend so |root→ankle| == dist, posed along the canonical axis
  const a = Math.acos(clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  _kn0.copy(root).addScaledVector(_a0, Math.cos(a) * l1).addScaledVector(_b0, Math.sin(a) * l1);
  // (2) chain DIRECTION: aim the posed chain at the target by rotating about the base joint
  _qd.setFromUnitVectors(_a0, _dir2);
  out.copy(_kn0).sub(root).applyQuaternion(_qd).add(root);
  return out;
}

/** orient a unit cylinder (Y-aligned) to span a->b with the given radius */
const _ov = V3();
export function orientCyl(mesh, a, b, radius) {
  _ov.subVectors(b, a);
  const len = _ov.length() || 1e-3;
  mesh.position.copy(a).add(b).multiplyScalar(0.5);
  mesh.scale.set(radius, len, radius);
  mesh.quaternion.setFromUnitVectors(Y_UP, _ov.normalize());
}
