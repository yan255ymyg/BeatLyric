/**
 * 逐行歌词：状态机 + 版式计算
 *
 * 术语
 * ────
 *  - 「块」（用户口中的「行」）：LyricLine，可包含多个子行。
 *  - 主歌词（mainLine）：只有一块，决定垂直中心位置与突出显示。
 *  - 临时行（tempLines）：由「临时行开始 / 结束」事件驱动的副歌词块，
 *    它们会移动到主歌词行的下方（依次排列），与主歌词一起突出显示，
 *    并挤占其它未突出显示块的空间。
 *
 * 状态是**纯事件驱动**的：给定时间 t，从 0 开始按顺序重放所有逐行歌词事件即可
 * 得到确定的状态；这保证了拖动进度条、导出渲染、实时播放三者完全一致。
 */

import type { LyricLine, LrcDisplayConfig, Project, RichLine } from '../model/model';
import { beatToSeconds, buildTimeline, type Timeline } from './timeline';
import { clamp } from './util';

export interface LrcState {
  /** 当前主歌词块索引 */
  mainLine: number;
  /** 临时行块索引列表（保持进入顺序） */
  tempLines: number[];
  /** 已经应用到的逐行歌词事件序号（用于增量推进） */
  cursor: number;
}

export type LrcEventKind = 'prev' | 'next' | 'tempStart' | 'tempEnd';

export interface LrcEvent {
  /** 在时间轴事件中的序号 */
  index: number;
  kind: LrcEventKind;
  sec: number;
  beat: number;
  id: string;
  barIndex: number;
  /** 目标块（已在构建阶段解析为 0 基索引，可能越界） */
  target: number;
}

export const EMPTY_LRC_STATE: LrcState = { mainLine: 0, tempLines: [], cursor: 0 };

/* ------------------------------------------------------------------ */
/* 事件流                                                              */
/* ------------------------------------------------------------------ */

export function buildLrcEvents(project: Project, tl?: Timeline): LrcEvent[] {
  const timeline = tl ?? buildTimeline(project);
  const out: LrcEvent[] = [];
  const count = project.lines.length;
  const kinds: Partial<Record<string, LrcEventKind>> = {
    lrcPrev: 'prev',
    lrcNext: 'next',
    lrcTempStart: 'tempStart',
    lrcTempEnd: 'tempEnd',
  };
  let order = 0;
  timeline.spans.forEach((span) => {
    const lower = span.startBeat;
    const upper = span.startBeat + span.beatCount;
    for (const ev of span.bar.events) {
      const kind = kinds[ev.type];
      if (!kind) continue;
      if (!Number.isFinite(ev.beat) || ev.beat < lower - 1e-9 || ev.beat >= upper - 1e-9) continue;
      const data = ev.data as unknown as {
        offset?: number;
        mode?: 'rel' | 'abs';
        index?: number;
        indexMode?: 'zeroBased' | 'fromEnd';
      };
      let target = 0;
      if (kind === 'prev' || kind === 'next') {
        target = Math.max(0, Math.round(data.offset ?? 1)); // 相对偏移量，重放时按当前主行计算
      } else {
        // indexMode = 'fromEnd' 时使用 Python 风格负索引：-1 = 最后一块，-2 = 倒数第二块
        const raw = Math.round(data.index ?? 0);
        target = data.indexMode === 'fromEnd' ? (count > 0 ? count + raw : 0) : raw;
      }
      out.push({
        index: order++,
        kind,
        sec: beatToSeconds(timeline, ev.beat),
        beat: ev.beat,
        id: ev.id,
        barIndex: span.index,
        target,
      });
    }
  });
  // 以时间为准排序；同一时刻按声明顺序（稳定）
  out.sort((a, b) => (a.sec !== b.sec ? a.sec - b.sec : a.index - b.index));
  out.forEach((e, i) => {
    e.index = i;
  });
  return out;
}

function applyEvent(state: LrcState, ev: LrcEvent, lineCount: number): LrcState {
  const maxIndex = Math.max(0, lineCount - 1);
  if (ev.kind === 'prev' || ev.kind === 'next') {
    const dir = ev.kind === 'next' ? 1 : -1;
    const next = clamp(state.mainLine + dir * ev.target, 0, maxIndex);
    return { ...state, mainLine: next };
  }
  if (ev.kind === 'tempStart') {
    if (lineCount === 0) return state;
    const idx = clamp(ev.target, 0, maxIndex);
    // 主歌词块本身就是突出显示的，无需也不应再作为临时行
    if (idx === state.mainLine) return state;
    if (state.tempLines.includes(idx)) return state;
    return { ...state, tempLines: [...state.tempLines, idx] };
  }
  const idx = clamp(ev.target, 0, maxIndex);
  return { ...state, tempLines: state.tempLines.filter((x) => x !== idx) };
}

