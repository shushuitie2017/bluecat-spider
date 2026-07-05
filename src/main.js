import * as THREE from 'three';
import { World } from './world/World.js';
import { Spider, TUNE } from './spider/Spider.js';
import { SpiderCamera } from './camera/SpiderCamera.js';
import { Input } from './core/Input.js';

const TOUCH = matchMedia('(pointer:coarse)').matches || 'ontouchstart' in window;
const errEl = document.getElementById('err');
function fatal(msg) { errEl.style.display = 'flex'; errEl.textContent = msg; }

let renderer, scene, camera, world, spider, spiderCam, input;
try {
  const app = document.getElementById('app');
  renderer = new THREE.WebGLRenderer({ antialias: !TOUCH, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, TOUCH ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = 1.15;
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  app.appendChild(renderer.domElement);

  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 700);

  world = new World(scene);
  spider = new Spider(scene, world);
  spiderCam = new SpiderCamera(camera);
  input = new Input(renderer.domElement, spiderCam);
  input.onReset = () => spider.reset();
  input.onJump = (boost) => spider.jump(boost);   // Space / JUMP button · +BOOST = forward lunge
} catch (err) {
  fatal('Init error: ' + (err && err.message ? err.message : err));
  console.error(err);
}

// ---------- tuning panel ----------
function buildPanel() {
  const sldWrap = document.getElementById('sliders');
  const defs = [
    { label: '速度', min: 1, max: 12, step: 0.5, get: () => spider.baseSpeed, set: (v) => (spider.baseSpeed = v) },
    { label: '离地高度', min: 1.5, max: 3.6, step: 0.05, get: () => spider.rideClear, set: (v) => (spider.rideClear = v) },
    { label: '抬脚高度', min: 0.2, max: 1.4, step: 0.05, get: () => spider.stepH, set: (v) => (spider.stepH = v) },
    { label: '步频', min: 0.6, max: 2.6, step: 0.05, get: () => spider.baseFreq, set: (v) => (spider.baseFreq = v) },
    { label: '转向速率', min: 0.6, max: 3.0, step: 0.1, get: () => spider.turnRate, set: (v) => (spider.turnRate = v) },
    { label: '步幅', min: 1.2, max: 3.4, step: 0.1, get: () => spider.maxStride, set: (v) => (spider.maxStride = v) },
    { label: '膝转范围', min: 0.5, max: 3.14, step: 0.05, get: () => TUNE.aRange, set: (v) => (TUNE.aRange = v) },
    { label: '膝转采样数', min: 2, max: 14, step: 1, get: () => TUNE.aSamp, set: (v) => (TUNE.aSamp = v) },
  ];
  const fmt = (v) => (Math.abs(v) >= 10 ? '' + Math.round(v) : (+v).toFixed(2));

  // IK SOLVER toggle — flip between the analytic two-bone solver and the decomposed
  // (length-then-aim) solver live, to compare how each shapes the spider's leg bends.
  {
    const row = document.createElement('div'); row.className = 'tog';
    const nm = document.createElement('span'); nm.textContent = 'IK 解算器';
    const val = document.createElement('b');
    const render = () => { val.textContent = TUNE.decomposed ? '分解式' : '解析式'; row.classList.toggle('on', !!TUNE.decomposed); };
    render();
    row.appendChild(nm); row.appendChild(val);
    row.addEventListener('click', () => { TUNE.decomposed = !TUNE.decomposed; render(); });
    row.addEventListener('pointerdown', (e) => e.stopPropagation());
    sldWrap.appendChild(row);
  }

  // BODY CONFORM toggle — body rides/tilts to the planted-feet support plane (climbs onto steps,
  // never sinks into rising ground). OFF reverts to the old single-sample-under-center behaviour.
  {
    const row = document.createElement('div'); row.className = 'tog';
    const nm = document.createElement('span'); nm.textContent = '身体贴合';
    const val = document.createElement('b');
    const render = () => { val.textContent = spider.bodyConform ? '开' : '关'; row.classList.toggle('on', !!spider.bodyConform); };
    render();
    row.appendChild(nm); row.appendChild(val);
    row.addEventListener('click', () => { spider.bodyConform = !spider.bodyConform; render(); });
    row.addEventListener('pointerdown', (e) => e.stopPropagation());
    sldWrap.appendChild(row);
  }

  // BODY FLEX toggle — the two-segment body bends at the pedicel (abdomen folds along walls, droops
  // over crests) instead of being a rigid blob. OFF locks the abdomen straight for comparison.
  {
    const row = document.createElement('div'); row.className = 'tog';
    const nm = document.createElement('span'); nm.textContent = '身体弯折';
    const val = document.createElement('b');
    const render = () => { val.textContent = spider.bodyFlex ? '开' : '关'; row.classList.toggle('on', !!spider.bodyFlex); };
    render();
    row.appendChild(nm); row.appendChild(val);
    row.addEventListener('click', () => { spider.bodyFlex = !spider.bodyFlex; render(); });
    row.addEventListener('pointerdown', (e) => e.stopPropagation());
    sldWrap.appendChild(row);
  }

  for (const d of defs) {
    const row = document.createElement('div'); row.className = 'sld';
    const lab = document.createElement('label'); const nm = document.createElement('span'); nm.textContent = d.label; const val = document.createElement('b'); val.textContent = fmt(d.get()); lab.appendChild(nm); lab.appendChild(val);
    const inp = document.createElement('input'); inp.type = 'range'; inp.min = d.min; inp.max = d.max; inp.step = d.step; inp.value = d.get();
    inp.addEventListener('input', () => { const v = parseFloat(inp.value); d.set(v); val.textContent = fmt(v); });
    inp.addEventListener('pointerdown', (e) => e.stopPropagation());
    row.appendChild(lab); row.appendChild(inp); sldWrap.appendChild(row);
  }
  const panel = document.getElementById('panel'), head = document.getElementById('panelHead'), tog = document.getElementById('panelTog');
  head.addEventListener('click', () => { panel.classList.toggle('closed'); tog.innerHTML = panel.classList.contains('closed') ? '+' : '&ndash;'; });
  panel.addEventListener('pointerdown', (e) => e.stopPropagation());
  if (TOUCH) { panel.classList.add('closed'); tog.innerHTML = '+'; }
}

// ---------- hud + loop ----------
if (spider) {
  buildPanel();
  document.getElementById('reset').addEventListener('click', () => spider.reset());
  document.getElementById('hint').textContent = TOUCH
    ? '左摇杆 · 移动     右侧拖动 · 视角     跳跃     加速（长按 + 跳跃 = 前扑）'
    : 'WASD · 移动     拖动 · 视角     滚轮 · 缩放     空格 · 跳跃     Shift · 加速（+空格 = 前扑）     R · 重置';

  const fpsEl = document.getElementById('fps'), spdEl = document.getElementById('spd'), gradeEl = document.getElementById('grade');
  const clock = new THREE.Clock();
  let fpsAcc = 0, fpsCnt = 0, fpsT = 0, crashed = false;

  window.__THREE_GAME_DIAGNOSTICS__ = {
    renderer: renderer.info,
    get state() {
      return {
        fps: fpsCnt && fpsAcc ? Math.round(fpsCnt / fpsAcc) : 0,
        spider: { pos: spider.pos.toArray().map((n) => +n.toFixed(2)), up: spider.up.toArray().map((n) => +n.toFixed(2)), speed: +spider.curSpeed.toFixed(2) },
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
      };
    },
  };

  function animate() {
    requestAnimationFrame(animate);
    if (crashed) return;
    const dt = Math.min(clock.getDelta(), 0.033);
    try {
      const inp = input.getInput();
      spider.update(dt, inp);
      world.updateDust(dt);
      spiderCam.update(dt, spider, input.dragging);
      renderer.render(scene, camera);
    } catch (err) { crashed = true; fatal('Runtime error: ' + (err && err.message ? err.message : err)); console.error(err); }
    fpsAcc += dt; fpsCnt++; fpsT += dt;
    if (fpsT > 0.4) {
      fpsEl.textContent = Math.round(fpsCnt / fpsAcc); spdEl.textContent = spider.curSpeed.toFixed(1);
      const uy = spider.up.y; const gr = uy > 0.93 ? '平地' : uy > 0.55 ? '斜坡' : uy > -0.3 ? '墙面' : '倒挂';
      gradeEl.textContent = gr; gradeEl.style.color = uy < 0.55 ? '#ff3bd4' : '#22d3ee';
      fpsAcc = 0; fpsCnt = 0; fpsT = 0;
    }
  }
  animate();
  addEventListener('resize', () => { camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); renderer.setSize(innerWidth, innerHeight); });

  // headless driver for hidden-tab verification (rAF pauses when tab is hidden)
  window.GOSSAMER = {
    scene, spider, world, camera, renderer, spiderCam, input,
    drive(steps = 60, ix = 0, iy = 1, sprint = false) {
      for (let i = 0; i < steps; i++) spider.update(1 / 60, { ix, iy, sprint, camYaw: spiderCam.yaw });
      world.updateDust(1 / 60); spiderCam.update(1 / 60, spider, false); renderer.render(scene, camera);
    },
  };
}
