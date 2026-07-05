import * as THREE from 'three';
import {
  V3, Q, Y_UP, DOWN, TAU, clamp, clamp01, frac, lerp, smooth, wrapPi, signedAngle,
  twoBoneKnee, twoBoneKneeDecomposed, orientCyl,
} from '../core/dynamics.js';
import { FIELD, terrainH, terrainN } from '../world/terrain.js';
import { colliders, castAll, clearance, occluded } from '../world/collision.js';

// live-tunable knee-swivel search (exposed to the tuning panel).
// `decomposed` selects the decomposed length-then-aim IK solver (Kiaran Ritchie) — DEFAULT in the game
// for more natural, base-driven leg bends. Set to false here to fall back to the classic analytic solver.
export const TUNE = { aRange: 3.14, aSamp: 8, decomposed: true };

// active IK solver: decomposed (default) or analytic two-bone. Same end-effector, different bend
// character. Switch the default via TUNE.decomposed above.
function ikKnee(root, target, l1, l2, pole, restAxis, out) {
  return TUNE.decomposed
    ? twoBoneKneeDecomposed(root, target, l1, l2, pole, restAxis, out)
    : twoBoneKnee(root, target, l1, l2, pole, out);
}

const GEO = { cyl: new THREE.CylinderGeometry(1, 1, 1, 8), joint: new THREE.SphereGeometry(1, 10, 8) };
function limbMat(c, e) { return new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.25, emissive: e || c, emissiveIntensity: e ? 0.5 : 0.08 }); }

const _t = V3(), _sp = V3(), _depP = V3(), _kUp = V3(0, 1, 0);
// abdomen-articulation scratch
const _wUp = V3(), _lUp = V3(), _abAhead = V3();
const _qT = new THREE.Quaternion(), _qDroop = new THREE.Quaternion(), _qI = new THREE.Quaternion(), _qInv = new THREE.Quaternion(), _qYaw = new THREE.Quaternion();
const _XAX = V3(1, 0, 0), _YAX = V3(0, 1, 0);
function segPen(a, b, nearC, rad) {
  let pen = 0;
  for (let s = 0; s <= 5; s++) { _sp.copy(a).lerp(b, s * 0.2); for (const c of nearC) { const cl = clearance(_sp, c); const dd = rad - cl.d; if (dd > pen) pen = dd; } }
  return pen;
}

/* ---- verlet antennae (whisker feelers) ---- */
const _vt = V3();
class Verlet {
  constructor(scene, anchor, localOff, n, seg, stiffDir, grav, color, rad) {
    this.anchor = anchor; this.localOff = localOff.clone(); this.n = n; this.seg = seg; this.stiff = stiffDir.clone(); this.grav = grav; this.rad = rad;
    this.pts = []; this.prev = []; const base = anchor.localToWorld(localOff.clone());
    for (let i = 0; i < n; i++) { const p = base.clone().addScaledVector(stiffDir, seg * i); this.pts.push(p); this.prev.push(p.clone()); }
    this.seg_m = []; const M = limbMat(color, color);
    for (let i = 0; i < n - 1; i++) { const c = new THREE.Mesh(GEO.cyl, M); c.castShadow = true; scene.add(c); this.seg_m.push(c); }
  }
  step(dt) {
    this.anchor.updateMatrixWorld(); const head = this.anchor.localToWorld(this.localOff.clone()); this.pts[0].copy(head); this.prev[0].copy(head);
    const sw = this.stiff.clone().applyQuaternion(this.anchor.quaternion).normalize(); const g = this.grav * dt * dt;
    for (let i = 1; i < this.n; i++) {
      const p = this.pts[i], pr = this.prev[i]; const vx = (p.x - pr.x) * 0.9, vy = (p.y - pr.y) * 0.9, vz = (p.z - pr.z) * 0.9; pr.copy(p); p.x += vx; p.y += vy - g; p.z += vz;
      const par = this.pts[i - 1]; p.x += (par.x + sw.x * this.seg - p.x) * 0.2; p.y += (par.y + sw.y * this.seg - p.y) * 0.2; p.z += (par.z + sw.z * this.seg - p.z) * 0.2;
    }
    for (let k = 0; k < 3; k++) for (let i = 1; i < this.n; i++) { const a = this.pts[i - 1], b = this.pts[i]; _vt.subVectors(b, a); const d = _vt.length() || 1e-3; _vt.multiplyScalar((d - this.seg) / d * 0.5); if (i > 1) a.add(_vt); b.sub(_vt); }
    for (let i = 0; i < this.n - 1; i++) orientCyl(this.seg_m[i], this.pts[i], this.pts[i + 1], this.rad);
  }
}

/* ============================================================
   SPIDER — feet-driven body + analytic IK legs (faithful port)
   ============================================================ */
export class Spider {
  constructor(scene, world) {
    this.scene = scene; this.world = world;
    this.baseSpeed = 6.0; this.sprintMul = 1.85; this.turnRate = 1.9;
    this.femur = 2.05; this.tibia = 2.05; this.legReach = 4.1; this.tarsus = 0.42; this.legRad = 0.155;
    this.rideClear = 3.0; this.minClear = 1.6; this.baseFreq = 1.55; this.duty = 0.7; this.stepH = 0.65; this.stepThresh = 0.85;
    this.maxStride = 2.7; this.bodyR = 1.6; this.minFoot = 1.1;
    this.up = Y_UP.clone(); this.fwd = V3(0, 0, 1); this.right = V3(1, 0, 0); this.heading = 0; this.moveDir = V3(0, 0, 1);
    this.curSpeed = 0; this.activity = 0; this.gaitPhase = 0;
    // --- game hooks (additive; grounded locomotion is unchanged when airborne=false) ---
    this.airborne = false; this.vel = V3(); this.tether = null; this.fill = 0.5; this.legsLost = 0;
    this.bodyConform = true;   // ride/tilt to the planted-feet support plane (vs a single center sample)
    this.conformLift = false;  // raise the ride target toward the feet: OFF — it over-raises on wall crests
                               // and floats the body on dismount. Body height = down-cast + anticipation.
    this.conformTiltW = 0.5;   // how strongly the body tilt follows the feet support plane
    // articulated abdomen (waist bend) — the spider folds at the pedicel instead of being rigid
    this.bodyFlex = true;      // enable the abdomen articulation
    this.abHang = 0.55;        // how much the abdomen hangs toward world-up vs the cephalothorax (wall fold)
    this.abDroop = 0.14;       // constant rear-down sag of the heavy abdomen (rad)
    this.abMax = 0.8;          // max waist bend (rad, ~46°) — anatomical clamp
    this.pos = V3(0, terrainH(0, 0), 0); this.bodyOrigin = V3(0, terrainH(0, 0) + this.rideClear, 0); this.quat = Q();
    this.root = new THREE.Group(); scene.add(this.root);
    this.buildBody(); this.buildLegs();
    this.antennae = [
      new Verlet(scene, this.root, V3(-0.3, 0.34, 1.25), 5, 0.34, V3(-0.25, 0.5, 0.9), 5.0, 0x22d3ee, 0.045),
      new Verlet(scene, this.root, V3(0.3, 0.34, 1.25), 5, 0.34, V3(0.25, 0.5, 0.9), 5.0, 0x22d3ee, 0.045),
    ];
    this.reset();
  }

