import { V3, clamp, wrapPi } from '../core/dynamics.js';
import { castAll } from '../world/collision.js';
import { terrainH } from '../world/terrain.js';

const angLerp = (a, b, t) => a + wrapPi(b - a) * t;

/**
 * Third-person follow camera (faithful port). Stays WORLD-UP at all times — no
 * surface-relative tilt — so walls/ceilings never rotate the horizon (no nausea).
 * Auto-follows yaw behind the heading only on near-flat ground. Collision pull-in
 * + terrain floor clamp so it never clips geometry or sinks under the world.
 */
export class SpiderCamera {
  constructor(camera) {
    this.camera = camera;
    this.yaw = Math.PI; this.pitch = 0.5; this.dist = 15;
    this.target = V3(0, 2, 0);
  }
  addDrag(dx, dy) { this.yaw -= dx * 0.005; this.pitch = clamp(this.pitch - dy * 0.005, 0.06, 1.28); }
  zoom(deltaY) { this.dist = clamp(this.dist * (1 + deltaY * 0.0011), 6, 34); }

  update(dt, spider, dragging) {
    const moving = spider.curSpeed > 0.5;
    if (moving && !dragging && spider.up.y > 0.6) this.yaw = angLerp(this.yaw, spider.heading + Math.PI, 1 - Math.pow(0.72, dt));
    const cp = Math.cos(this.pitch); const tgt = spider.position;
    this.target.lerp(V3(tgt.x, tgt.y + 1.0, tgt.z), 1 - Math.pow(0.0007, dt));
    const want = V3(
      this.target.x + Math.sin(this.yaw) * cp * this.dist,
      this.target.y + Math.sin(this.pitch) * this.dist,
      this.target.z + Math.cos(this.yaw) * cp * this.dist,
    );
    const toC = want.clone().sub(this.target); const dC = toC.length() || 1e-3; toC.multiplyScalar(1 / dC);
    const hit = castAll(this.target.clone().addScaledVector(toC, 0.5), toC, dC);
    let wantDist = dC;
    if (hit && hit.t < dC - 0.4) wantDist = Math.max(hit.t - 0.6, 4.5);   // never jam uncomfortably close in the dense world
    if (this._d == null) this._d = wantDist;
    // pull IN quickly (avoid clipping) but ease OUT slowly (no jarring zoom snap)
    const k = wantDist < this._d ? (1 - Math.pow(0.0006, dt)) : (1 - Math.pow(0.22, dt));
    this._d += (wantDist - this._d) * k;
    const camPos = this.target.clone().addScaledVector(toC, this._d);
    this.camera.position.lerp(camPos, 1 - Math.pow(0.0018, dt));
    const minY = terrainH(this.camera.position.x, this.camera.position.z) + 1.6;
    if (this.camera.position.y < minY) this.camera.position.y = minY;
    this.camera.lookAt(this.target);
  }
}
