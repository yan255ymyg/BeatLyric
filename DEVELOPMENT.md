# DEVELOPMENT.md — 环境、命令、调试与验证

硬约束见 [AGENTS.md](./AGENTS.md)，结构见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

---

## 1. 环境要求

| 项目 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 20（开发时用 22.19） | `tsx`、Vite 8 需要 |
| 包管理器 | pnpm 8+（开发时用 8.15） | 仓库有 `pnpm-lock.yaml` |
| 浏览器 | **Chrome / Edge 114+** | 项目目录读写用 File System Access API，导出用 WebCodecs |
| 系统字体 | 需要有中文字体 | 画布文字用 `Noto Sans CJK SC` / `Microsoft YaHei` / `PingFang SC` 字体栈 |

Firefox 可以编辑与预览，但**不能导出视频**（没有 `VideoEncoder`），导出面板会给出中文提示。

### 依赖里被刻意固定的版本

| 依赖 | 版本 | 为什么固定 |
| --- | --- | --- |
| `typescript` | `5.9.x` | npm 上的 latest 是 7.x（原生编译器），与本项目的 `vite@8` + `@vitejs/plugin-react@6` 组合未验证。**不要升级** |
| `vite` | `8.x` | 与 `typescript@5.9`、`vitest@5` 匹配 |
| `react` | `19.x` | 用了 React 19 的行为 |
| `mediabunny` | `1.61.x` | 导出封装。它是 mp4-muxer 的官方后继，API 见其 `.d.ts` |
| `zustand` | `5.x` | store 用的 `create` |

---

## 2. 命令

```bash
pnpm install          # 安装依赖
pnpm dev              # 开发服务器 http://127.0.0.1:5178（strictPort）
pnpm typecheck        # tsc --noEmit
pnpm test             # vitest run（单次）
pnpm test:watch       # vitest 监听
pnpm build            # tsc --noEmit && vite build → dist/
pnpm preview          # 预览构建产物
```

**改完代码的最低验证线**：

```bash
pnpm typecheck && pnpm test && pnpm build
```

当前基线：`typecheck` 0 错误，`test` **127 个用例全绿**（6 个测试文件），`build` 无警告。

单跑某个测试文件：

```bash
npx vitest run src/core/engine.test.ts
npx vitest run -t "暂停把后续事件整体推后"      # 按用例名过滤
```

---

## 3. 测试策略

所有测试跑在 **node 环境**（`vite.config.ts` 里 `test.environment: 'node'`，没有 jsdom）。
因此测试必须只覆盖**不依赖 DOM** 的逻辑。

| 测试文件 | 覆盖内容 |
| --- | --- |
| `core/engine.test.ts` | ★ 拍↔秒换算、BPM 事件、暂停、强制行进、小节布局、逐行歌词状态机与版式、**两个回归用例**（小节边界连续、暂停区间静止） |
| `core/eventHit.test.ts` | 事件命中测试、重叠循环选择、`sendToBack` |
| `core/persist.test.ts` | `project.json` 往返、脏数据容错、素材导入与同名覆盖策略、文件名清洗、ZIP 往返、sha256 |
| `media/spectrum.test.ts` | FFT 正确性、频带映射、波形峰值、峰值编解码、离线频谱确定性 |
| `render/effects.test.ts` | 触发点收集、各特效包络、粒子确定性、全局上限、**性能自检** |
| `export/capabilities.test.ts` | 预设、编码探测降级、`sliceAudioBuffer` 对齐 |

### 怎么测需要 DOM 的东西

- **纯逻辑**：抽成不依赖 DOM 的函数放进 `core/` 或 `render/`，再写普通单测。
  `core/eventHit.ts` 就是这么从组件里抽出来的。
- **画布渲染**：用 `tools/` 下的脚本在 node 里真实出图（见下一节），而不是写断言式测试。
- **音频**：`AudioBuffer` 可以用桩对象（只要有 `length` / `sampleRate` / `numberOfChannels` / `getChannelData`），
  见 `media/spectrum.test.ts`。
- 不要为了测试引入 jsdom —— 会带来一批「测试通过但浏览器里坏」的假安全感。

---

## 4. 无浏览器渲染验证（本项目的杀手锏）

