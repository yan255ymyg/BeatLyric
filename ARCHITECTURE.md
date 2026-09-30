# ARCHITECTURE.md — 模块地图与数据流

面向需要**改动或扩展**本项目的开发者。只讲结构与为什么这样分层。
硬约束见 [AGENTS.md](./AGENTS.md)，命令见 [DEVELOPMENT.md](./DEVELOPMENT.md)，功能说明见 [README.md](./README.md)。

---

## 1. 全局数据流

```
                        ┌──────────────────────────────────────────┐
    用户操作 ──commit──▶ │  state/store.ts   (zustand, 不可变 Project) │
                        │  + 撤销栈 + WeakMap<Timeline> 缓存          │
                        └───────────────┬──────────────────────────┘
                                        │ project
              ┌─────────────────────────┼─────────────────────────┐
              ▼                         ▼                         ▼
      ui/ (React 组件)          core/timeline.ts           core/lrc.ts
      歌词编辑页 / 播放编辑页     拍 ↔ 秒 分段线性映射        逐行歌词状态机 + 版式
              │                         │                         │
              │ 每帧 onFrame            ▼                         ▼
              └──────────────▶ render/frameRenderer.ts ◀──── LrcCursor.seek(time)
                                        │
                        ┌───────────────┴───────────────┐
                        ▼                               ▼
              播放页预览（canvas, dpr 缩放）      导出（canvas 1:1, 逐帧）
```

**关键点**：预览与导出走的是**同一个** `renderFrame()`。
`export/runExport.ts` 只是准备了另一套资源（离屏 canvas、逐帧 seek 的视频、离线频谱）
并按 `i / fps` 调它。所以画面一致性是结构保证的，不是靠两边手动对齐。

---

## 2. 目录职责

### `model/` — 纯类型，无逻辑

| 文件 | 内容 |
| --- | --- |
| `model.ts` | `Project` / `Bar` / `BeatEvent` / `LyricLine` / `SpanStyle` / `PlaybackConfig` 等全部类型、`EVENT_META` 元信息表、`SNAP_DIVISIONS` |
| `playerDefaults.ts` | 画布预设、背景预设 |

`Project` 是整个应用的唯一真源（single source of truth），其余一切都是它的派生。

### `core/` — 与 UI 无关的核心逻辑（可在 node 里测）

| 文件 | 职责 | 明确不做的事 |
| --- | --- | --- |
| `timeline.ts` | ★ 拍↔秒换算、小节结构（`BarSpan`）、时间轴段表（`Seg`）、事件时间（`TickEvent`）、小节横向布局（`computeBarLayout`）、强制行进冲突检测 | 不画任何东西；不认识 UI |
| `lrc.ts` | ★ 逐行歌词事件流、状态机（`LrcCursor`）、版式计算（`computeLrcLayout`）、块高计算 | 不画任何东西 |
| `richText.ts` | 颜色栈 → 画布填充、span 增删改、文本增量重建 | 不做 DOM |
| `eventHit.ts` | ★ 事件命中测试、重叠循环选择、`sendToBack` | 不访问 DOM，坐标由调用方传入 |
| `factories.ts` | 默认值、工厂函数 | — |
| `serialize.ts` | `project.json` 读写、**不信任磁盘内容**的逐字段校验、旧字段兼容 | 不做文件 IO |
| `storage.ts` | File System Access 目录抽象（`DirectoryLike`）、素材导入与同名覆盖策略、ZIP 打包 | 不解析项目数据 |
| `util.ts` | clamp / uid / 格式化 / 深拷贝 | — |

### `media/` — 素材处理

| 文件 | 职责 |
| --- | --- |
| `decode.ts` | 音频解码（共享 `AudioContext`）、波形峰值、峰值 base64 编解码 |
| `spectrum.ts` | 自实现 radix-2 FFT、对数频带映射、**离线 STFT**（`OfflineSpectrum`，可按任意 t 求值）、实时分析器包装 |
| `audio.ts` | `sliceAudioBuffer`：按时间轴裁切 / 补静音，供导出编码音频 |
| `videoFrame.ts` | `VideoFrameProvider`：导出时逐帧串行 seek 取视频帧 |
| `albumArt.ts` | 封面加载、光碟纹理、圆形遮罩（带缓存） |

离线频谱是这个目录里最容易被忽视的一环：**导出时不能用实时 `AnalyserNode`**，
因为导出的帧不是按墙钟时间产生的。

### `render/` — Canvas 绘制（预览与导出共用）

