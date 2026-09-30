/**
 * 时间轴引擎
 *
 * 设计要点
 * ─────────
 * 1. 双时基。事件位置永远以「拍」表示；音频、导出、播放头以「秒」表示。
 * 2. 秒 ↔ 拍的映射是**分段线性**的：
 *      - 普通段落：1 拍耗时 60/bpm 秒（bpm 由 bpm 事件更改）
 *      - 强制行进段：一段被压缩/拉伸的拍区间，播放头用指定毫秒匀速走完
 *      - 暂停点：拍轴上宽度为 0，但在秒轴上占 ms 毫秒 —— 播放头原地不动
 *    这样「暂停」和「强制行进」都自然成为时间映射的一部分：播放头、逐拍歌词、
 *    逐行歌词、导出渲染全部共用同一套映射，天然一致。
 * 3. 拍号约定（0 基内部表示 / 1 基界面表示）：
 *      - 小节在拍轴上首尾相接：[startBeat, startBeat + beatCount)
 *      - 小节内第 1 拍 = 绝对拍 startBeat，也就是该小节时间轴的第 0 秒
 *      - 用户在界面上看到的是「小节内第 1..beatCount 拍」，显示时 +1
 *    这样 beat * 60/bpm 就是时间，第一拍恰好落在 t=0，节拍数与秒数两者都不需要补偿。
 */

import type { Bar, BeatEvent, BeatEventType, Project } from '../model/model';
import { clamp, stableSortBy } from './util';

export interface BarSpan {
  index: number;
  id: string;
  /** 本小节第 1 拍（= 该小节时间轴第 0 秒）在全局拍轴上的位置 */
  startBeat: number;
  beatCount: number;
  bar: Bar;
}

export interface BarBeatSlot {
  index: number;
  /** 全局拍号 = startBeat + index + 1 */
  beat: number;
  /** 矩形左边（相对小节可用宽度的比例，0..1） */
  left: number;
  /** 矩形宽度（比例） */
  width: number;
  /** 该拍所属等分格子的左边与宽度（用于默认时铺满整行） */
  cellLeft: number;
  cellWidth: number;
}

export interface BarLayout {
  barIndex: number;
  /** 时间轴区域相对小节可用宽度的比例 [0,1]，由小节的时间轴变换决定 */
  frameFrac: { left: number; width: number };
  beats: BarBeatSlot[];
}

export interface Seg {
  /** 段起始拍 */
  beat: number;
  /** 段起始秒 */
  sec: number;
  /** 秒每拍（该段的斜率）：sec = seg.sec + (beat - seg.beat) * spb */
  spb: number;
  endBeat: number;
  endSec: number;
  /** 若该段来自强制行进事件，记录其 id */
  forceEventId?: string;
}

export interface TickEvent {
  id: string;
  type: BeatEventType;
  barIndex: number;
  barId: string;
  /** 小节内相对拍（第 1 拍 = 1） */
  beatInBar: number;
  /** 全局拍号 */
  beat: number;
  /** 持续时间（拍），点事件为 0 */
  durationBeats: number;
  sec: number;
  /** force 事件：覆盖区间的结束秒；其它事件等于 sec */
  endSec: number;
  event: BeatEvent;
}

export interface BpmEvent {
  beat: number;
  sec: number;
  bpm: number;
  eventId: string;
}

export interface Timeline {
  spans: BarSpan[];
  segs: Seg[];
  ticks: TickEvent[];
  /** 与 ticks 等长、逐项对应的事件发生秒（便于二分） */
  eventSecs: Float64Array;
  bpmEvents: BpmEvent[];
  /** 存在「暂停」事件的拍位置（暂停点在拍轴上宽度为 0） */
  pauseBeats: number[];
  totalBeats: number;
  endSec: number;
  /** 全局初始 bpm */
  initialBpm: number;
}

/* ------------------------------------------------------------------ */
/* 小节结构                                                            */
/* ------------------------------------------------------------------ */

export function buildBarSpans(project: Project): BarSpan[] {  const spans: BarSpan[] = [];
  let cursor = 0;
  project.bars.forEach((bar, index) => {
    const beatCount = Math.max(1, Math.round(bar.beatCount));
    spans.push({
      index,
      id: bar.id,
      startBeat: cursor,
      beatCount,
      bar,
    });
    cursor += beatCount;
  });
  return spans;
}

/** 一小节内允许的最大位置（不含）：startBeat + beatCount */
export function barUpperBound(span: BarSpan): number {
  return span.startBeat + span.beatCount;
}

