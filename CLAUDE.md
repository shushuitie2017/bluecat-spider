# 蓝猫蜘蛛（bluecat-spider）— 项目说明

纯数学驱动的**自稳定程序化蜘蛛** web app：8 条腿闭式逆运动学（IK）实时解算，能在任意地形行走、爬墙、倒挂、起跳——无动画、无骨骼、无物理引擎。Vite + Three.js（`three` 是唯一运行时依赖）。

## 运行

```bash
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # → dist/（纯静态，可丢任意静态托管）
pnpm preview
```

需 Node 18+。

## 结构

```
index.html            canvas + HUD + 调参面板骨架
src/
  main.js             bootstrap：渲染器、场景、相机、调参面板、渲染循环
  core/dynamics.js    数学层：向量、缓动、两骨 IK 解算器
  core/Input.js       键盘 + 触屏摇杆 → { ix, iy, sprint, camYaw }
  world/terrain.js    闭式地形高度场 + 精确法线
  world/collision.js  解析碰撞体（球/盒）、raycast、余隙
  world/World.js      场景搭建：灯光、天空、地形、障碍、尘埃
  spider/Spider.js    蜘蛛本体：身体控制器、步态、腿、IK、探足
  camera/SpiderCamera.js  防穿模第三人称跟随相机
  ui/styles.css       HUD、调参面板、触控样式
docs/preview-cn.png   README 用截图
```

`Spider.js` 保留了几个附加“游戏钩子”（空中/牵引摆荡模式等），在本 sandbox 里是惰性的——原样保留以保证运动代码与原始版本一致。

## 中文化范围（已完成）

- UI 全中文：HUD（帧率/速度/地面等级 平地·斜坡·墙面·倒挂）、按钮（重置/加速/跳跃）、调参面板（调参 + 8 个滑块 + 3 个开关 IK 解算器/身体贴合/身体弯折）、操作提示。
- README、index.html meta、package.json 中文化。
- `src/**` 深层代码注释仍为英文（面向开发者）。

## 无头 API（自动化测试 / 隐藏标签页）

```js
window.GOSSAMER.drive(steps=60, ix=0, iy=1, sprint=false);  // 固定 1/60 步进推进
window.GOSSAMER.spider / .world / .renderer;                 // live 句柄
window.__THREE_GAME_DIAGNOSTICS__.state;                     // { fps, spider, drawCalls, triangles }
```

## 维护者校验

改完 UI/逻辑跑一遍 `pnpm build` 确认无语法错误；改视觉后浏览器实测（rAF 在后台标签会暂停，用 `GOSSAMER.drive()` 手动推进再截图）。
