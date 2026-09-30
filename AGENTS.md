# AGENTS.md — 给 AI 编码代理的硬约束与地雷

本文件面向**自动化编码代理**。它只写约束、约定与踩过的坑，不解释产品功能；
功能说明见 [README.md](./README.md)，结构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，流程见 [DEVELOPMENT.md](./DEVELOPMENT.md)。

---

## 0. 开始之前必读

```bash
pnpm install
pnpm typecheck   # 必须先为 0 错误
pnpm test        # 必须先全绿（基线 127 个用例）
```

改动完成后必须让下面三条同时通过，缺一不可：

```bash
pnpm typecheck && pnpm test && pnpm build
```

**不要**在没跑 `typecheck` 的情况下声称改完了。`noUnusedLocals` / `noUnusedParameters` 是打开的，
留下未使用的变量/参数会直接编译失败。

---

## 1. 项目不变量（违反即出 bug，不要绕过）

1. **`render/frameRenderer.ts` 的 `renderFrame` 必须是纯时间函数。**
   只依赖 `time`，不得读取上一帧状态、不得读墙钟时间、不得用 `Math.random()`。
   这是「预览与导出完全一致」和「离线逐帧导出」的前提。
   - 逐行歌词状态用 `LrcCursor.seek(time)` 确定性重放得到。
   - 特效粒子用固定种子的伪随机（`effects.ts` 内的 mulberry32），种子是 `(triggerIndex, particleIndex, 维度)`。

2. **事件位置只用「拍」，时间只用「秒」。** 两者之间唯一的换算入口是
   `core/timeline.ts` 的 `beatToSeconds` / `secondsToBeat`。
   **任何地方都不要自己写 `beat * 60 / bpm`** —— BPM 事件、暂停、强制行进都会让这个式子失效。

3. **内部拍号是 0 基，界面显示是 1 基。** 第 1 小节第 1 拍 = 绝对拍 `0`。
   界面上的「小节内第 N 拍」= `beat - span.startBeat + 1`。搞反会让逐拍歌词整行错位。

4. **`Project` 是不可变的。** 一切编辑走 `useStore.getState().commit(label, recipe)`，
   `recipe` 收到的是一份深拷贝 draft，可以随意就地改。直接改 `state.project` 会破坏撤销栈。

5. **小节拍数逐小节保存**（`Bar.beatCount`）。`timeline.beatsPerNewBar` 只是**新建小节时的默认值**，
   不约束已有小节。没有「替换全局拍数」这种标记（旧版本有 `replaceBeats`，已删除；
   序列化时会被忽略，见 `core/serialize.ts` 的 `readBar`）。

6. **`SpanStyle` 用颜色栈 `colors: string[]`**：1 个元素 = 纯色，多个 = 由上至下的渐变。
   `color` / `gradient` 两个旧字段已删除（反序列化时仍兼容读取，见 `readStyle`）。

7. **`BarDisplayConfig` 的缩放是 `scaleX` / `scaleY` 两个字段**，没有单一的 `scale`。
   序列化时若读到旧的 `scale`，会同时用作两者。

8. **播放循环里不要每帧写 zustand store。** `playback/controller.ts` 已把 store 同步降到约 15Hz；
   需要逐帧平滑的地方（进度条、画布、时间码）注册 `getPlayback().onFrame(fn)`。
   每帧写 store 会让所有订阅组件 60fps 重渲染，表现为画面卡顿。

---

## 2. 已经踩过的坑（务必不要重新引入）

| 症状 | 根因 | 现状 |
| --- | --- | --- |
| `secondsToBeat(2.25)` 返回 8 而不是 4.5，逐拍歌词整行错位 | 暂停判定写成「下一段 beat == 本段 endBeat」，这对**任何**相邻段都成立，于是每到小节边界就把播放头吸到下一小节 | 已修：必须同时满足「下一段是零宽退化段」且「已到达本段终点」。回归测试在 `core/engine.test.ts`（「秒 -> 拍 在小节边界处连续」） |
| 导入音乐后开头不播放 | 依赖 `AudioBufferSourceNode.start(when, offset)` 的原生延迟启动，同时播放头位置又用锚点推算，两者互相等待 | 已修：改为**立即启动 + 自己决定从音频哪一位置开始**；正偏移进入「无声等待」，`engine.tick()` 里等播放头追上起点再出声 |
| 逐行歌词块互相重叠 | 把 `lineSpacing`（块内子行距）当成了块间距 | 已修：`core/lrc.ts` 里块间距独立为 `blockGap`，并按每块**实际高度**堆叠 |
| 最后一行歌词被推到画布外、文本被裁 | 行高公式量纲写错（`axisH * 1.6` 应为 `textSize * 1.6`），且没为事件图标/文本预留空间 | 已修：`layoutBeatLyrics` 里 `aboveTextSpace` / `belowTextSpace` / `blockH` 全部按像素推导 |
| 时间轴上歌词字文本一直不显示 | `eventVisibility` 默认把 char 的 text 关掉了 | 已修：默认全部 `{icon:true, text:true}` |
| 在属性输入框里按退格把事件删了 | 全局 `Delete`/`Backspace` 快捷键没判断输入态 | 已修：`ui/App.tsx` 的 keydown 先算 `typing` 并提前 return |
| 特效粒子透明度先亮后暗，不单调 | 用了 sin² 钟形包络 | 已改成 `(1-t)²` 单调衰减（`render/effects.ts` 的 `alphaEnvelope`） |