/** 一小节内允许的最小位置（含）：startBeat */
export function barLowerBound(span: BarSpan): number {
  return span.startBeat;
}

/** 找到 beat 所属的小节（小节在拍轴上首尾相接，半开区间 [startBeat, startBeat+beatCount)） */
export function barSpanOfBeat(spans: BarSpan[], beat: number): BarSpan | null {
  if (!spans.length) return null;
  for (let i = spans.length - 1; i >= 0; i--) {
    if (beat >= spans[i].startBeat - 1e-9) return spans[i];
  }
  return spans[0];
}

export function barSpanById(spans: BarSpan[], id: string): BarSpan | null {
  return spans.find((s) => s.id === id) ?? null;
}

/* ------------------------------------------------------------------ */
/* 构建                                                                */
/* ------------------------------------------------------------------ */

interface FlatEvent {
  beat: number;
  order: number;
  event: BeatEvent;
  span: BarSpan;
}

function collectEvents(spans: BarSpan[]): FlatEvent[] {
  const out: FlatEvent[] = [];
  let order = 0;
  for (const span of spans) {
    const upper = barUpperBound(span);
    const lower = barLowerBound(span);
    for (const ev of span.bar.events) {
      // 越界事件不参与时间计算（用户把节拍数改小后可能残留）
      if (!Number.isFinite(ev.beat) || ev.beat < lower - 1e-9 || ev.beat >= upper - 1e-9) continue;
      order += 1;
      out.push({ beat: ev.beat, order, event: ev, span });
    }
  }
  return stableSortBy(out, (e) => e.beat);
}

export function buildTimeline(project: Project): Timeline {
  const spans = buildBarSpans(project);
  const totalBeats = spans.reduce((acc, s) => acc + s.beatCount, 0);
  const initialBpm = project.timeline.bpm > 0 ? project.timeline.bpm : 120;
  const flat = collectEvents(spans);

  let curBeat = 0;
  let curSec = 0;
  let curBpm = initialBpm;
  const segs: Seg[] = [];
  const bpmEvents: BpmEvent[] = [];

  const bps = () => (curBpm > 0 ? curBpm / 60 : initialBpm / 60);

  /**
   * 把时间从 curBeat 推进到 beat（拍轴上的一段）。
   * 若 beat 已到达，则不再推进。
   */
  const advance = (beat: number) => {
    if (beat <= curBeat + 1e-12) return;
    const spb = 1 / bps();
    curSec += (beat - curBeat) * spb;
    segs.push({ beat: curBeat, sec: curSec - (beat - curBeat) * spb, spb, endBeat: beat, endSec: curSec });
    curBeat = beat;
  };

  for (const fe of flat) {
    advance(clamp(fe.beat, curBeat, totalBeats));

    const ev = fe.event;
    if (ev.type === 'bpm') {
      const nb = (ev.data as { bpm: number }).bpm;
      if (Number.isFinite(nb) && nb > 0) curBpm = nb;
      bpmEvents.push({ beat: fe.beat, sec: curSec, bpm: curBpm, eventId: ev.id });
    } else if (ev.type === 'pause') {
      const ms = Math.max(0, (ev.data as { ms: number }).ms);
      // 暂停：在拍轴上宽度为 0，但秒轴上推进 ms。
      // 先补一个退化段（起始秒 = 暂停前），再把时间推后，这样
      //   beatToSeconds(暂停点) = 暂停之前，暂停之后的段起始秒 = 暂停后。
      segs.push({ beat: curBeat, sec: curSec, spb: 1 / bps(), endBeat: curBeat, endSec: curSec });
      curSec += ms / 1000;
    } else if (ev.type === 'force') {
      const d = ev.data as { lengthBeats: number; ms: number };
      const maxLen = barUpperBound(fe.span) - fe.beat;
      const len = clamp(Number.isFinite(d.lengthBeats) ? d.lengthBeats : 0, 1e-6, Math.max(1e-6, maxLen));
      const ms = Math.max(1, Number.isFinite(d.ms) ? d.ms : 1);
      const spb = ms / 1000 / len;
      const endBeat = fe.beat + len;
      const endSec = curSec + ms / 1000;
      segs.push({ beat: curBeat, sec: curSec, spb, endBeat, endSec, forceEventId: ev.id });
      curBeat = endBeat;
      curSec = endSec;
    }
  }

  advance(totalBeats);

  if (!segs.length) {
    segs.push({ beat: 0, sec: 0, spb: 60 / initialBpm, endBeat: 0, endSec: 0 });
  }

  const endSec = Math.max(...segs.map((s) => s.endSec), 0);

  const pauseBeats = flat.filter((fe) => fe.event.type === 'pause').map((fe) => fe.beat);

  const ticks: TickEvent[] = flat
    .filter((fe) => fe.event.type === 'pause' || fe.event.type === 'force')
    .map((fe) => {
      const sec = secondsOfBeatIn(segs, fe.beat, pauseBeats);
      const ev = fe.event;
      let durationBeats = 0;
      let endSecValue = sec;
      if (ev.type === 'force') {
        const maxLen = barUpperBound(fe.span) - fe.beat;
        const d = ev.data as { lengthBeats: number; ms: number };
        const len = clamp(Number.isFinite(d.lengthBeats) ? d.lengthBeats : 0, 1e-6, Math.max(1e-6, maxLen));
        durationBeats = len;
        endSecValue = secondsOfBeatIn(segs, fe.beat + len, pauseBeats);
      }
      return {
        id: ev.id,
        type: ev.type,
        barIndex: fe.span.index,
        barId: fe.span.id,
        beatInBar: fe.beat - fe.span.startBeat,
        beat: fe.beat,
        durationBeats,
        sec,
        endSec: endSecValue,
        event: ev,
      };
    });

  const eventSecs = new Float64Array(ticks.length);
  ticks.forEach((t, i) => {
    eventSecs[i] = t.sec;
  });

  return { spans, segs, ticks, eventSecs, bpmEvents, pauseBeats, totalBeats, endSec, initialBpm };
}

