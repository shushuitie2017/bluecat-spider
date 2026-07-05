import { clamp } from './dynamics.js';

const TOUCH = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;

/**
 * Input → intents (faithful port). Keyboard + drag-to-look + wheel zoom + touch
 * joystick + boost. Drag/zoom are forwarded to the camera controller. No pointer
 * lock (robust everywhere). getInput() returns {ix,iy,sprint,camYaw}.
 */
export class Input {
  constructor(dom, camera) {
    this.dom = dom; this.camera = camera;
    this.keys = {};
    this.joyId = null; this.joyBX = 0; this.joyBY = 0; this.joyVX = 0; this.joyVY = 0;
    this.camId = null; this.camLX = 0; this.camLY = 0; this.dragging = false; this.sprintHeld = false;
    this.JOYR = 46;
    this.joyEl = document.getElementById('joy'); this.knobEl = document.getElementById('knob'); this.sprintEl = document.getElementById('sprint');
    this.jumpEl = document.getElementById('jump');
    this.onReset = null; this.onJump = null;
    this._bind();
  }

  _showJoy(x, y) { this.joyEl.style.left = x + 'px'; this.joyEl.style.top = y + 'px'; this.joyEl.style.display = 'block'; this.knobEl.style.left = x + 'px'; this.knobEl.style.top = y + 'px'; this.knobEl.style.display = 'block'; }
  _moveKnob(x, y) { this.knobEl.style.left = x + 'px'; this.knobEl.style.top = y + 'px'; }
  _hideJoy() { this.joyEl.style.display = 'none'; this.knobEl.style.display = 'none'; }

  _bind() {
    addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      if (e.code === 'KeyR' && this.onReset) this.onReset();
      if (e.code === 'Space' && !e.repeat && this.onJump) this.onJump(this.getInput().sprint);   // jump (+Shift = boost lunge)
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].indexOf(e.code) >= 0) e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });
    addEventListener('blur', () => { this.keys = {}; this.sprintHeld = false; this.joyId = null; this.joyVX = this.joyVY = 0; this._hideJoy(); });

    const dom = this.dom;
    dom.addEventListener('pointerdown', (e) => {
      const leftZone = e.clientX < innerWidth * 0.46;
      if (e.pointerType === 'touch' && leftZone && this.joyId === null) { this.joyId = e.pointerId; this.joyBX = e.clientX; this.joyBY = e.clientY; this.joyVX = 0; this.joyVY = 0; this._showJoy(e.clientX, e.clientY); }
      else if (this.camId === null) { this.camId = e.pointerId; this.camLX = e.clientX; this.camLY = e.clientY; this.dragging = true; }
      try { dom.setPointerCapture(e.pointerId); } catch (_) {}
    });
    dom.addEventListener('pointermove', (e) => {
      if (e.pointerId === this.joyId) { let dx = e.clientX - this.joyBX, dy = e.clientY - this.joyBY; const len = Math.hypot(dx, dy); if (len > this.JOYR) { dx *= this.JOYR / len; dy *= this.JOYR / len; } this.joyVX = dx / this.JOYR; this.joyVY = -dy / this.JOYR; this._moveKnob(this.joyBX + dx, this.joyBY + dy); }
      else if (e.pointerId === this.camId) { this.camera.addDrag(e.clientX - this.camLX, e.clientY - this.camLY); this.camLX = e.clientX; this.camLY = e.clientY; }
    });
    const end = (e) => { if (e.pointerId === this.joyId) { this.joyId = null; this.joyVX = 0; this.joyVY = 0; this._hideJoy(); } if (e.pointerId === this.camId) { this.camId = null; this.dragging = false; } };
    dom.addEventListener('pointerup', end); dom.addEventListener('pointercancel', end);
    dom.addEventListener('wheel', (e) => { e.preventDefault(); this.camera.zoom(e.deltaY); }, { passive: false });

    const sprintOn = (e) => { e.preventDefault(); this.sprintHeld = true; this.sprintEl.classList.add('active'); };
    const sprintOff = (e) => { if (e) e.preventDefault(); this.sprintHeld = false; this.sprintEl.classList.remove('active'); };
    this.sprintEl.addEventListener('pointerdown', sprintOn); this.sprintEl.addEventListener('pointerup', sprintOff);
    this.sprintEl.addEventListener('pointercancel', sprintOff); this.sprintEl.addEventListener('pointerleave', sprintOff);
    // JUMP button (touch): tap to jump; hold BOOST first for the forward lunge
    if (this.jumpEl) this.jumpEl.addEventListener('pointerdown', (e) => { e.preventDefault(); this.onJump && this.onJump(this.getInput().sprint); });
    addEventListener('visibilitychange', () => { if (document.hidden) { this.keys = {}; this.joyId = null; this.joyVX = this.joyVY = 0; this._hideJoy(); } });

    if (TOUCH) { this.sprintEl.style.display = 'flex'; if (this.jumpEl) this.jumpEl.style.display = 'flex'; }
  }

  getInput() {
    let ix = 0, iy = 0;
    if (this.joyId !== null) { ix = this.joyVX; iy = this.joyVY; }
    else {
      const k = this.keys;
      if (k['KeyW'] || k['ArrowUp']) iy += 1; if (k['KeyS'] || k['ArrowDown']) iy -= 1;
      if (k['KeyD'] || k['ArrowRight']) ix += 1; if (k['KeyA'] || k['ArrowLeft']) ix -= 1;
    }
    const sprint = this.sprintHeld || this.keys['ShiftLeft'] || this.keys['ShiftRight'];
    return { ix, iy, sprint, camYaw: this.camera.yaw };
  }
}
