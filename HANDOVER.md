# HANDOVER.md — 当前状态、未验证项与下一步

**交接时间点**：本文件写下时的仓库状态就是「可运行、可构建、测试全绿」。
新接手的人请先读 [AGENTS.md](./AGENTS.md) 的约束，再按 [DEVELOPMENT.md](./DEVELOPMENT.md) §5 过一遍手动清单。

---

## 1. 一句话现状

一个本地运行的 Web 应用，实现了「逐拍歌词 + 逐行歌词」的编辑、预览、以及**离线逐帧渲染 + WebCodecs 硬件编码**的视频导出。
类型检查 0 错误、**127 个单元测试全绿**、生产构建通过。
**但所有交互式 UI 行为都没有在真实浏览器里被人验证过**（见 §3）。

---

## 2. 已实现并验证的部分

### 2.1 有自动化验证的（这是可信的部分）

| 能力 | 验证方式 |
| --- | --- |
| 拍↔秒分段线性映射（BPM 事件 / 暂停 / 强制行进） | `core/engine.test.ts` 27 个用例，含 2 个真实缺陷的回归用例 |
| 逐行歌词状态机（上一句/下一句/临时行）与版式 | 同上 |
| 事件命中测试与重叠循环选择 | `core/eventHit.test.ts` 13 个用例 |
| 项目序列化往返 + 脏数据容错 + 素材同名覆盖策略 + ZIP 往返 | `core/persist.test.ts` 15 个用例 |
| FFT、频带映射、波形峰值、离线频谱确定性 | `media/spectrum.test.ts` 21 个用例 |
| 特效触发点、包络、粒子确定性、全局上限、性能 | `render/effects.test.ts` 27 个用例 |
| 编码探测降级、音频对齐裁切 | `export/capabilities.test.ts` 24 个用例 |
| **画面构图**（逐拍歌词版式、逐行歌词排版、频谱、特效） | `tools/renderPreview.ts` 在 Node 里用 `@napi-rs/canvas` 真实出帧，逐张目视检查过 |
| **旧版项目文件兼容性** | 已用一个旧结构样本（`beatsPerBar` + `replaceBeats` + `scale` + `color`/`gradient`）通过 `tools/checkCompat.ts` 实测：字段全部正确转换、无告警 |

> `tools/checkCompat.ts` 是通用工具，用来验证任意 `project.json` 是否还能被新代码解析：
> `npx tsx tools/checkCompat.ts <path/to/project.json>`。改动 `core/serialize.ts` 后建议用它回归一次。

### 2.2 功能清单（15 项需求的落地位置）

| # | 需求 | 落地位置 |
| --- | --- | --- |
| 1 | 逐行歌词禁止换行 | `ui/components/RichLineEditor.tsx` 的 `sanitizeSingleLine`；回车改为新建分段 |
| 2 | 去掉整体文本/整体样式；颜色改色阶；行内预览 | `core/richText.ts`（颜色栈）、`ui/components/RichLineEditor.tsx`、`render/richTextRenderer.ts` |
| 3 | 音乐导入清晰化 + 开头不播放 + 偏移同步 | `ui/components/TimelineToolbar.tsx` 的 `MusicBar`、`playback/engine.ts` |
| 4 | 拍序号在节拍开始处 | `render/beatLyrics.ts`（刻度画在拍位置，序号在刻度下方） |
| 5 | 面板可调宽高 | `ui/components/Splitter.tsx` + 两个 page 的 grid |
| 6 | 重叠事件循环选择 | `core/eventHit.ts`（纯函数 + 测试）、`BeatLyricsEditor` 的 `onPointerDown` |
| 7 | 图标辨识度 | `styles.css` 的 `.ev`（白描边 + 阴影）、`render/beatLyrics.ts` 的 `iconColorsOf` |
| 8 | 小节/事件选中分离 | `state/store.ts` 的 `selectedBarId` / `selectedEventIds`、`BarInspector.tsx` |
| 9 | 删掉「替换全局」 | `model.ts` 的 `beatsPerNewBar`、`serialize.ts` 的兼容读取 |
| 10 | 属性面板布局 + 滑块输入框 | `ui/components/common.tsx` 的 `Slider`（恒带 `NumberInput`） |
| 11 | 自定义吸附 1/N | `timeline.customSnap` + `BeatLyricsEditor` 的 `SnapPicker` + `BarInspector` |
| 12 | 逐拍歌词宽/高分开缩放 | `BeatDisplayConfig.scaleX` / `.scaleY` |
| 13 | 播放「乱动」修复 | `core/timeline.ts` 的 `secondsToBeat`（真 bug）+ `beatLyrics` 过渡动画 + `controller.ts` 降低 store 写入频率 |
| 14 | 右键屏蔽 / 批量删除 / 批量选择复制粘贴 | `ui/App.tsx`（全局 contextmenu 屏蔽 + 快捷键）、`BeatLyricsEditor`（右键滑动）、store 的剪贴板动作 |
| 15 | 退格误删事件 | `ui/App.tsx` 的 keydown 先判断 `typing` |