/** 从初始状态重放到 t（秒）时刻 */
export function lrcStateAt(project: Project, seconds: number, tl?: Timeline, events?: LrcEvent[]): LrcState {
  const evs = events ?? buildLrcEvents(project, tl);
  let state: LrcState = { ...EMPTY_LRC_STATE, tempLines: [] };
  const lineCount = project.lines.length;
  for (let i = 0; i < evs.length; i++) {
    if (evs[i].sec > seconds + 1e-9) break;
    state = applyEvent(state, evs[i], lineCount);
    state.cursor = i + 1;
  }
  return state;
}

/**
 * 增量游标：实时播放时按时间推进，仅在需要时应用事件。
 */
export class LrcCursor {
  private state: LrcState = { ...EMPTY_LRC_STATE, tempLines: [] };
  private events: LrcEvent[] = [];
  private lines: LyricLine[] = [];

  constructor(
    private project: Project,
    private tl: Timeline,
  ) {
    this.rebuild();
  }

  setProject(project: Project, tl: Timeline): void {
    this.project = project;
    this.tl = tl;
    this.rebuild();
  }

  private rebuild(): void {
    this.events = buildLrcEvents(this.project, this.tl);
    this.lines = this.project.lines;
    this.reset();
  }

  reset(): void {
    this.state = { ...EMPTY_LRC_STATE, tempLines: [] };
  }

  /** 跳到指定秒（确定性重放） */
  seek(seconds: number): LrcState {
    this.state = lrcStateAt(this.project, seconds, this.tl, this.events);
    return this.snapshot();
  }

  /** 推进到指定秒 */
  advance(seconds: number): LrcState {
    const lineCount = this.lines.length;
    while (this.state.cursor < this.events.length && this.events[this.state.cursor].sec <= seconds + 1e-9) {
      const ev = this.events[this.state.cursor];
      this.state = applyEvent(this.state, ev, lineCount);
      this.state.cursor += 1;
    }
    return this.snapshot();
  }

  snapshot(): LrcState {
    return { mainLine: this.state.mainLine, tempLines: [...this.state.tempLines], cursor: this.state.cursor };
  }
}

/* ------------------------------------------------------------------ */
/* 版式                                                                */
/* ------------------------------------------------------------------ */

export interface PlacedLine {
  lineIndex: number;
  /** 相对版式中心的垂直偏移（px，向下为正），指该块**中心** */
  y: number;
  /** 放大倍数 */
  scale: number;
  opacity: number;
  bold: boolean;
  color: string;
  /** 是否突出显示（主歌词或临时行） */
  highlighted: boolean;
  role: 'main' | 'temp' | 'context';
  /** 该块自身垂直高度（px，未缩放） */
  height: number;
}

export interface LrcLayout {
  placed: PlacedLine[];
  /** 版式总高度（px） */
  totalHeight: number;
  mainLine: number;
  tempLines: number[];
  /** 主歌词/临时行构成的突出区域相对中心的上边与下边（px） */
  highlightTop: number;
  highlightBottom: number;
}

/** 计算某个富文本行的像素高度（考虑 ruby 注音） */
export function richLineHeight(line: RichLine, fontSize: number, cfg: LrcDisplayConfig): number {
  let h = fontSize * 1.18;
  for (const span of line.spans) {
    const size = span.style?.fontSize ?? fontSize;
    const base = size * 1.18;
    const rubyH = span.style?.ruby ? size * cfg.rubyScale + cfg.rubyGap : 0;
    h = Math.max(h, base + rubyH);
  }
  return h;
}

export function lineBlockHeight(line: LyricLine, fontSize: number, cfg: LrcDisplayConfig): number {
  const subs = line.subLines.length ? line.subLines : [{ id: 'empty', spans: [] } as RichLine];
  let h = 0;
  subs.forEach((sub, i) => {
    h += richLineHeight(sub, fontSize, cfg);
    if (i < subs.length - 1) h += fontSize * (cfg.lineSpacing - 1.18);
  });
  return Math.max(fontSize, h);
}

/**
 * 依据 LrcState 与显示设置计算每一块的位置。
 *
 * 规则
 * ────
 *  - 主歌词块居中（y = 0），按 mainScale 放大。
 *  - 临时行块依次排布在主歌词块下方，同样突出显示并挤占空间。
 *  - 普通块：从主歌词行向上取 aboveCount 块、向下取 belowCount 块
 *    （只要不在突出集合中就参与），向下时自动跳过被临时行占用的名次位置。
 */