/**
 * 找到「最早出现该拍」的段。
 *
 * 段采用半开区间 [seg.beat, seg.endBeat)，正常情况下取最后一个 seg.beat <= beat 的段；
 * 但暂停会在同一拍上产生「零宽退化段」（暂停前的段 + 暂停后的段），
 * 此时取最左匹配，使 beatToSeconds(暂停点) 返回暂停之前的时刻。
 */
/**
 * 找到「最早出现该拍」的段（最左匹配）。
 *
 * 段采用半开区间 [seg.beat, seg.endBeat)，正常情况下最左匹配就是包含该拍的段。
 * 暂停会在同一拍上产生两段（暂停前的零宽退化段 + 暂停后的段），
 * 取最左匹配即可使 beatToSeconds(暂停点) 返回「暂停之前」的时刻。
 */
/**
 * 找到「最早出现该拍」的段（最左匹配）。
 *
 * 段采用半开区间 [seg.beat, seg.endBeat)，正常情况下最左匹配即包含该拍的段。
 * 暂停会在同一拍上产生两段（暂停前的零宽退化段 + 暂停后的段），
 * 取最左匹配即可使 beatToSeconds(暂停点) 返回「暂停之前」的时刻。
 *
 * 注：段的数量等于「事件数 + 1」，通常只有几十到几百个，
 * 这里刻意使用朴素线性扫描，避免二分边界带来的隐患。
 */
function findSegByBeatFirst(segs: Seg[], beat: number): Seg {
  const target = beat;
  let resultIndex = 0;
  for (let i = segs.length - 1; i >= 0; i = i - 1) {
    const cand: number = segs[i].beat;
    if (cand <= target) {
      resultIndex = i;
      break;
    }
  }
  return segs[resultIndex];
}

/** 找到「该拍最后一段」（最右匹配），用于取暂停之后的时刻 */
function findSegByBeatLast(segs: Seg[], beat: number): Seg {
  let found = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].beat <= beat + 1e-9) found = i;
    else break;
  }
  return segs[found];
}

/**
 * 秒 -> 段下标。
 *
 * 取最后一个 `seg.sec <= sec` 的段，但**暂停窗口**是个例外：
 * 暂停在拍轴上宽度为 0，因此会产出「零宽退化段」
 * （sec = 暂停前、endSec = sec 的那一段，以及紧随其后从暂停结束时刻开始的段）。
 * 当 sec 落在暂停时长内（`[segs[i].endSec, segs[i+1].endSec]` 且两段同拍）时，
 * 播放头应当停在暂停所在的拍上，因此这里返回**暂停之前的那一段**。
 */
function findSegIndexBySec(segs: Seg[], sec: number): number {
  let found = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].sec <= sec + 1e-9) found = i;
    else break;
  }
  const s = segs[found];
  const next = segs[found + 1];
  if (
    next &&
    next.endSec > next.sec + 1e-12 &&
    Math.abs(next.beat - s.endBeat) < 1e-9 &&
    sec >= s.endSec - 1e-9 &&
    sec <= next.endSec + 1e-9
  ) {
    // 处在暂停时长内：回到暂停之前的那一段
    const prev = segs[found - 1];
    if (prev && Math.abs(prev.endBeat - s.beat) < 1e-9) return found - 1;
  }
  return found;
}