---

## 3. 代码约定

- **注释与 UI 文案用简体中文**，标识符用英文。注释要写「为什么」，不要复述代码。
- `verbatimModuleSyntax: true` — 类型导入必须写 `import type`。
- `noUncheckedIndexedAccess` **关闭**，所以 `arr[i]` 不报可能为 undefined；但仍要自己防御空数组。
- 路径别名 `@/*` → `src/*`（`vite.config.ts` 与 `tsconfig.json` 都配了）。项目里既有相对导入也有别名，两种都可。
- 每个模块顶部写一段块注释说明**这个模块负责什么、不负责什么**。这是本项目的既有风格。
- 新增有实质逻辑的纯函数时，**同时给它写单元测试**。纯逻辑尽量放进 `core/` 或 `render/` 并保持不依赖 DOM，
  这样能在 node 环境下测试（现有 6 个测试文件全部运行在 node 环境，没有 jsdom）。

---

## 4. 目录归属（改代码前先看这里）

| 想改什么 | 去哪里 | 不要动 |
| --- | --- | --- |
| 拍↔秒换算、暂停、强制行进 | `core/timeline.ts` | 不要在各个消费方重复实现换算 |
| 逐行歌词状态机、版式 | `core/lrc.ts` | 绘制逻辑不在这个文件 |
| 富文本样式工具（颜色栈、span 增删） | `core/richText.ts` | — |
| 事件命中测试、重叠循环选择 | `core/eventHit.ts` | 不要在组件里重写这套判定 |
| 项目文件读写、素材导入、覆盖询问 | `core/storage.ts` | — |
| 序列化 / 兼容旧字段 | `core/serialize.ts` | — |
| 画面合成 | `render/frameRenderer.ts` | 不要在这里读 React state |
| 逐拍歌词版式与绘制 | `render/beatLyrics.ts` | 编辑器里的 DOM 轨道是另一处实现，改渲染要同步检查 |
| 富文本行绘制 | `render/richTextRenderer.ts` | 编辑器预览与播放画面共用它，改一处即改两处 |
| 播放时钟、音源调度 | `playback/engine.ts` | — |
| 播放循环、逐行歌词游标 | `playback/controller.ts` | — |
| 全局状态与撤销栈 | `state/store.ts` | 不要在组件里放跨组件共享状态 |
| 顶级交互（快捷键、右键屏蔽、自动保存） | `ui/App.tsx` | — |

---

## 5. 容易混淆的两套「逐拍」实现

逐拍歌词的绘制存在两份代码，**它们必须保持一致**：

1. `render/beatLyrics.ts` —— 播放页预览 + 视频导出用（Canvas）。
2. `ui/components/BeatLyricsEditor.tsx` —— 歌词编辑页的时间轴轨道（DOM + CSS）。

改「刻度长什么样、拍号画在哪、事件图标多大」时，**两处都要改**。
编辑器侧的视觉在 `styles.css` 的 `.axis-line` / `.beat-tick` / `.ev` 一节。

---

## 6. 反模式清单（不要这么做）

- ❌ 为了「顺手」把 `renderFrame` 改成读全局变量或上一帧结果。
- ❌ 用 `Math.random()` 生成特效粒子或任何要进导出的东西。
- ❌ 在 `state/store.ts` 之外 `set()` 项目数据绕过 `commit`（会丢撤销、丢自动保存）。
- ❌ 用 `MediaRecorder` 做视频导出。导出方案明确要求离线逐帧渲染 + WebCodecs 编码。
- ❌ 把用户素材写进 `src/` 或仓库；素材永远进项目目录的 `assets/`。
- ❌ 在时间轴上用「拍号相同」判断事件重叠。重叠必须按**指针处的实际图标矩形**判定。
- ❌ 给 `.ev-label` 之外的元素加 `pointer-events`，会挡住轨道上的指针交互。
- ❌ 直接改 `package.json` 的依赖版本；本项目对 `typescript@5.9`（不是 7.x）、`vite@8` 是固定组合。

---

## 7. 提交前自检

- [ ] `pnpm typecheck` 0 错误
- [ ] `pnpm test` 全绿（且没有 `.only` 残留）
- [ ] `pnpm build` 成功，且没有 `INEFFECTIVE_DYNAMIC_IMPORT` 警告
- [ ] 如果改了渲染：跑 `npx tsx tools/renderPreview.ts` 出帧目视检查 `out/*.png`
- [ ] 如果改了序列化：确认旧 `project.json` 仍能打开（`core/persist.test.ts` 有脏数据用例）
- [ ] 没有把 token、绝对本地路径、`node_modules`、`dist`、`out` 提交进去