`renderFrame` 是纯时间函数，所以可以在 Node 里用 [`@napi-rs/canvas`](https://github.com/Brooooooklyn/canvas)
真实执行它并导出 PNG。**这是在没有浏览器的环境里检查构图的最有效手段。**

```bash
npx tsx tools/renderPreview.ts
# 输出 out/frame-<时间>.png，并打印逐拍歌词版式的关键数值
```

脚本会：

1. 造一个演示项目（4 拍×3 小节、歌词字带渐变与 ruby、暂停/BPM/强制行进事件、6 块逐行歌词）；
2. 用最小 DOM 垫片让 `canvasKit` 的字体测量能跑（`document.createElement('canvas')` → napi canvas）；
3. 在若干时间点（0 / 0.45 / 0.9 / 1.35 / 1.8 / 2.6 / 3.2 / 4.0 / 4.8 秒）各渲染一帧并写 PNG；
4. 在 t=4.0 打印每行的 `y / rowHeight / axisHeight` 与每个事件的 `x / axisY / textY`。

**什么时候用它**：

- 改了任何 `render/` 下的文件之后。
- 排查「文字位置不对 / 被裁掉 / 重叠」这类问题：把打印出来的数值与实际 PNG 对照，
  比在浏览器里猜快得多。历史上「最后一行被推到画布外」就是这么定位的。
- 想在 PR 里附画面证据时。

生成文档用截图（压缩成 JPEG）：

```bash
npx tsx tools/makeScreenshots.ts     # → docs/screenshots/*.jpg
```

验证旧版项目文件兼容性（改动 `core/serialize.ts` 后建议回归一次）：

```bash
npx tsx tools/checkCompat.ts path/to/project.json
# 会打印解析后的 timeline / 小节拍数 / 颜色栈 / 逐行歌词事件等关键字段
```

> **`tools/` 不在 `tsconfig.json` 的 `include` 里，因此 `pnpm typecheck` 不会检查它们。**
> 它们只通过 `npx tsx` 运行（tsx 只做类型擦除，不做类型检查）。
> 这意味着脚本里的类型错误不会在 CI/本地校验里暴露 —— 改 `tools/` 后必须**实际跑一次**确认能出图：
>
> ```bash
> npx tsx tools/renderPreview.ts     # 必须打印「渲染验证完成。」且 out/ 里有 PNG
> ```
>
> 如果希望脚本也纳入类型检查，把 `tools` 加进 `tsconfig.json` 的 `include`；
> 目前刻意不加，是为了避免开发工具的错误阻塞应用代码的验证。

---

## 5. 手动验证清单（浏览器里）

改完 UI 后按顺序过一遍，能覆盖绝大多数回归：

1. `pnpm dev` → 打开 http://127.0.0.1:5178
2. 顶栏「打开项目」选一个空文件夹 → 状态从「内存项目」变成「已保存 HH:MM:SS」
3. 顶部音乐条点「导入音乐文件…」→ 波形出现；点波形能定位播放头
4. 点「音乐开场对准播放头」把偏移设成负值，再按空格 → **从播放头位置立刻出声**（这是曾经坏过的地方）
5. 把偏移改成正值（比如 3000ms），回到开头按空格 → 前 3 秒无声但**播放头照常前进**，到 3 秒时出声
6. 逐拍歌词区双击轨道插入歌词字 → 时间轴出现刻度位置上的图标，文本在正下方
7. 在同一位置连点两次歌词字 → 若与其它事件重叠，应在它们之间循环
8. 按住右键在轨道上横向滑动 → 扫过的事件变红；松开 → 一起删除；`Ctrl+Z` 能恢复
9. `Ctrl+点击` 选两个事件 → `Ctrl+C` → 选另一个小节 → `Ctrl+V` → 事件粘到该小节
10. 点小节背景 → 属性面板只显示小节属性；点事件 → 只显示事件属性
11. 把某小节拍数从 4 改成 8 → 该小节刻度间距变密，点「自动对齐 + 居中」后与其它小节一致
12. 逐行歌词：新增块 → 点一个分段输入文字 → 顶部预览即时更新；按回车 → 新建下一段（不产生换行符）
13. 分段「＋色」加第二个颜色 → 预览变成渐变
14. 播放编辑页：拖动左/右/下方三个分隔条 → 面板尺寸变化；双击复位
15. 逐拍歌词面板：分别调「横向缩放 X」与「纵向缩放 Y」→ 只有对应方向变化
16. 导出面板：选 1080p60 / MP4 → 开始导出 → 进度到 100% 后下载文件

---

## 6. 常见问题排查

| 现象 | 先查什么 |
| --- | --- |
| 打开项目后所有设置恢复默认 | `core/serialize.ts` 的 `readPlayback` / `readBar` / `readEvent` / `readStyle` 是否漏了新字段 |
| 播放时画面卡顿、播放头抖 | 是否有代码在播放循环里 `set()` store（应该用 `getPlayback().onFrame`） |
| 播放头位置与音频对不上 | `timeline.audioOffsetMs` 的符号；`AudioEngine.audioStartSec` 的日志 |
| 导出画面与预览不一致 | `renderFrame` 是否被引入了外部状态（读 store、读上一帧、`Math.random()`） |
| 导出面板报 WebCodecs 不支持 | 浏览器是不是 Chrome/Edge 114+；`export/capabilities.ts` 的 `hasWebCodecsVideoEncoder()` |
| `pnpm build` 报 chunk > 500 kB | 这是警告不是错误（mediabunny + React 合计约 690 kB / gzip 202 kB）。要消除就做代码分割 |
| 构建出现 `INEFFECTIVE_DYNAMIC_IMPORT` | 某个模块既被静态导入又被动态导入。改成静态导入 |
| 中文字体显示成方块 | 系统缺中文字体；`render/canvasKit.ts` 的 `CJK_FONT_STACK` 里补一个可用字体 |

---

## 7. 构建产物

```
dist/
├── index.html
└── assets/
    ├── index-<hash>.css
    └── index-<hash>.js     约 690 kB / gzip 约 202 kB
```

注意 `apps/web` 那套 Vite 入口只构建外壳，**不是**独立应用（需要 `dsh web` 注入 `window.__DSH_BOOT__`）——
本项目与它无关，本项目的 `dist/` 是完整可用的静态站点，但**必须通过 http(s) 提供**，
不能直接 `file://` 打开（ES module 与 File System Access API 都需要 secure context）。

```bash
pnpm build
pnpm preview            # http://127.0.0.1:4173
```

或者任意静态服务器指向 `dist/`。`navigator.clipboard` / `crypto.subtle` / `showDirectoryPicker`
都要求 secure context，所以 `localhost` 或 https 是必须的。