export function computeLrcLayout(
  lines: LyricLine[],
  state: LrcState,
  cfg: LrcDisplayConfig,
): LrcLayout {
  const placed: PlacedLine[] = [];
  const n = lines.length;
  if (!n) {
    return { placed, totalHeight: 0, mainLine: 0, tempLines: [], highlightTop: 0, highlightBottom: 0 };
  }

  const mainLine = clamp(state.mainLine, 0, n - 1);
  const tempLines = state.tempLines.filter((i, k, arr) => i >= 0 && i < n && i !== mainLine && arr.indexOf(i) === k);

  /**
   * 块间距。
   * 注意：`lineSpacing` 是**块内子行**的行距（见 lineBlockHeight），
   * 而块与块之间的间距必须另行给足，否则含多个子行的块会与相邻块重叠
   * （早期版本直接复用 lineSpacing 就踩到了这个坑）。
   * 因此块间距 = 主字号 × lineSpacing 的 0.45 倍 + 半行高，保证最小可读间隔。
   */
  const blockGap = cfg.fontSize * (0.45 + cfg.lineSpacing * 0.35);

  const hMain = lineBlockHeight(lines[mainLine], cfg.fontSize, cfg);
  placed.push({
    lineIndex: mainLine,
    y: 0,
    scale: cfg.mainScale,
    opacity: cfg.mainOpacity,
    bold: cfg.mainBold,
    color: cfg.mainColor,
    highlighted: true,
    role: 'main',
    height: hMain,
  });

  /* 临时行：依次排在主歌词块下方，与主歌词一起突出显示 */
  const tempGap = blockGap * Math.max(0.2, cfg.tempGapScale);
  let bandBottom = hMain / 2;
  const bandTop = -hMain / 2;
  tempLines.forEach((idx) => {
    const h = lineBlockHeight(lines[idx], cfg.fontSize, cfg);
    const y = bandBottom + tempGap + h / 2;
    placed.push({
      lineIndex: idx,
      y,
      scale: cfg.mainScale,
      opacity: cfg.tempOpacity,
      bold: cfg.mainBold,
      color: cfg.mainColor,
      highlighted: true,
      role: 'temp',
      height: h,
    });
    bandBottom = y + h / 2;
  });

  const highlight = new Set<number>([mainLine, ...tempLines]);

  // 向上：mainLine-1, -2, ...（跳过突出显示的块）
  const above: number[] = [];
  for (let i = mainLine - 1; i >= 0 && above.length < Math.max(0, Math.floor(cfg.aboveCount)); i--) {
    if (!highlight.has(i)) above.push(i);
  }

  // 向下：主行之后的第 1..belowCount 个「非突出显示」的块。
  // 临时行占用了主行下方的名次，因此它们整体被挤到更下面（见下方起始位置）。
  const below: number[] = [];
  const belowLimit = Math.max(0, Math.floor(cfg.belowCount));
  for (let i = mainLine + 1; i < n && below.length < belowLimit; i++) {
    if (highlight.has(i)) continue;
    below.push(i);
  }

  // 向上排布：用「已占用区域的上边缘」向上堆叠，避免子行多寡不同导致重叠
  let edge = bandTop - blockGap;
  above.forEach((idx) => {
    const h = lineBlockHeight(lines[idx], cfg.fontSize, cfg);
    placed.push({
      lineIndex: idx,
      y: edge - h / 2,
      scale: 1,
      opacity: cfg.inactiveOpacity,
      bold: cfg.bold,
      color: cfg.color,
      highlighted: false,
      role: 'context',
      height: h,
    });
    edge = edge - h - blockGap;
  });

  // 向下排布：从突出区域下沿开始堆叠（临时行已计入 bandBottom）
  edge = bandBottom + blockGap;
  below.forEach((idx) => {
    const h = lineBlockHeight(lines[idx], cfg.fontSize, cfg);
    placed.push({
      lineIndex: idx,
      y: edge + h / 2,
      scale: 1,
      opacity: cfg.inactiveOpacity,
      bold: cfg.bold,
      color: cfg.color,
      highlighted: false,
      role: 'context',
      height: h,
    });
    edge = edge + h + blockGap;
  });

  let totalHeight = 0;
  let highlightTop = 0;
  let highlightBottom = 0;
  placed.forEach((p) => {
    totalHeight = Math.max(totalHeight, Math.abs(p.y) + (p.height * p.scale) / 2);
    if (p.highlighted) {
      highlightTop = Math.min(highlightTop, p.y - (p.height * p.scale) / 2);
      highlightBottom = Math.max(highlightBottom, p.y + (p.height * p.scale) / 2);
    }
  });

  return { placed, totalHeight, mainLine, tempLines, highlightTop, highlightBottom };
}

/* ------------------------------------------------------------------ */
/* 富文本扁平化（供渲染器使用）                                          */
/* ------------------------------------------------------------------ */

export interface FlatSpan {
  text: string;
  bold: boolean;
  italic: boolean;
  colors?: string[];
  ruby?: string;
  fontSize?: number;
  dy: number;
}

export function flattenLine(line: RichLine, cfg: LrcDisplayConfig, forceBold: boolean): FlatSpan[] {
  const out: FlatSpan[] = [];
  for (const span of line.spans) {
    if (!span.text) continue;
    const st = span.style ?? {};
    out.push({
      text: span.text,
      bold: forceBold || !!st.bold,
      italic: !!st.italic,
      colors: st.colors,
      ruby: st.ruby,
      fontSize: st.fontSize,
      dy: st.dy ?? 0,
    });
  }
  if (!out.length) {
    out.push({ text: '', bold: cfg.bold || forceBold, italic: false, dy: 0 });
  }
  return out;
}

/** 块的纯文本（用于列表展示、搜索） */
export function linePlainText(line: LyricLine): string {
  return line.subLines
    .map((sub) => sub.spans.map((s) => s.text).join(''))
    .join('\n')
    .trim();
}