| 文件 | 职责 |
| --- | --- |
| `canvasKit.ts` | 字体测量与缓存、圆角矩形、描边文字、`prepareCanvas`（按 dpr 设画布） |
| `richTextRenderer.ts` | ★ 一行富文本的绘制（颜色栈渐变、粗体、斜体、ruby）；**编辑器预览与播放画面共用** |
| `beatLyrics.ts` | ★ 逐拍歌词版式（主轴/刻度/事件/文本/播放头/过渡动画）与绘制 |
| `lrcRenderer.ts` | 逐行歌词块绘制（调用 `richTextRenderer`） |
| `spectrumRenderer.ts` | 频谱绘制，数据源抽象为 `SpectrumSource`（实时/离线都实现它） |
| `effects.ts` | ★ 特效引擎：触发点预计算、包络、确定性粒子、全局粒子上限 |
| `frameRenderer.ts` | ★ 画面合成器：按图层顺序把上面这些画到一张画布上 |
| `timelineHelpers.ts` | 渲染层需要的少量 timeline 转出（避免渲染层依赖编辑器专用东西） |

### `playback/`

| 文件 | 职责 |
| --- | --- |
| `engine.ts` | `AudioEngine`：`AudioContext` + `AudioBufferSourceNode`；位置用 `ctx.currentTime` 锚点推进；处理「音乐等播放头 / 播放头等音乐」 |
| `controller.ts` | 单例 `PlaybackController`：rAF 循环、逐行歌词游标、`onFrame` 逐帧回调、把 store 同步降到 ~15Hz |
| `duration.ts` | 时间轴 / 可播放时长的计算与时间码格式化 |

### `export/`

| 文件 | 职责 |
| --- | --- |
| `capabilities.ts` | 用 `isConfigSupported` 探测编码器、容器回退链（mp4: h264→hevc→av1→vp9；webm: vp9→av1）、音频回退（aac 不可用整体转 webm+opus） |
| `exporter.ts` | `exportVideo()`：逐帧 `await canvasSource.add(t, 1/fps)`（自带背压）+ `AudioBufferSource` + 关键帧 + 封装 |
| `runExport.ts` | 编排：准备渲染资源（视频 seek、离线频谱、专辑图）、按时间轴对齐音频、逐帧渲染回调、进度 |

**没有 `MediaRecorder` 路径**，这是被明确否决的方案。

### `state/store.ts` — 全局状态

zustand store。公开的字段与动作（节选，完整列表见文件里的 `AppState`）：

```ts
// 数据
project: Project
directory: DirectoryLike          // 当前项目目录（磁盘或内存）
persisted / dirty / lastSavedAt

// 选中（小节与事件是两套独立状态）
selectedBarId: string | null
selectedEventIds: string[]
selectedLineId: string | null
clipboard: BeatEvent[]
snap: number                      // >0 = 1/snap；0 = 用 timeline.customSnap

// 播放
playing / positionSec / previewFollow

// 编辑
commit(label, recipe)             // 一切编辑的唯一入口（产生新 Project + 压撤销栈）
undo() / redo()
addBar / removeBar / moveBar / setBarBeatCount / setBarTransform
addEvent / updateEvent / removeEvent / removeEvents / moveEvent
addLine / removeLine / duplicateLine / moveLine
updatePlayback / updateEffect / addEffect / removeEffect

// 事件批量操作
selectEvent(id, additive?) / selectEvents(ids) / clearEventSelection()
copySelectedEvents() / pasteEvents(targetBarId?) / deleteSelectedEvents()

// 派生
getTimeline(project)              // WeakMap 缓存，Project 不可变所以永远有效
useTimeline() / useSelectedBar() / computeForceConflicts()
```

**为什么 `Project` 不可变**：撤销/重做只需要保存对象引用，不需要 diff；`getTimeline` 可以用
`WeakMap<Project, Timeline>` 缓存，且绝不会读到过期结果。

### `ui/` — React 组件