  partOn(parent, geo, mat, x, y, z, sx, sy, sz) { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); if (sx !== undefined) m.scale.set(sx, sy, sz); m.castShadow = true; parent.add(m); return m; }
  part(geo, mat, x, y, z, sx, sy, sz) { return this.partOn(this.root, geo, mat, x, y, z, sx, sy, sz); }

  buildBody() {
    const shell = limbMat(0x1f4250), shellDk = limbMat(0x142a33), accent = limbMat(0x22d3ee, 0x22d3ee);
    // The body is TWO articulated segments joined at a pedicel (waist): the CEPHALOTHORAX (front,
    // rigid with the locomotion root — it carries the legs, head, eyes, fangs) and the ABDOMEN (rear,
    // the big ellipsoid), parented under a pivot Group so it BENDS at the waist. So the spider folds
    // like a real spider — abdomen hanging on a wall, drooping over a crest — not a rigid blob.
    this.PEDICEL = V3(0, 0.02, -0.85);                    // waist pivot (local, just ahead of the abdomen)
    this.abdomen = new THREE.Group(); this.abdomen.position.copy(this.PEDICEL); this.root.add(this.abdomen);
    this._abQ = new THREE.Quaternion();                   // spring-smoothed bend state (local to root)
    // --- cephalothorax (front) — rigid under root ---
    this.part(GEO.joint, shell, 0, 0, 0.15, 1.05, 0.72, 1.25);              // carapace
    this.part(GEO.joint, shell, 0, 0.05, -0.7, 0.55, 0.5, 0.7);             // pedicel hump (front of the waist)
    this.part(GEO.joint, limbMat(0x265562), 0, 0.18, 1.0, 0.62, 0.5, 0.55); // head bump
    const eye = limbMat(0xff3bd4, 0xff3bd4);
    for (const e of [[-0.26, 0.32, 1.32, 0.12], [0.26, 0.32, 1.32, 0.12], [-0.13, 0.42, 1.36, 0.09], [0.13, 0.42, 1.36, 0.09], [-0.32, 0.2, 1.28, 0.08], [0.32, 0.2, 1.28, 0.08]]) this.part(GEO.joint, eye, e[0], e[1], e[2], e[3], e[3], e[3]);
    const fang = limbMat(0x0f1c24);
    const f1 = this.part(new THREE.ConeGeometry(0.12, 0.6, 6), fang, -0.16, -0.05, 1.5); f1.rotation.x = 2.5;
    const f2 = this.part(new THREE.ConeGeometry(0.12, 0.6, 6), fang, 0.16, -0.05, 1.5); f2.rotation.x = 2.5;
    // --- abdomen (rear) — under the pedicel pivot so it bends (positions are pivot-relative) ---
    const py = this.PEDICEL.y, pz = this.PEDICEL.z;
    this.body = this.partOn(this.abdomen, GEO.joint, shellDk, 0, -0.02 - py, -1.65 - pz, 1.18, 0.82, 1.5);
    this.partOn(this.abdomen, GEO.joint, accent, 0, 0.2 - py, -1.55 - pz, 0.34, 0.7, 1.42);
  }

  buildLegs() {
    const fem = limbMat(0x2aa7c4), tib = limbMat(0x1d7f96), tar = limbMat(0x12606f), jnt = limbMat(0x0f1c24);
    const spec = [
      { az: 0.50, off: 0.50 }, { az: 1.12, off: 0.33 }, { az: 1.78, off: 0.17 }, { az: 2.42, off: 0.00 },
      { az: -2.42, off: 0.50 }, { az: -1.78, off: 0.67 }, { az: -1.12, off: 0.83 }, { az: -0.50, off: 0.00 },
    ];
    const rHip = 1.15, rHome = 3.35; this.legs = [];
    for (const s of spec) {
      const ox = Math.sin(s.az), oz = Math.cos(s.az); const home = V3(ox * rHome, 0, oz * rHome);
      const L = {
        hip: V3(ox * rHip, 0.0, oz * rHip), home, off: s.off, pole: V3(ox * 0.85, 1.45, oz * 0.85).normalize(),
        restAz: Math.atan2(home.x, home.z), restR: rHome, rMin: rHome * 0.78, rMax: rHome * 1.2, ccw: 0.3, cw: 0.3,
        femurM: new THREE.Mesh(GEO.cyl, fem), tibiaM: new THREE.Mesh(GEO.cyl, tib), tarsusM: new THREE.Mesh(GEO.cyl, tar),
        kneeM: new THREE.Mesh(GEO.joint, jnt), hipM: new THREE.Mesh(GEO.joint, jnt),
        plant: V3(), from: V3(), to: V3(), surfN: Y_UP.clone(), toN: Y_UP.clone(), t: 1, stepping: false,
      };
      L.restAxisL = home.clone().sub(L.hip).normalize();   // limb's neutral chain direction (for decomposed IK)
      L.femurM.castShadow = L.tibiaM.castShadow = L.tarsusM.castShadow = L.kneeM.castShadow = L.hipM.castShadow = true;
      L.kneeM.scale.setScalar(0.2); L.hipM.scale.setScalar(0.26);
      this.scene.add(L.femurM, L.tibiaM, L.tarsusM, L.kneeM, L.hipM); this.legs.push(L);
    }
    const margin = 0.06;
    for (let i = 0; i < 8; i++) {
      const L = this.legs[i], nx = this.legs[(i + 1) % 8], pv = this.legs[(i + 7) % 8];
      L.ccw = Math.max(0.12, Math.abs(wrapPi(nx.restAz - L.restAz)) * 0.5 - margin);
      L.cw = Math.max(0.12, Math.abs(wrapPi(pv.restAz - L.restAz)) * 0.5 - margin);
    }
  }

  rebuild() {
    let r = this.up.clone().cross(this.fwd); if (r.lengthSq() < 1e-6) r = this.up.clone().cross(V3(1, 0, 0.001)); r.normalize();
    this.fwd.copy(r.clone().cross(this.up).normalize()); this.right.copy(r);
    this.quat.setFromRotationMatrix(new THREE.Matrix4().makeBasis(this.right, this.up, this.fwd));
  }
  setRoot() {
    this.root.position.copy(this.bodyOrigin); this.root.quaternion.copy(this.quat);
    const br = 1 + Math.sin(performance.now() * 0.0032) * 0.013;
    const f = 1 + clamp01(this.fill || 0) * 0.55; // diegetic silk meter: a full spider is plump
    this.body.scale.set(1.18 * (0.85 + 0.15 * f), 0.82 * br * f, 1.5 * f); this.root.updateMatrixWorld(true);
  }
  // Cast straight down (along -up) at xz `pW` and return the first VALID foothold, or null.
  // Valid = faces up-ish (no ceilings), within leg reach above the body, and NOT buried inside
  // another collider. Starting the cast well ABOVE the target matters: under a big boulder's dome a
  // low start sits INSIDE the rock, so the cast misses it and lands on terrain buried within it.
  _castFoothold(pW) {
    const down = this.up.clone().negate();
    const maxAbove = this.legReach + 0.5;
    let origin = pW.clone().addScaledVector(this.up, 4);
    for (let a = 0; a < 6; a++) {
      const g = castAll(origin, down, this.rideClear + 12);
      if (!g) break;
      const upish = g.n.dot(this.up) > 0.1;
      const reachable = g.point.clone().sub(this.pos).dot(this.up) < maxAbove;
      let buried = false;
      for (const c of colliders) { if (clearance(g.point, c).d < -0.15) { buried = true; break; } }
      if (upish && reachable && !buried) return g;
      origin.copy(g.point).addScaledVector(down, 0.15); // skip it, keep going below
    }
    return null;
  }

  footProbe(pW) {
    // First try the desired stance point. If it has no reachable foothold — e.g. the target xz lands
    // deep inside a boulder's footprint where the only surface is the dome top, out of reach, and
    // everything below is buried rock — RETREAT the probe horizontally toward the body and retry. This
    // walks the foot off the boulder onto clear ground beside it instead of planting it inside solid
    // rock (which the de-pen can't recover from). Flat-ground targets succeed on the first try, so this
    // search only costs extra casts when the stance point is genuinely bad.
    let g = this._castFoothold(pW);
    if (g) return g;
    const retreat = this.pos.clone().sub(pW);
    retreat.addScaledVector(this.up, -retreat.dot(this.up)); // horizontal component only
    for (let k = 1; k <= 6; k++) {
      g = this._castFoothold(pW.clone().addScaledVector(retreat, (k / 6) * 0.85));
      if (g) return g;
    }
    // fallback: plain terrain point (last resort if every cast hit was rejected)
    const y = terrainH(pW.x, pW.z); return { point: V3(pW.x, y, pW.z), n: terrainN(pW.x, pW.z) };
  }
  reset() {
    if (this._abQ) { this._abQ.identity(); this.abdomen.quaternion.identity(); }
    this.up.copy(Y_UP); this.fwd.set(0, 0, 1); this.right.set(1, 0, 0); this.heading = 0; this.moveDir.set(0, 0, 1); this.curSpeed = 0; this.activity = 0; this.gaitPhase = 0;
    this.pos.set(0, terrainH(0, 0), 0); this.bodyOrigin.copy(this.pos).addScaledVector(this.up, this.rideClear); this.rebuild(); this.setRoot();
    for (const L of this.legs) { const hw = this.root.localToWorld(L.home.clone()); const g = this.footProbe(hw); L.plant.copy(g.point); L.surfN.copy(g.n); L.toN.copy(g.n); L.from.copy(g.point); L.to.copy(g.point); L.t = 1; L.stepping = false; }
  }

  /** place the spider at (x,z) on whatever surface is there, facing headingVec; re-probe feet. (test harness) */
  teleport(x, z, headingVec) {
    this.up.copy(Y_UP);
    if (headingVec) { this.fwd.copy(headingVec); this.fwd.y = 0; if (this.fwd.lengthSq() < 1e-6) this.fwd.set(0, 0, 1); this.fwd.normalize(); }
    else this.fwd.set(0, 0, 1);
    this.right.set(1, 0, 0); this.curSpeed = 0; this.activity = 0; this.gaitPhase = 0; this.moveDir.copy(this.fwd);
    const y = terrainH(x, z); this.pos.set(x, y, z);
    const g = castAll(V3(x, y + 80, z), DOWN, 120); if (g) this.pos.copy(g.point); // start ABOVE any geometry
    this.bodyOrigin.copy(this.pos).addScaledVector(this.up, this.rideClear); this.rebuild(); this.setRoot();
    for (const L of this.legs) { const hw = this.root.localToWorld(L.home.clone()); const gg = this.footProbe(hw); L.plant.copy(gg.point); L.surfN.copy(gg.n); L.toN.copy(gg.n); L.from.copy(gg.point); L.to.copy(gg.point); L.t = 1; L.stepping = false; }
  }

  // ---------------- GAME HOOKS (additive) ----------------
  /** world position of the spinnerets (rear underside of the abdomen) — where silk pays out. Emits
   *  from the articulated abdomen, so it tracks the waist bend. */
  spinneret(out = V3()) { return this.abdomen.localToWorld(out.set(0, -0.1 - this.PEDICEL.y, -2.55 - this.PEDICEL.z)); }
  /** world aim point: a ray from the body forward/down used by the game to pick anchor targets. */
  headPoint(out = V3()) { return this.root.localToWorld(out.set(0, 0.2, 1.4)); }

  /** Bend the abdomen at the pedicel. It hangs toward gravity (so it folds DOWN when the front rears
   *  up onto a wall, and lifts over a crest), plus a constant heavy-abdomen droop — spring-smoothed
   *  and clamped to an anatomical cone. Purely cosmetic articulation; does not affect locomotion. */
  _updateAbdomen(dt) {
    if (!this.abdomen) return;
    if (!this.bodyFlex) { this._abQ.identity(); this.abdomen.quaternion.identity(); return; }
    // gravity: the abdomen 'up' leans toward WORLD-up more than the cephalothorax does (it hangs).
    _wUp.copy(this.up).lerp(Y_UP, this.abHang); if (_wUp.lengthSq() < 1e-6) _wUp.copy(Y_UP); _wUp.normalize();
    _qInv.copy(this.quat).invert();
    _lUp.copy(_wUp).applyQuaternion(_qInv);                    // desired abdomen up, in root-local space
    _qT.setFromUnitVectors(_YAX, _lUp);                        // local tilt that aims the abdomen up at _lUp
    _qDroop.setFromAxisAngle(_XAX, -this.abDroop);             // + constant rear-down sag
    _qT.multiply(_qDroop);
    const ang = 2 * Math.acos(clamp(Math.abs(_qT.w), 0, 1));   // clamp the total bend to a realistic cone
    if (ang > this.abMax) { _qI.identity(); _qT.copy(_qI.slerp(_qT, this.abMax / ang)); }
    this._abQ.slerp(_qT, 1 - Math.pow(0.02, Math.min(dt, 0.05)));   // spring-lag: the abdomen trails organically
    this.abdomen.quaternion.copy(this._abQ);
  }

  /** leap off the current surface. dir is a world vector; power scales launch speed. */
  pounce(dir, power = 1) {
    if (this.airborne) return;
    this.pos.copy(this.bodyOrigin);                 // airborne convention: pos = body center
    const d = dir ? dir.clone().normalize() : this.fwd.clone();
    this.vel.copy(d).multiplyScalar(11 * power).addScaledVector(this.up, 7 * power);
    this.airborne = true; this.tether = null;
  }
  /** JUMP — an up + forward impulse into the airborne system (updateAirborne handles the arc, air
   *  control and landing). A plain jump is a clean pop (mostly vertical, carrying any running momentum);
   *  with BOOST it flattens the arc and PROPELS forward — a satisfying lunge. The up-impulse is along
   *  the surface normal, so a wall-jump kicks you off the wall. */
  jump(boost = false) {
    if (this.airborne) return;
    this.pos.copy(this.bodyOrigin);                              // airborne convention: pos = body center
    const moving = this.moveDir.lengthSq() > 0.04;
    const fwd = (moving ? this.moveDir : this.fwd).clone();
    fwd.addScaledVector(this.up, -fwd.dot(this.up));             // keep the forward impulse on the surface tangent
    if (fwd.lengthSq() < 1e-5) fwd.copy(this.fwd);
    fwd.normalize();
    const up = boost ? 8 : 10;                                   // boost trades height for forward distance
    const fwdImpulse = (boost ? 17 : (moving ? 3 : 0)) + this.curSpeed * (boost ? 1.0 : 0.7);
    this.vel.copy(this.up).multiplyScalar(up).addScaledVector(fwd, fwdImpulse);
    this.airborne = true; this.tether = null;
  }
  /** hang from an anchor point and swing on a dragline (verlet pendulum). */
  attachTether(anchorPoint) {
    if (!this.airborne) this.pos.copy(this.bodyOrigin);
    this.airborne = true;
    // points[] = the wrapped pivot chain from the anchor down to the active (last) pivot. Webs catch
    // on edges as you swing (Webbed: raycast-along-rope), so a swing bends around geometry, never clips.
    this.tether = { anchor: anchorPoint.clone(), points: [anchorPoint.clone()], len: Math.max(1.5, this.pos.distanceTo(anchorPoint)), reel: 0 };
  }
  releaseTether() {
    if (!this.tether) return;
    this.tether = null;
    // "swinging, not flying" (Insomniac/Fristrom, verified research): a release while moving converts
    // retained swing momentum into a forward+UP arc, so a well-timed let-go flings you onward and
    // chains into the next swing/pounce. A near-still cut (the ambush) keeps low speed -> clean drop.
    const sp = this.vel.length();
    if (sp > 4) this.vel.addScaledVector(Y_UP, Math.min(sp * 0.55, 9));   // stronger fling — "almost fly" (verified research)
  }
  reel(rate) { if (this.tether) this.tether.reel = rate; }          // +climb up the line, -pay out

  /** land back onto a surface (point P, normal N): convert body-center pos -> feet-plane pos. */
  land(P, N) {
    this.airborne = false; this.tether = null; this.vel.set(0, 0, 0);
    if (N) { this.up.copy(N).normalize(); }
    this.pos.copy(P); this.bodyOrigin.copy(this.pos).addScaledVector(this.up, this.rideClear);
    this.rebuild(); this.setRoot();
    for (const L of this.legs) { if (L.lost) continue; const hw = this.root.localToWorld(L.home.clone()); const g = this.footProbe(hw); L.plant.copy(g.point); L.surfN.copy(g.n); L.toN.copy(g.n); L.from.copy(g.point); L.to.copy(g.point); L.t = 1; L.stepping = false; }
  }

  severLeg(i) { const L = this.legs[i]; if (!L || L.lost) return false; L.lost = true; this.legsLost++; for (const m of [L.femurM, L.tibiaM, L.tarsusM, L.kneeM, L.hipM]) m.visible = false; return true; }
  regrowLeg(i) { const L = this.legs[i]; if (!L || !L.lost) return false; L.lost = false; this.legsLost--; for (const m of [L.femurM, L.tibiaM, L.tarsusM, L.kneeM, L.hipM]) m.visible = true; return true; }

  /** airborne integration: ballistic + optional tether pendulum, world-up bias (anti-nausea), auto-land. */
  updateAirborne(dt, inp) {
    if (dt <= 0) { this.bodyOrigin.copy(this.pos); this.rebuild(); this.setRoot(); return; }
    const G = 26;
    this.vel.y -= G * dt;
    if (inp && (inp.ix || inp.iy)) {                 // air control / momentum steering
      const camF = V3(-Math.sin(inp.camYaw || 0), 0, -Math.cos(inp.camYaw || 0)); const camR = V3(-camF.z, 0, camF.x);
      this.vel.addScaledVector(camF.multiplyScalar(inp.iy).addScaledVector(camR, inp.ix), 16 * dt);
    }
    this.vel.multiplyScalar(1 - 0.09 * dt);          // very low air drag — "maintain momentum" (verified research)
    const oldPos = this.pos.clone();                 // for velocity-from-displacement (the canonical pendulum)
    this.pos.addScaledVector(this.vel, dt);
    if (this.tether) {
      const T = this.tether; if (!T.points) T.points = [T.anchor];
      if (T.reel) T.len = clamp(T.len - T.reel * dt, 1.5, 60);
      // UNWRAP: if the segment from the previous pivot straight to the spider is now clear, the line
      // slides off the edge it had caught on — drop the active pivot so the swing straightens out.
      if (T.points.length > 1) {
        const prev = T.points[T.points.length - 2], s2 = this.pos.clone().sub(prev), l2 = s2.length();
        if (l2 > 0.6) { const dir = s2.multiplyScalar(1 / l2); const h = castAll(prev.clone().addScaledVector(dir, 0.3), dir, l2 - 0.5); if (!h) T.points.pop(); }
      }
      // free swinging segment = total length minus what the wrapped pivots consume
      let consumed = 0; for (let i = 0; i < T.points.length - 1; i++) consumed += T.points[i].distanceTo(T.points[i + 1]);
      const active = T.points[T.points.length - 1];
      const freeLen = Math.max(1.0, T.len - consumed);
      const d = this.pos.clone().sub(active); const dl = d.length() || 1e-6;
      if (dl > freeLen) {
        // RIGID distance constraint around the ACTIVE pivot (Fristrom/Energy Hook, verified): snap onto
        // the sphere, then DERIVE velocity from displacement — tangential pendulum velocity emerges and
        // momentum is preserved through the whole arc (the core of good swing feel).
        this.pos.copy(active).addScaledVector(d.multiplyScalar(1 / dl), freeLen);
        this.vel.copy(this.pos).sub(oldPos).multiplyScalar(1 / dt);
      }
      // WRAP: the line from the active pivot to the spider is blocked by geometry — catch on the edge.
      const seg = this.pos.clone().sub(active), sl = seg.length();
      if (sl > 0.8 && T.points.length < 6) {
        const dir = seg.multiplyScalar(1 / sl); const h = castAll(active.clone().addScaledVector(dir, 0.3), dir, sl - 0.5);
        if (h && h.point.distanceTo(active) > 0.8) T.points.push(h.point.clone().addScaledVector(h.n, 0.3));
      }
    }
    // LATCH: a free leap (no live tether) that reaches a surface it's moving INTO grabs onto it — the
    // spider clings to the wall/box/overhang and starts climbing, instead of bouncing off and flying
    // past. Omnidirectional (any surface orientation), gated by approach velocity so a fall sliding
    // *past* a wall doesn't stick. Fires right at ride distance, so the body is already at clearance →
    // a smooth grab with no position pop; then grounded locomotion takes over and climbs.
    if (!this.tether) {
      let bn = null, bpt = null, bd = this.rideClear;
      for (const c of colliders) {
        const cl = clearance(this.pos, c);
        if (cl.d >= bd) continue;
        if (-this.vel.dot(cl.n) > 1.5 || cl.d < this.minClear) { bn = cl.n.clone(); bpt = this.pos.clone().addScaledVector(cl.n, -cl.d); bd = cl.d; }
      }
      if (bn) { this.land(bpt, bn); return; }
    }
    // airborne body collision — don't clip through geometry while swinging/pouncing (swings stay solid)
    for (const c of colliders) {
      const cl = clearance(this.pos, c);
      if (cl.d < 0.7) { this.pos.addScaledVector(cl.n, 0.7 - cl.d); const vn = this.vel.dot(cl.n); if (vn < 0) this.vel.addScaledVector(cl.n, -vn); }
    }
    this.up.lerp(Y_UP, 1 - Math.pow(0.015, dt)); this.up.normalize();   // airborne -> world-up framing
    const vh = V3(this.vel.x, 0, this.vel.z); if (vh.lengthSq() > 0.6) { this.fwd.lerp(vh.normalize(), 1 - Math.pow(0.12, dt)); this.fwd.y = 0; this.fwd.normalize(); }
    // land when a surface comes within ride height below the falling body (or we reach terrain)
    const downHit = castAll(this.pos.clone().add(V3(0, 0.5, 0)), DOWN, this.rideClear + 2.5);
    const tH = terrainH(this.pos.x, this.pos.z);
    // Don't auto-land mid-swing: while on a taut tether and still moving, the line holds you up — you
    // land only once the swing SETTLES (slow) or after you cut/release the line. Fixes swings dying
    // near geometry. (updateAirborne is not exercised by the grounded locomotion harness.)
    const swinging = this.tether && this.vel.lengthSq() > 9;   // ~3 u/s on a live line
    if (!swinging) {
      if (this.vel.y < 0 && downHit && this.pos.y - downHit.point.y < this.rideClear * 0.7) { this.land(downHit.point, downHit.n); return; }
      if (this.pos.y - this.rideClear < tH + 0.1) { this.land(V3(this.pos.x, tH, this.pos.z), terrainN(this.pos.x, this.pos.z)); return; }
    } else if (this.pos.y - this.rideClear < tH + 0.1) {
      this.pos.y = tH + this.rideClear + 0.1;   // keep the swinging arc just off the floor (no clip)
    }
    this.pos.x = clamp(this.pos.x, -FIELD / 2 + 3, FIELD / 2 - 3); this.pos.z = clamp(this.pos.z, -FIELD / 2 + 3, FIELD / 2 - 3);
    this.heading = Math.atan2(this.fwd.x, this.fwd.z); this.rebuild();
    this.bodyOrigin.copy(this.pos); this._updateAbdomen(dt > 0 ? dt : 1e-4); this.setRoot();  // airborne: body IS pos
    this.poseAirborneLegs();
    for (const aa of this.antennae) aa.step(dt);
  }
  /** curl the legs to dangle from the hips while airborne (no gait off-surface). */
  poseAirborneLegs() {
    const down = this.up.clone().negate();
    for (const L of this.legs) {
      if (L.lost) continue;
      const hipW = this.root.localToWorld(L.hip.clone());
      const out = hipW.clone().sub(this.bodyOrigin); out.addScaledVector(this.up, -out.dot(this.up)); if (out.lengthSq() < 1e-4) out.copy(this.fwd); out.normalize();
      const knee = hipW.clone().addScaledVector(out, this.femur * 0.55).addScaledVector(down, this.femur * 0.5);
      const ankle = knee.clone().addScaledVector(down, this.tibia * 0.7).addScaledVector(out, -this.tibia * 0.2);
      const foot = ankle.clone().addScaledVector(down, this.tarsus);
      L.plant.copy(foot); L._hipW = hipW; L._knee = knee; L._ankle = ankle; L._foot = foot;
      orientCyl(L.femurM, hipW, knee, this.legRad); orientCyl(L.tibiaM, knee, ankle, this.legRad * 0.8); orientCyl(L.tarsusM, ankle, foot, this.legRad * 0.62);
      L.kneeM.position.copy(knee); L.hipM.position.copy(hipW);
    }
  }

  update(dt, inp) {
    if (this.airborne) { this.updateAirborne(dt, inp); return; }
    if (dt > 0) {
      this.rebuild();
      // 1) responsive movement in the surface tangent plane (body leads; legs follow)
      const mag = Math.min(1, Math.hypot(inp.ix, inp.iy));
      if (mag > 0.08) {
        const camF = V3(-Math.sin(inp.camYaw), 0, -Math.cos(inp.camYaw)); const camR = V3(-camF.z, 0, camF.x);
        const intent = camF.multiplyScalar(inp.iy).addScaledVector(camR, inp.ix); // horizontal world intent
        const dir = intent.clone().addScaledVector(this.up, -intent.dot(this.up)); // surface-tangent projection
        // On steep surfaces (walls), horizontal input can't drive UP a vertical face — so the
        // "into/out of the surface" component of the intent becomes climb-up / climb-down along it.
        const steep = 1 - Math.abs(this.up.y);
        if (steep > 0.25) {
          const climbAmt = -intent.dot(this.up); // + pushing into the wall -> up; - pulling away -> down
          const upWall = V3(0, 1, 0).addScaledVector(this.up, -this.up.y); // world-up projected onto the tangent
          if (upWall.lengthSq() > 1e-4) dir.addScaledVector(upWall.normalize(), climbAmt * steep);
        }
        if (dir.lengthSq() > 1e-5) {
          dir.normalize(); this.moveDir.copy(dir); this.curSpeed = this.baseSpeed * mag * (inp.sprint ? this.sprintMul : 1);
          this.pos.addScaledVector(dir, this.curSpeed * dt);
          const turn = clamp(signedAngle(this.fwd, dir, this.up), -this.turnRate * dt, this.turnRate * dt); this.fwd.applyAxisAngle(this.up, turn); this.rebuild();
        }
      } else { this.curSpeed = lerp(this.curSpeed, 0, 1 - Math.pow(0.0008, dt)); this.moveDir.multiplyScalar(0.86); }
      this.activity = this.curSpeed / this.baseSpeed;
      // 1b) SUPPORT PLANE from the planted feet (centroid + Newell normal). Drives the ride HEIGHT
      // (step 4) and body TILT (step 5) so the torso conforms to what it's actually standing on.
      // The centroid is weighted by how close each foot is to where it SHOULD be under the body:
      // a foot stranded far from its home (left on a ledge during a dismount, or stuck high on a wall)
      // is unreliable support and must NOT hold the body up — that was the dismount/wall "float".
      let feetC = null, feetN;
      { let cx = 0, cy = 0, cz = 0, wsum = 0, nx = 0, ny = 0, nz = 0;
        for (let i = 0; i < 8; i++) {
          const L = this.legs[i]; if (L.lost) continue; const A = L.plant, B = this.legs[(i + 1) % 8].plant;
          nx += (A.y - B.y) * (A.z + B.z); ny += (A.z - B.z) * (A.x + B.x); nz += (A.x - B.x) * (A.y + B.y);
          if (!L.stepping) {
            const homeW = this.root.localToWorld(L.home.clone());             // last frame's root transform
            const w = clamp01(1 - A.distanceTo(homeW) / (this.maxStride * 1.4));
            cx += A.x * w; cy += A.y * w; cz += A.z * w; wsum += w;
          }
        }
        if (wsum > 1e-3) feetC = V3(cx / wsum, cy / wsum, cz / wsum);
        feetN = V3(nx, ny, nz); if (feetN.dot(this.up) < 0) feetN.negate(); if (feetN.lengthSq() < 1e-6) feetN.copy(this.up); feetN.normalize();
      }
      // 2) surface under the body (cast down relative to body)
      let g = castAll(this.pos.clone().addScaledVector(this.up, 1.6), this.up.clone().negate(), this.rideClear + 7);
      if (!g) g = castAll(this.pos.clone().add(V3(0, 3.5, 0)), DOWN, 22);
      // 2b) anticipate a higher surface just ahead and start climbing it NOW, so a sharp step / terrace
      // riser is taken as a smooth ramp instead of a one-frame yank by the terrain floor-clamp below.
      // Only raises for UPWARD steps (a lower surface ahead leaves the target unchanged — descents and
      // flat ground are untouched); the rise is capped to rideClear so a tall wall still climbs vertically.
      if (g && this.curSpeed > 0.5) {
        const ahO = this.pos.clone().addScaledVector(this.moveDir, 1.2).addScaledVector(this.up, this.rideClear);
        const ah = castAll(ahO, this.up.clone().negate(), this.rideClear + 9);
        if (ah) { const dh = ah.point.clone().sub(g.point).dot(this.up); if (dh > 0) g.point.addScaledVector(this.up, Math.min(dh, this.rideClear)); }
      }
      // 3) forward feeler: a surface we're driving INTO -> tilt onto it (climb up/down/crest unified)
      let aheadN = null;
      if (this.curSpeed > 0.4) { const a = castAll(this.pos.clone().addScaledVector(this.up, 0.5), this.moveDir, this.bodyR + 1.4); if (a && a.n.dot(this.moveDir) < -0.2) aheadN = a.n.clone(); }
      // 4) ride the surface (capped snap; fall if nothing). With BODY CONFORM on, raise the ride target
      // toward the (home-weighted) feet centroid so the body climbs ONTO a step as its feet do — capped
      // by MAXLIFT so stranded feet on a ledge/wall can't float it (it settles, which re-steps them down).
      let ridePt = g ? g.point.clone() : null;
      if (g && this.bodyConform && this.conformLift && feetC) {
        const rise = feetC.clone().sub(g.point).dot(this.up);
        const MAXLIFT = Math.max(2.2, this.stepH * 3 + 0.8);
        if (rise > 0) ridePt = g.point.clone().addScaledVector(this.up, Math.min(rise, MAXLIFT));
      }
      if (ridePt) { const d = ridePt.clone().sub(this.pos); const dl = d.length(); const cap = (this.curSpeed * 1.7 + 9) * dt; if (dl > cap) this.pos.addScaledVector(d.multiplyScalar(1 / dl), cap); else this.pos.copy(ridePt); }
      else this.pos.y -= 9 * dt;
      const tH = terrainH(this.pos.x, this.pos.z); if (this.pos.y < tH - 0.3) this.pos.y = tH - 0.3;
      this.pos.x = clamp(this.pos.x, -FIELD / 2 + 3, FIELD / 2 - 3); this.pos.z = clamp(this.pos.z, -FIELD / 2 + 3, FIELD / 2 - 3); this.pos.y = clamp(this.pos.y, -12, 46);
      // 4b) body de-penetration: the torso must clear colliders that intrude from the SIDE, or the hips
      // poke into rock — in a tight saddle/crevice the down-cast finds the low terrain and the body sits
      // jammed between two boulders that bulge in at hip height. Only SIDE intrusions count (normal
      // roughly horizontal): a ceiling above (walk-under overhang) or floor below must NOT shove the
      // body, those are handled by the ride + foot lift.
      {
        const R = this.bodyR + this.legRad + 0.2;
        const push = V3(); let sidePen = 0;
        const p = this.pos.clone().addScaledVector(this.up, this.rideClear); // torso level only (NOT feet)
        for (const c of colliders) {
          const cc = c.kind === 'sphere' ? c.c : c.p;
          if (p.distanceTo(cc) > R + c.br + 1) continue;
          const cl = clearance(p, c);
          // side intrusion only: normal points sideways/upward (boulder beside us). EXCLUDE downward
          // normals (a roof or overhang EDGE above the torso — duck under via foot lift, don't shove
          // the body back) and steep-up normals (a floor — that's the ride's job).
          const nu = cl.n.dot(this.up);
          if (cl.d < R && nu > -0.3 && nu < 0.7) {
            const amt = R - cl.d;
            push.addScaledVector(cl.n, amt);
            if (amt > sidePen) sidePen = amt;
          }
        }
        if (sidePen > 1e-4) {
          push.addScaledVector(this.up, -push.dot(this.up));     // keep the escape horizontal
          // Don't stall against obstacles we're walking INTO: when the escape opposes travel (both domes
          // of a saddle are ahead, so "out of the rock" = backward), convert that backward component into
          // an UPWARD lift — the body climbs OVER the saddle instead of grinding to a halt at its base.
          // A purely sideways escape (passing a lone boulder) is left horizontal so the body steps around.
          let lift = sidePen;
          const back = push.dot(this.moveDir);
          if (back < 0) { push.addScaledVector(this.moveDir, -back); lift -= back; }
          push.addScaledVector(this.up, lift);
          const mag = Math.min(push.length(), 0.4);              // cap per-frame so it never teleports
          if (push.lengthSq() > 1e-9) this.pos.addScaledVector(push.normalize(), mag);
          this.pos.y = clamp(this.pos.y, -12, 46);
        }
      }
      // 5) body up = surface normal, blended toward an upcoming surface + a touch of the foot plane
      let surfN = g ? g.n.clone() : Y_UP.clone();
      if (aheadN) surfN.multiplyScalar(0.35).addScaledVector(aheadN, 0.65).normalize();
      // tilt with the actual support plane (feetN, from step 1b). CONFORM weights the feet more so the
      // body pitches onto slopes/steps; OFF keeps the original light 0.2 touch.
      const fw = this.bodyConform ? this.conformTiltW : 0.2;
      const targetUp = surfN.multiplyScalar(1 - fw).addScaledVector(feetN, fw).normalize();
      this.up.lerp(targetUp, aheadN ? 1 - Math.pow(0.05, dt) : 1 - Math.pow(0.09, dt));
      if (this.up.lengthSq() < 1e-6 || !isFinite(this.up.x)) this.up.copy(Y_UP); this.up.normalize();
    }
    // 6) ride above the surface; legs follow
    this.rebuild(); this.bodyOrigin.copy(this.pos).addScaledVector(this.up, this.rideClear);
    this.heading = Math.atan2(this.fwd.x, this.fwd.z); this._updateAbdomen(dt > 0 ? dt : 1e-4); this.setRoot();
    this.updateLegs(dt > 0 ? dt : 1e-4);
    if (dt > 0) for (const a of this.antennae) a.step(dt);
  }

  updateLegs(dt) {
    const act = Math.max(this.activity || 0, 0.0001);
    const freq = this.baseFreq * act; if (act > 0.12) this.gaitPhase = frac((this.gaitPhase || 0) + dt * freq);
    const duty = this.duty;
    const stride = clamp((this.curSpeed / Math.max(freq, 0.25)) * 0.82, 0.35, this.maxStride);
    const swingDur = Math.max((1 - duty) / Math.max(freq, 0.3), 0.05), maxReach = this.femur + this.tibia;
    // step requests (sectors + reach + phase + occlusion)
    let swinging = 0; const reqs = [];
    for (let i = 0; i < 8; i++) {
      const L = this.legs[i]; if (L.lost) continue; if (L.stepping) { swinging++; continue; }
      const homeW = this.root.localToWorld(L.home.clone()); const hg = this.footProbe(homeW); L._home = hg.point;
      const hipW = this.root.localToWorld(L.hip.clone()); const reachFrac = hipW.distanceTo(L.plant) / maxReach;
      const lp = this.root.worldToLocal(L.plant.clone()); const dAz = wrapPi(Math.atan2(lp.x, lp.z) - L.restAz), r = Math.hypot(lp.x, lp.z);
      const blocked = occluded(hipW, L.plant);
      const outSec = dAz > L.ccw || dAz < -L.cw || r > L.rMax * 1.05 || r < L.rMin * 0.9 || reachFrac > 0.9 || blocked;
      const dHome = L.plant.distanceTo(hg.point); const legPhase = frac((this.gaitPhase || 0) + L.off); const phaseDue = act > 0.15 && legPhase > duty;
      if (phaseDue || dHome > this.stepThresh || outSec) reqs.push({ i, rf: reachFrac, bl: blocked, u: (outSec ? 2.4 : 0) + dHome * 0.45 + (phaseDue ? 1 : 0) + (reachFrac > 0.9 ? 3 : 0) + (blocked ? 2.5 : 0) });
    }
    reqs.sort((a, b) => b.u - a.u);
    const maxConc = act > 0.7 ? 4 : 3;
    for (const q of reqs) {
      const crit = q.rf > 0.95 || q.bl;               // over-extended OR spanning an obstacle -> emergency re-plant
      const cap = q.bl ? 8 : (crit ? maxConc + 2 : maxConc); // spanning legs re-plant immediately (no clip frames)
      if (swinging >= cap) continue;
      const i = q.i, L = this.legs[i];
      if (!crit && (this.legs[(i + 1) % 8].stepping || this.legs[(i + 7) % 8].stepping)) continue; // Cruse rule 1 (waived for emergencies)
      const desired = L._home.clone().addScaledVector(this.moveDir, stride);
      let dl = this.root.worldToLocal(desired.clone()); let az = L.restAz + clamp(wrapPi(Math.atan2(dl.x, dl.z) - L.restAz), -L.cw, L.ccw); let rr = clamp(Math.hypot(dl.x, dl.z), L.rMin, L.rMax);
      let w = this.root.localToWorld(V3(Math.sin(az) * rr, dl.y, Math.cos(az) * rr));
      for (let j = 0; j < 8; j++) { if (j === i || this.legs[j].stepping) continue; const f = this.legs[j].plant; const dx = w.x - f.x, dy = w.y - f.y, dz = w.z - f.z, d = Math.hypot(dx, dy, dz); if (d < this.minFoot && d > 1e-3) { w.x = f.x + dx / d * this.minFoot; w.y = f.y + dy / d * this.minFoot; w.z = f.z + dz / d * this.minFoot; } }
      dl = this.root.worldToLocal(w.clone()); az = L.restAz + clamp(wrapPi(Math.atan2(dl.x, dl.z) - L.restAz), -L.cw, L.ccw); rr = clamp(Math.hypot(dl.x, dl.z), L.rMin, L.rMax);
      w = this.root.localToWorld(V3(Math.sin(az) * rr, dl.y, Math.cos(az) * rr));
      const hipC = this.root.localToWorld(L.hip.clone());
      let g = this.footProbe(w), foot = g.point.clone();
      // pull the foot inward up the surface if the leg spans an obstacle OR the foot dropped far below
      // the hip (reached past a slab/platform edge to the lower ground) — both make the leg cut the edge.
      const spans = () => occluded(hipC, foot) || hipC.clone().sub(foot).dot(this.up) > this.rideClear + 1.3;
      for (let ti = 0; ti < 8 && spans(); ti++) { rr = Math.max(L.rMin * 0.7, rr * 0.66); const wc = this.root.localToWorld(V3(Math.sin(az) * rr, dl.y, Math.cos(az) * rr)); g = this.footProbe(wc); foot = g.point.clone(); }
      const tv = foot.clone().sub(hipC); const dd = tv.length(); const safe = maxReach * 0.86; if (dd > safe) foot = hipC.clone().addScaledVector(tv.multiplyScalar(1 / dd), safe);
      L.stepping = true; L.t = 0; L.from.copy(L.plant); L.to.copy(foot); L.toN.copy(g.n); swinging++;
      // adaptive swing height: arc the foot just enough to clear low obstacles along its path,
      // but never into a ceiling overhead (cap by available headroom) and never enough to vault walls
      let mp = 0; for (let s = 1; s < 6; s++) { _depP.copy(L.from).lerp(L.to, s / 6); for (const c of colliders) { const d = clearance(_depP, c).d; if (-d > mp) mp = -d; } }
      // clear LOW obstacles (steps), never enough to vault tall ones (walls/pillars) onto a roof
      let lift = Math.min(this.stepH + mp * 1.1, this.stepH + 1.3);
      const head = castAll(_depP.copy(L.from).lerp(L.to, 0.5).addScaledVector(this.up, 0.2), this.up, lift + 0.6); // headroom
      if (head) lift = Math.min(lift, Math.max(0.2, head.t - 0.3));
      L.lift = lift;
    }
    // swing integration + analytic IK + knee swivel + reach guard
    const upv = this.up;
    for (let i = 0; i < 8; i++) {
      const L = this.legs[i];
      if (L.lost) continue;
      if (L.stepping) {
        L.t += dt / swingDur; const t = clamp01(L.t); L.plant.lerpVectors(L.from, L.to, smooth(t)); L.plant.addScaledVector(upv, (L.lift || this.stepH) * Math.sin(Math.PI * Math.pow(t, 0.82)));
        if (t >= 1) { L.stepping = false; L.plant.copy(L.to); L.surfN.copy(L.toN); if (this.curSpeed > 1.2) this.world.puff(L.plant); }
      }
      const hipW = this.root.localToWorld(L.hip.clone());
      // lift the ankle along the surface normal so the tarsus stays perpendicular to the (possibly
      // tilted) surface; keep a touch of body-up so it never inverts below the foot.
      let sN = L.surfN.clone(); sN.multiplyScalar(0.7).addScaledVector(upv, 0.3).normalize();
      if (sN.dot(upv) < 0.15) sN.copy(upv);
      const basePole = L.pole.clone().applyQuaternion(this.root.quaternion); let nearC = null;
      const restAxisW = L.restAxisL.clone().applyQuaternion(this.root.quaternion);   // rest dir for decomposed IK
      for (const c of colliders) { const cc = c.kind === 'sphere' ? c.c : c.p; if (hipW.distanceTo(cc) < this.legReach + c.br + 1.2) { (nearC || (nearC = [])).push(c); } }
      // The foot STAYS on its planted contact (which footProbe placed on a surface). De-penetrate
      // the rendered foot as a hard anti-clip guarantee, then lift the ankle off it along the
      // surface normal and clamp only the IK CHAIN to reach (tarsus stretches a hair if overextended,
      // rather than the foot stabbing into geometry — the old reach-guard's clipping bug).
      let foot = L.plant.clone();
      if (nearC) for (const c of nearC) { const cl = clearance(foot, c); const want = this.legRad * 0.6; if (cl.d < want) foot.addScaledVector(cl.n, want - cl.d); }
      { const th = terrainH(foot.x, foot.z); if (foot.y < th) foot.y = th; }
      let ankle = foot.clone().addScaledVector(sN, this.tarsus);
      const maxR = maxReach - 0.03; { const to = ankle.clone().sub(hipW); const da = to.length(); if (da > maxR) ankle = hipW.clone().addScaledVector(to.multiplyScalar(1 / da), maxR); }
      // knee solve with collision-avoiding swivel; scores femur + tibia + tarsus penetration
      const solveKnee = (ank) => {
        if (!nearC) return { knee: ikKnee(hipW, ank, this.femur, this.tibia, basePole.clone().normalize(), restAxisW, V3()), pen: 0 };
        const axis = ank.clone().sub(hipW); const al = axis.length() || 1e-6; axis.multiplyScalar(1 / al);
        const rng = TUNE.aRange, ns = Math.max(1, TUNE.aSamp | 0); let best = 1e9, bk = null;
        for (let a = 0; a <= ns * 2; a++) {
          const ang = a === 0 ? 0 : (a & 1 ? 1 : -1) * Math.ceil(a / 2) * (rng / ns);
          const pole = basePole.clone().applyAxisAngle(axis, ang).normalize();
          const kk = ikKnee(hipW, ank, this.femur, this.tibia, pole, restAxisW, V3());
          const pen = segPen(hipW, kk, nearC, this.legRad + 0.05) + segPen(kk, ank, nearC, this.legRad + 0.05) + segPen(ank, foot, nearC, this.legRad + 0.05);
          const score = pen + Math.abs(ang) * 0.008;
          if (score < best) { best = score; bk = kk; }
        }
        return { knee: bk, pen: best };
      };
      const sol = solveKnee(ankle);
      let knee = sol.knee || ikKnee(hipW, ankle, this.femur, this.tibia, basePole.clone().normalize(), restAxisW, V3());
      const kneeIK = knee.clone(); // bound the de-pen so the leg never stretches into a flail
      // Hard anti-clip: push the rendered joints out of solids, then push the KNEE outward until the
      // femur & tibia chords clear too (the leg bends to route around edges; bone lengths flex a hair).
      if (nearC) {
        const rad = this.legRad + 0.02;
        const depen = (pt) => { for (const c of nearC) { const cl = clearance(pt, c); if (cl.d < rad) pt.addScaledVector(cl.n, rad - cl.d); } const th = terrainH(pt.x, pt.z) + rad * 0.5; if (pt.y < th) pt.y = th; };
        // ankle: de-pen ONCE (out of solids + above terrain), then keep within reach. Never free-push
        // it in a loop — that drove the ankle below floors / above ceilings and made the tarsus span them.
        depen(ankle);
        { const to = ankle.clone().sub(hipW); const da = to.length(); if (da > maxR) ankle = hipW.clone().addScaledVector(to.multiplyScalar(1 / da), maxR); }
        depen(knee);
        // iterate: femur/tibia clips push the KNEE; tarsus clips nudge the ANKLE (gently, and re-clamped
        // above terrain + within reach every step so it can never fly below floors or above ceilings).
        const th2 = (p) => terrainH(p.x, p.z) + rad * 0.5;
        for (let it = 0; it < 16; it++) {
          let kP = 0, kN = null, aP = 0, aN = null;
          for (const [a, b] of [[hipW, knee], [knee, ankle]]) for (let s = 1; s < 10; s++) {
            _depP.copy(a).lerp(b, s / 10);
            for (const c of nearC) { const cl = clearance(_depP, c); const p = rad - cl.d; if (p > kP) { kP = p; kN = cl.n; } }
            const tp = th2(_depP) - _depP.y; if (tp > kP) { kP = tp; kN = _kUp; }
          }
          for (let s = 0; s < 6; s++) {
            _depP.copy(ankle).lerp(foot, s / 6);
            for (const c of nearC) { const cl = clearance(_depP, c); const p = rad - cl.d; if (p > aP) { aP = p; aN = cl.n; } }
          }
          let moved = false;
          if (kN && kP > 0.01) { knee.addScaledVector(kN, Math.min(kP * 1.4 + 0.02, 0.5)); depen(knee); moved = true; }
          if (aN && aP > 0.01) {
            ankle.addScaledVector(aN, Math.min(aP + 0.02, 0.12));
            const t = th2(ankle); if (ankle.y < t) ankle.y = t;
            const to = ankle.clone().sub(hipW); const da = to.length(); if (da > maxR) ankle = hipW.clone().addScaledVector(to.multiplyScalar(1 / da), maxR);
            moved = true;
          }
          if (!moved) break;
        }
        // bound the knee's de-pen displacement so the femur/tibia can flex to route around edges but
        // never grotesquely stretch (a wildly-pushed knee was the wall-crest "flailing leg" clip).
        const kd = knee.clone().sub(kneeIK); const kdl = kd.length();
        if (kdl > 1.3) { knee.copy(kneeIK).addScaledVector(kd, 1.3 / kdl); depen(knee); }
      }
      orientCyl(L.femurM, hipW, knee, this.legRad); orientCyl(L.tibiaM, knee, ankle, this.legRad * 0.8); orientCyl(L.tarsusM, ankle, foot, this.legRad * 0.62);
      L.kneeM.position.copy(knee); L.hipM.position.copy(hipW);
      L._hipW = hipW; L._knee = knee; L._ankle = ankle; L._foot = foot; // exposed for the test harness
    }
  }

  get position() { return this.root.position; }
}
