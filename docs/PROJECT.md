# bluecat-spider（蓝猫蜘蛛）接手文档

> 更新：2026-07-12。依据：本仓库 CLAUDE.md / README.md / package.json / vite.config.js / .github/workflows/deploy.yml / LICENSE / src 实际目录。

## §定位与状态

**蓝猫蜘蛛**：纯数学驱动的自稳定程序化蜘蛛 web app——8 条腿两骨闭式逆运动学（IK）实时解算，能在任意地形行走、爬墙、倒挂、起跳；身体随坡度/墙面/悬垂自动倾斜并在腰部弯折。**无动画片段、无骨骼绑定、无物理引擎**，地形是闭式高度场公式、碰撞是距离函数，每帧现算。约 1200 行 / 8 模块。

- **fork 关系**：这是一个开源程序化蜘蛛项目的**中文改编版**（UI 全中文化 + 去外链 + 新中文 README）。依 MIT 归属红线，上游作者版权只保留在 `LICENSE` 首行版权行，正文/README 不具名、不外链原仓库；改编方为蓝猫 BlueCat（LICENSE 第二行）。
- **状态**：**已完成并上线**（2026-07-05），GitHub Pages demo 浏览器实测 60fps。`Spider.js` 里保留了几个惰性的"游戏钩子"（空中/牵引摆荡模式），刻意不删以保证运动代码与上游一致。

## §技术架构

| 类别 | 选择 |
|------|------|
| 渲染 | Three.js ^0.169（WebGL，`three` 是唯一运行时依赖） |
| 构建 | Vite ^5.4（`base: './'` 路径相对，dist/ 可丢任意静态托管；`target: 'es2020'`） |
| 语言 | 原生 ES module JavaScript（无 TypeScript、无框架） |
| 环境 | Node 18+，pnpm（锁文件 pnpm-lock.yaml，CI 用 pnpm 8） |

渲染/工程要点：
- 核心是**解析式**管线：闭式地形高度场（可采精确高度+法线）→ 身体控制器（支撑平面 + 上方向随表面法线混合，实现爬墙/倒挂）→ 交替步态状态机（脚固定在世界坐标，超步幅阈值触发迈步）→ 两骨闭式 IK + 膝摆避障搜索。
- IK 解算器可在面板切换 `解析式` ↔ `分解式` 两种解法。
- 相机：防穿模第三人称跟随（几何体挡镜头时自动拉近）。
- **无头 API**（自动化测试/后台标签页 rAF 暂停时用）：`window.GOSSAMER.drive(steps, ix, iy, sprint)` 固定 1/60 步进推进；`window.GOSSAMER.spider/.world/.renderer` live 句柄；`window.__THREE_GAME_DIAGNOSTICS__.state` 取 fps/drawCalls 等。
- 中文化边界：UI（HUD/按钮/调参面板/提示）全中文；`src/**` 深层代码注释保留英文。

## §目录说明

```
index.html                     canvas + HUD + 调参面板骨架
src/
├── main.js                    bootstrap：渲染器/场景/相机/调参面板/渲染循环
├── core/dynamics.js           数学层：向量、缓动、两骨 IK 解算器
├── core/Input.js              键盘 + 触屏摇杆 → { ix, iy, sprint, camYaw }
├── world/terrain.js           闭式地形高度场 + 精确法线
├── world/collision.js         解析碰撞体（球/盒）、raycast、余隙
├── world/World.js             场景搭建：灯光/天空/地形/障碍/尘埃
├── spider/Spider.js           蜘蛛本体：身体控制器/步态/腿/IK/探足
├── camera/SpiderCamera.js     防穿模第三人称跟随相机
└── ui/styles.css              HUD、调参面板、触控样式
vite.config.js                 base './' + es2020 + outDir dist
package.json / pnpm-lock.yaml  依赖清单（three 唯一运行时依赖）
docs/preview-cn.png            README 首屏用预览截图（原位保留，README 相对路径引用）
docs/PROJECT.md                本文档
public/.nojekyll, public/og.jpg  Pages 防 Jekyll 吞下划线文件 + OG 图
dist/                          本地构建产物（已 gitignore；线上由 CI 构建）
assets/contact-qr.jpg          README 作者名片微信二维码
CLAUDE.md / README.md / LICENSE  项目说明 / 落地页式中文 README / MIT（上游版权行+改编行）
.github/workflows/deploy.yml   GitHub Pages 构建+部署
.gitignore                     排除 node_modules/dist/servers.json/HANDOFF.md 等
```

## §本地运行

```bash
pnpm install
pnpm dev          # http://localhost:5173
pnpm build        # → dist/（纯静态，可丢任意静态托管）
pnpm preview      # 本地预览生产构建（:4173）
```

需 Node 18+。维护者校验约定（CLAUDE.md）：改完 UI/逻辑跑一遍 `pnpm build` 确认无语法错误；改视觉后浏览器实测——后台标签页 rAF 会暂停，用 `GOSSAMER.drive()` 手动推进再截图。

## §部署

- **线上**：https://shushuitie2017.github.io/bluecat-spider/ （GitHub Pages）。依据：README「在线体验」链接 + toys 项目 HANDOFF.md 的上线记录。
- **形态**：GitHub Actions 构建部署（`.github/workflows/deploy.yml`）——push `main` 或 `workflow_dispatch` 触发：pnpm 8 + Node 20 → `pnpm install --frozen-lockfile` → `pnpm build` → `upload-pages-artifact path: dist` → `deploy-pages`。CI 的 pnpm 版本须与锁文件对齐（=8，勿乱升）。
- 首次开通须在仓库 Settings → Pages → Source 手选 **GitHub Actions**（一次性，已完成）。
- 本项目**不部署到任何服务器**，故无 servers.json（.gitignore 里预防性排除了该文件名，但仓库中不存在此文件）。