```
ui/
├── App.tsx                     外壳：页面切换、全局快捷键、右键屏蔽、自动保存、冲突弹窗
├── assetUrls.ts                素材 Blob → object URL 缓存（画布/视频用）
├── audioBridge.ts              音频资源 → AudioBuffer 缓存（解码很贵，只做一次）
├── waveformBridge.ts           波形峰值缓存（落盘到 cache/peaks-*.json）
├── importer.ts                 批量导入素材 + 统一提示
├── usePlayerRenderer.ts        播放页渲染循环（订阅 onFrame，不触发 React 重渲染）
├── pages/
│   ├── LyricsEditorPage.tsx    歌词编辑页（左逐拍 / 右逐行，中间可拖分割条）
│   └── PlayerEditorPage.tsx    播放编辑页（左设置 / 中舞台 / 右状态，都可拖）
└── components/
    ├── Header.tsx              顶栏：项目名、页面切换、播放控制、进度条
    ├── TimelineToolbar.tsx     音乐条 + 全局设置（BPM / 新增小节拍数 / 偏移 / 吸附 / 素材库）
    ├── BeatLyricsEditor.tsx    ★ 逐拍歌词时间轴（DOM 实现，与 render/beatLyrics 需保持视觉一致）
    ├── LineLyricsEditor.tsx    逐行歌词块列表
    ├── RichLineEditor.tsx      ★ 富文本行编辑器（分段 + 颜色栈 + 行内预览）
    ├── BarInspector.tsx        ★ 属性检查器（小节属性 / 事件属性分流显示）
    ├── ColorStackEditor.tsx    通用颜色栈编辑器
    ├── Splitter.tsx            可拖分割条
    ├── EventGlyph.tsx          事件小图标（SVG）
    ├── common.tsx              Field / NumberInput / Slider / PosPad / Modal / Section …
    ├── Toasts / ConflictDialog / ProgressOverlay
    └── player/                 播放页各设置面板（画布/专辑图/逐拍/逐行/视频/特效/频谱/导出）
```

---

## 3. 三个核心机制

### 3.1 拍 ↔ 秒的分段线性映射

`core/timeline.ts` 把整条时间轴压成一张**段表** `Seg[]`，每段形如：

```ts
{ beat, sec, spb, endBeat, endSec, forceEventId? }
//  sec = seg.sec + (beat - seg.beat) * spb        spb = 秒/拍
```

段的来源有三类：

| 来源 | 段的行为 |
| --- | --- |
| 普通播放 | `spb = 60 / bpm`，`bpm` 由「设置 BPM」事件改变 |
| 强制行进 | 一段被压缩/拉伸的区间：`spb = ms / 1000 / lengthBeats` |
| 暂停 | **零宽退化段**：`endBeat === beat`，`endSec === sec`，紧接着下一段的 `sec` 已经加上暂停毫秒 |

暂停为什么用零宽段而不是「段中间挖洞」？因为这样整张表仍然是「按 beat 升序、按 sec 升序」的单调表，
二分查找与线性扫描都成立。代价是 `secondsToBeat` 必须显式处理暂停窗口
（当前段结束到下一段开始之间就是暂停时长，此时播放头应停在暂停所在的拍）。

查询语义：

- `beatToSeconds(tl, beat)` —— **取暂停之前的时刻**（播放头刚到达暂停点），用于定位事件。
- `beatToSecondsAfter(tl, beat)` —— **取暂停之后的时刻**，用于导出时判断「这段已经播完」。
- `secondsToBeat(tl, sec)` —— 在暂停窗口内返回暂停所在的拍（播放头静止）。

`BarSpan` 是在拍轴上首尾相接的小节视图：`[startBeat, startBeat + beatCount)`，
小节内第 1 拍 = `startBeat` = 该小节时间轴的第 0 秒。

### 3.2 渲染是纯时间函数

```ts
renderFrame(ctx, project, timeline, time, resources, { width, height, layoutScale, lrcState })
```

- `time` 是唯一的动态输入。
- `lrcState` 由 `LrcCursor.seek(time)` 确定性重放事件得到（`core/lrc.ts`）。
- `resources.spectrum` 是一个 `SpectrumSource`；实时预览传 `RealtimeSpectrum`，导出传 `OfflineSpectrum`。
- `resources.effects` 是预计算的 `EffectsPlan`，`at(time)` 也是纯函数。
- 图层顺序：背景色 → 视频背景 → 专辑图 → 频谱 → 逐拍歌词 → 逐行歌词 → 闪光 → 粒子。
  整体特效变换（缩放/抖动）套在中间五层外面。

**为什么必须这样**：离线逐帧导出没有「上一帧」的概念，也没有真实的帧间隔。
只要渲染依赖任何外部状态，导出结果就会和预览不一致。

### 3.3 颜色栈

```ts
interface SpanStyle {
  colors?: string[];   // 1 个 = 纯色；多个 = 由上至下的渐变
  bold?; italic?; ruby?; fontSize?; dy?;
}
```

绘制入口是 `core/richText.ts` 的 `fillForColors(ctx, colors, x, top, bottom, fallback)`。
`fontSize` 存的是「占基准字号的百分比」，`dy` 是像素 —— 这样同一份数据在任意画布尺寸下都成立
（预览与导出各自传入自己的基准字号）。

---

## 4. 项目文件格式

```
<项目目录>.blsp/
├── project.json          # 唯一真源；逐字段校验，缺字段用默认值
├── assets/               # 导入的图片/音频/视频（保持原始文件名）
└── cache/
    └── peaks-4096.json   # 波形峰值缓存（可删，会自动重建）
```