---

## 3. 未验证项（请优先确认这些）

**这台开发机器没有浏览器**，因此以下行为只经过代码审查 + 纯函数单测，
**手感与边界情况需要人在浏览器里过一遍**：

| 项 | 风险 | 怎么验 |
| --- | --- | --- |
| 拖动三个分隔条调整面板尺寸 | 中：grid 的 `minmax` 与像素列混用，窄窗口下可能溢出 | 把窗口缩到 1000px 宽再拖 |
| 按住右键在轨道上滑动批量删除 | 中：`document` 级 pointermove 与 `setPointerCapture` 的交互 | 快速滑过多个小节；滑出窗口再回来 |
| 同一位置反复点击循环重叠事件 | 中：命中容差 3px，图标密集时可能循环到意外的事件 | 故意叠三个事件在同一拍 |
| 富文本分段编辑器的键盘体验 | 中：回车新建分段后焦点没有自动移到新输入框 | 连按回车建多段 |
| 颜色栈 UI 的可用性 | 低 | 加/删色标、选预设 |
| `PosPad` 拖动设置归一化位置 | 低 | 拖动专辑图/逐拍歌词位置 |
| 自动保存（1.5s 防抖） | 低 | 改一下设置，等 2 秒，看顶栏是否变「已保存」 |
| 导出真实视频文件 | **高** | 见下 |

### 导出流程是最大的未验证区

`export/runExport.ts` + `export/exporter.ts` 的代码路径**从未端到端跑过一次**，因为需要浏览器 + 真实素材。
提交者已在 Node 里验证过 mediabunny 的构造路径（`Mp4OutputFormat` + `CanvasSource` + `AudioBufferSource`
+ `addVideoTrack/addAudioTrack` 能通过），但那不等于完整导出可用。

**建议的验证顺序**：

1. 用一个 10 秒内的短音频 + 1080p30 + 低码率先跑通，确认能下载出可播放的 MP4；
2. 再验 WebM（VP9 + Opus）；
3. 再验带视频背景的导出（这条最容易出问题，因为要走逐帧 seek）；
4. 最后验 4K60（确认内存与编码器压力）。

如果导出失败，先看 `export/capabilities.ts` 的 `resolveCodecs` 是否回退到了预期组合，
以及浏览器控制台里 mediabunny / WebCodecs 的报错。

---

## 4. 已知缺口与技术债

按建议处理顺序排列。

### 4.1 应该尽快处理

1. **逐拍歌词有两份实现，改视觉要改两处。**
   `render/beatLyrics.ts`（Canvas，预览+导出）与 `ui/components/BeatLyricsEditor.tsx` + `styles.css`（DOM，编辑器）。
   目前刻度宽度、高度倍率等常量在两边是**各写一遍**的（`iconHeightScale` vs `eventDisplayHeight`）。
   → 建议把「事件图标尺寸/颜色的计算」抽成共享的纯函数放进 `core/`，两边都调它。