/** 秒 -> 段：取最后一个 seg.sec <= sec 的段 */
function findSegBySec(segs: Seg[], sec: number): Seg {
  return segs[findSegIndexBySec(segs, sec)];
}

function secondsOfBeatIn(segs: Seg[], beat: number, pauseBeats?: number[]): number {
  if (!segs.length) return 0;
  const s = findSegByBeatFirst(segs, beat);
  // 暂停点：拍轴上宽度为 0，取「暂停之前」的时刻更符合直觉
  // （播放头刚到达该处；之后在暂停时长内保持不动）。
  if (pauseBeats) {
    for (let i = 0; i < pauseBeats.length; i++) {
      if (Math.abs(pauseBeats[i] - beat) < 1e-9) {
        // 找到该拍上最早的段
        for (let k = 0; k < segs.length; k++) {
          if (Math.abs(segs[k].beat - beat) < 1e-9) return segs[k].sec;
        }
      }
    }
  }
  return s.sec + (beat - s.beat) * s.spb;
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

/** 拍 -> 秒（暂停点取暂停之前，即播放头刚到达该处） */
export function beatToSeconds(tl: Timeline, beat: number): number {
  return secondsOfBeatIn(tl.segs, beat, tl.pauseBeats);
}

/** 拍 -> 秒（暂停点取暂停之后，用于导出时「该拍已经播完」的判定） */
export function beatToSecondsAfter(tl: Timeline, beat: number): number {
  const segs = tl.segs;
  if (!segs.length) return 0;
  if (beat <= segs[0].beat + 1e-9) return segs[0].sec + (beat - segs[0].beat) * segs[0].spb;
  const e = findSegByBeatLast(segs, beat);
  return e.sec + (beat - e.beat) * e.spb;
}

/** 秒 -> 拍（暂停区间内返回暂停所在的拍，即播放头静止） */
export function secondsToBeat(tl: Timeline, sec: number): number {
  const segs = tl.segs;
  if (!segs.length) return 0;
  if (sec <= segs[0].sec + 1e-9) return segs[0].beat + (sec - segs[0].sec) / segs[0].spb;
  if (sec >= tl.endSec - 1e-9) return tl.totalBeats;
  const index = findSegIndexBySec(segs, sec);
  const s = segs[index];
  /**
   * 暂停：暂停在拍轴上宽度为 0，因此在时间轴上表现为一个「零宽退化段」
   * （`endSec === sec`，且与本段结束于同一拍）。此时必须把播放头**停在暂停所在的拍**，
   * 否则它会滑到下一拍，导致音频还在暂停、画面已经前进。
   *
   * 这里判断的是「紧跟的下一段是零宽段」。早期版本只判断
   * 「下一段的 beat 等于本段 endBeat」，那对**任何**相邻段都成立，
   * 结果每到小节边界就把播放头提前吸到下一小节
   * （`secondsToBeat(2.25)` 曾错误返回 8 而不是 4.5，逐拍歌词整行错位）。
   */
  const next = segs[index + 1];
  if (
    next &&
    next.endSec <= next.sec + 1e-12 &&
    Math.abs(next.beat - s.endBeat) < 1e-9 &&
    // 必须「已经到达本段终点」，否则会把暂停点之前的整段都吸到暂停点上
    sec >= s.endSec - 1e-9
  ) {
    return s.endBeat;
  }
  return clamp(s.beat + (sec - s.sec) / s.spb, 0, Math.max(0, tl.totalBeats));
}

export interface SegInfo {
  seg: Seg;
  index: number;
  /** 段内归一化进度 0..1 */
  t: number;
}

export function segmentAtSeconds(tl: Timeline, sec: number): SegInfo {
  const segs = tl.segs;
  if (!segs.length) return { seg: { beat: 0, sec: 0, spb: 1, endBeat: 0, endSec: 0 }, index: 0, t: 0 };
  const seg = sec <= segs[0].sec + 1e-9 ? segs[0] : findSegBySec(segs, sec);
  const index = segs.indexOf(seg);
  const dur = seg.endSec - seg.sec;
  const t = dur > 1e-9 ? clamp((sec - seg.sec) / dur, 0, 1) : 0;
  return { seg, index, t };
}

export function secondsToBar(tl: Timeline, sec: number): BarSpan | null {
  return barSpanOfBeat(tl.spans, secondsToBeat(tl, sec));
}

/** 秒 -> 所在小节以及小节内的拍进度（0 表示第 1 拍位置） */
export function locate(tl: Timeline, sec: number): { span: BarSpan; barProgress: number; beat: number } | null {
  const beat = secondsToBeat(tl, sec);
  const span = barSpanOfBeat(tl.spans, beat);
  if (!span) return null;
  return { span, barProgress: clamp(beat - span.startBeat, -1, span.beatCount + 1), beat };
}

export function barSeconds(tl: Timeline, span: BarSpan): { startSec: number; endSec: number } {
  return {
    startSec: beatToSeconds(tl, span.startBeat),
    endSec: beatToSeconds(tl, span.startBeat + span.beatCount),
  };
}

/* ------------------------------------------------------------------ */
/* 小节时间轴布局                                                       */
/* ------------------------------------------------------------------ */

/**
 * 计算一小节时间轴的横向布局。
 * - 未设置变换时（scaleX = 1, offsetX = 0），整行铺满：frame 占满可用宽度，
 *   每拍矩形 = 可用宽度 / 拍数。
 * - 当用户改变小节拍数导致矩形变宽/变窄时，可用 scaleX 缩放整体宽度并平移，
 *   让每拍矩形的绝对宽度与其它小节一致。
 * - 无论如何缩放平移，时间轴都不会超出横向范围（此处硬夹取）。
 * - 矩形之间留出边距 gapScale * 格子宽度。
 */
export function computeBarLayout(span: BarSpan, bar: Bar, gapScale = 0.12): BarLayout {
  const beatCount = Math.max(1, span.beatCount);
  const rawScale = Number.isFinite(bar.transform.scaleX) ? bar.transform.scaleX : 1;
  const scaleX = clamp(rawScale, 0.05, 1);
  const maxOffset = Math.max(0, 1 - scaleX);
  const offsetX = clamp(Number.isFinite(bar.transform.offsetX) ? bar.transform.offsetX : 0, 0, maxOffset);

  const left = offsetX;
  const width = scaleX;
  const cellWidth = width / beatCount;
  const gap = clamp(gapScale, 0, 0.45) * cellWidth;
  const rectWidth = Math.max(cellWidth * 0.02, cellWidth - gap);

  const beats: BarBeatSlot[] = [];
  for (let i = 0; i < beatCount; i++) {
    const cellLeft = left + i * cellWidth;
    beats.push({
      index: i,
      beat: span.startBeat + i,
      left: cellLeft + gap / 2,
      width: rectWidth,
      cellLeft,
      cellWidth,
    });
  }
  return { barIndex: span.index, frameFrac: { left, width }, beats };
}

/** 把「拍」映射到小节内的横向比例（相对小节可用宽度，0 = 第 1 拍） */
export function beatToBarFrac(span: BarSpan, bar: Bar, beat: number): number {
  const scaleX = clamp(Number.isFinite(bar.transform.scaleX) ? bar.transform.scaleX : 1, 0.05, 1);
  const maxOffset = Math.max(0, 1 - scaleX);
  const offsetX = clamp(Number.isFinite(bar.transform.offsetX) ? bar.transform.offsetX : 0, 0, maxOffset);
  const rel = beat - span.startBeat;
  return offsetX + (rel / span.beatCount) * scaleX;
}

/** 强制行进事件的覆盖区间（相对小节第 1 拍的拍偏移） */
export function forceSpanBeats(span: BarSpan, event: BeatEvent): { from: number; to: number } {
  const raw = (event.data as { lengthBeats?: number }).lengthBeats;
  const len = Math.max(0, Number.isFinite(raw as number) ? (raw as number) : 0);
  const from = event.beat - span.startBeat;
  const maxLen = span.beatCount - from;
  const clamped = Math.min(len, Math.max(0, maxLen));
  return { from, to: from + clamped };
}

/**
 * 找出落在「强制行进」覆盖区间内部的其它事件（强制行进区间内不允许有其它事件）。
 */
export function findForceConflicts(span: BarSpan, events: BeatEvent[]): { forceId: string; conflictId: string }[] {
  const conflicts: { forceId: string; conflictId: string }[] = [];
  const forces = events.filter((e) => e.type === 'force');
  for (const f of forces) {
    const { from, to } = forceSpanBeats(span, f);
    const start = span.startBeat + from;
    const end = span.startBeat + to;
    for (const e of events) {
      if (e.id === f.id) continue;
      if (e.beat > start + 1e-9 && e.beat < end - 1e-9) {
        conflicts.push({ forceId: f.id, conflictId: e.id });
      }
    }
  }
  return conflicts;
}