`project.json` 顶层：

```jsonc
{
  "formatVersion": 1,
  "meta":     { "name", "artist", "createdAt", "updatedAt", "appVersion" },
  "timeline": { "bpm", "beatsPerNewBar", "audioOffsetMs", "defaultSnap", "customSnap" },
  "canvas":   { "width", "height", "background", "gradient?" },
  "assets":   { "<assetId>": { "id","kind","file","originalName","mime","size","sha256",... } },
  "audioAssetId": "<assetId>|null",
  "peaksFile": "cache/peaks-....json|null",
  "bars":     [ { "id","beatCount","transform":{"scaleX","offsetX"},"events":[...] } ],
  "lines":    [ { "id","label?","align?","subLines":[ { "id","align?","spans":[...] } ] } ],
  "playback": { "album","beat","lrc","video","spectrum","effects","export","followPlayhead","followMainLine" }
}
```

**向后兼容**：`core/serialize.ts` 会读旧字段并转换 ——
`beatsPerBar` → `beatsPerNewBar`、`Bar.replaceBeats`（忽略）、
`SpanStyle.color` / `.gradient` → `colors`、`BeatDisplayConfig.scale` → `scaleX` + `scaleY`。
新增字段时**必须**同时更新 `readPlayback` / `readBar` / `readEvent` / `readStyle`，
否则用户下次打开项目时新设置会静默丢失。

事件位置 `BeatEvent.beat` 存的是**全局拍号**（第 1 小节第 1 拍 = 0）。

---

## 5. 扩展指南

### 加一种新事件类型

1. `model/model.ts`：加入 `BeatEventType` 联合、`EventTypeMeta`（icon/label/hint）、
   `EVENT_META` 表项、数据接口，并把该类型并进 `BeatEvent` 联合。
2. `core/factories.ts`：`defaultEventData()` 加分支。
3. `core/serialize.ts`：`readEvent()` 加分支（这是最容易漏的一步）。
4. `render/beatLyrics.ts`：`iconHeightScale` / `iconWidth` / `iconColorsOf` / `eventLabelText` / `drawEventIcon` 各加分支。
5. `ui/components/EventGlyph.tsx`：加 SVG 图标。
6. `ui/components/BarInspector.tsx`：`EventInspector` 里加参数编辑。
7. 如果它会驱动逐行歌词，还要改 `core/lrc.ts` 的 `buildLrcEvents` + `applyEvent`。
8. 跑 `npx tsx tools/renderPreview.ts` 目视确认。

### 加一种特效

1. `model/model.ts` 的 `EffectType` 加类型；
2. `render/effects.ts`：加包络函数 + `applyEffect` 分支（记得保持纯函数、确定性）；
3. `ui/components/player/EffectsPanel.tsx`：加标签与提示；
4. `render/effects.test.ts`：加用例（尤其是确定性与「寿命结束后消失」）。

### 加一个播放页设置面板

1. `model/model.ts` 的 `PlaybackConfig` 加字段 + 类型；
2. `core/factories.ts` 的 `defaultPlayback()` 给默认值；
3. `core/serialize.ts` 的 `readPlayback` 加读取（**不要漏**）；
4. `ui/components/player/` 新建面板，并在 `pages/PlayerEditorPage.tsx` 的 `TABS` 注册；
5. 渲染层在 `render/frameRenderer.ts`（或对应子模块）里消费它。

---

## 6. 已知的设计取舍

| 取舍 | 原因 | 代价 |
| --- | --- | --- |
| 导出用 WebCodecs，不做实时录制 | 画质与设备性能解耦 | Firefox 不支持 `VideoEncoder`，导出面板会提示 |
| 逐拍歌词渲染有两份实现（Canvas + DOM） | 编辑器需要可点可拖的 DOM 元素，导出需要 Canvas | 改视觉要同步两处，见 AGENTS.md §5 |
| 富文本编辑器用「分段列表 + 顶部预览」而不是 contenteditable | contenteditable 的 DOM 与 span 模型无法一一对应，会互相覆盖 | 不能在正文里直接拖选套样式；改用「选中分段 → 设样式」 |
| 音频偏移是「音频时间 = 播放头时间 + offset」 | 与视频偏移、`playhead = audio - offset` 的直觉一致 | 正值表示音频延后，容易被读反；UI 里有文字说明 |
| `project.json` 由应用自动保存（1.5s 防抖） | 减少心智负担 | 需要一个落盘目录；无 File System Access 时退化为内存项目 + ZIP 导出 |