2. **`lyricsTab` 是死状态。** `state/store.ts` 里有 `lyricsTab` 与 `setLyricsTab`，但没有任何 UI 读写它。
   → 要么接一个「逐拍/逐行」切换标签，要么删掉。

3. **导出没有取消按钮之外的中断恢复。** 导出中途关页面会丢进度（这是可接受的，但要知道）。

4. **没有 CI。** 每次改动靠人跑 `pnpm typecheck && pnpm test && pnpm build`。
   → 加一个 GitHub Actions 工作流（Node 22 + pnpm 8）成本很低。

### 4.2 体验上的已知不足

5. **火星飘落的粒子从画布中上部整体飘落**，没有定位到触发它的那个歌词字身上。
   原因：`TriggerPoint` 里没有字的位置信息（`effects.ts` 的设计）。
   → 要改的话，需要给触发点加坐标字段，并同步改 `EffectsPlan` 的构造。

6. **导出的 MP4 在 Firefox 上不可用**（没有 `VideoEncoder`）。UI 会提示，但无法降级。
   → 可选：集 `ffmpeg.wasm` 做服务端/客户端转码，或做实时录制的降级路径（后者被明确否决过，需先问产品）。

7. **视频背景导出时逐帧 seek**，速度取决于磁盘与解码器。素材很长时会慢。
   → 文档里提过：把素材先转成帧内编码（all-intra）能显著提速。

8. **`tools/` 不在 `tsconfig.include` 里**，因此工具脚本的类型错误不会被 `pnpm typecheck` 拦住。
   → 要么加进 include，要么接受这个风险（当前选择后者）。

9. **富文本编辑器不能像普通文本框那样拖选后套样式。** 这是刻意的设计取舍
   （contenteditable 的 DOM 与 span 模型无法一一对应，会让数据被浏览器覆盖），
   代价是必须先点分段再设样式。

### 4.3 未实现的产品特性

10. 频谱没有波形叠加层（只画频谱本身）。
11. 撤销栈上限 120 步，超出会丢最早的（`state/store.ts` 的 `HISTORY_LIMIT`）。
12. 没有「多选后同时编辑多个事件属性」的批量面板（多选只支持移动/删除/复制）。
13. 没有键盘微调（选中事件后用方向键挪一拍）。加这个会比较受欢迎。

---

## 5. 建议的下一步（给接手的 agent）

如果只有时间做一件事：**在浏览器里把 §3 的清单和导出流程走通**，
因为那是唯一没有自动化覆盖、且最可能已经坏了的部分。

如果要做功能：

1. 抽共享的「事件图标几何」纯函数，消除第 4.1.1 条的双实现风险；
2. 加 GitHub Actions（typecheck + test + build），把质量线自动化；
3. 加方向键微调选中事件（小改动、高收益）；
4. 处理 `lyricsTab` 死状态（要么接上，要么删）。

---

## 6. 交接检查表

- [x] `pnpm install` 可重现（有 `pnpm-lock.yaml`）
- [x] `pnpm typecheck` 0 错误
- [x] `pnpm test` 127/127 通过
- [x] `pnpm build` 成功、无警告
- [x] `npx tsx tools/renderPreview.ts` 能出图（无浏览器环境下的唯一画面验证手段）
- [x] `.gitignore` 排除了 `node_modules` / `dist` / `out`
- [x] 文档齐全：`README.md`（功能）、`ARCHITECTURE.md`（结构）、`AGENTS.md`（约束）、
      `DEVELOPMENT.md`（流程）、`HANDOVER.md`（本文件）
- [ ] **在真实浏览器里验证过 §3 的交互清单** ← 留给接手的第一次任务
- [ ] **跑通过一次完整导出** ← 留给接手的第二次任务
