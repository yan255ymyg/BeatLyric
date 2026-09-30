/**
 * 逐拍歌词的版式与绘制
 *
 * 版式规则（对应需求）
 * ────────────────────
 *  - 每一小节一行时间轴：一条横向主轴 + 在**每个拍位置**上的竖直刻度（默认均匀分布）。
 *  - 小节内每一拍是一个细高的刻度条（高度约为字号的 1.8 倍，宽度固定几像素），
 *    节拍序号画在刻度**正下方**。
 *  - 歌词字事件：图标是一个略高于主轴的圆角矩形，宽度可调（默认够大好点）；
 *    文本显示在图标**正下方居中**，支持多子行（例如一行假名 + 一行罗马音）。
 *  - 其它事件图标同样显示在轴上，文本在图标**上方**（强制行进为起始位置上方左对齐）。
 *  - 播放头扫过的事件会「放大渐隐」；持续型事件（强制行进）在**整段经过之后**才放大渐隐。
 *  - 小节切换：**整块内容**在最后 transitionBeats 拍内向上平移一个行距，
 *    当前小节随之渐隐、下一小节升到主位。所有行一起动，因此视觉上是连续滚动而不是跳动。
 *
 * 本模块只依赖 CanvasRenderingContext2D，播放预览与离线导出共用同一套代码。
 */

import type { Bar, BeatDisplayConfig, BeatEvent, BeatEventType } from '../model/model';
import { clamp } from '../core/util';
import {
  beatToBarFrac,
  computeBarLayout,
  forceSpanBeats,
  getEventSecondsSafe,
  secondsToBeat,
  type BarSpan,
  type Timeline,
} from './timelineHelpers';
import {
  fillRoundRect,
  fontString,
  roundRectPath,
  strokedText,
  type Ctx2D,
} from './canvasKit';
import { drawRichLine, measureRichLine, measureRichLineHeight } from './richTextRenderer';

/* ------------------------------------------------------------------ */
/* 布局模型                                                            */
/* ------------------------------------------------------------------ */

/** 一拍位置的刻度（细高竖条） */
export interface BeatTickPlacement {
  index: number;
  /** 刻度中心 x */
  x: number;
  /** 该拍的全局拍号 */
  beat: number;
  /** 该拍在其小节内的序号（1 基） */
  label: string;
}

export interface ForceBandPlacement {
  x: number;
  width: number;
  y: number;
  height: number;
  ms: number;
  conflict: boolean;
}

export interface BeatEventPlacement {
  event: BeatEvent;
  /** 图标中心 x */
  x: number;
  /** 主轴中心 y */
  axisY: number;
  width: number;
  height: number;
  /** 文本基线 y */
  textY: number;
  textAlign: 'center' | 'left';
  textX: number;
  pulseAge: number | null;
  pulseDurationMs: number;
  pulseScale: number;
  /** 事件上方显示的短标签（char 事件为空） */
  label: string;
  /** 图标颜色栈 */
  iconColors: string[];
}

export interface BeatBarPlacement {
  barIndex: number;
  span: BarSpan;
  bar: Bar;
  /** 时间轴区域左边界与宽度 */
  x: number;
  width: number;
  /** 主轴中心 y */
  y: number;
  rowHeight: number;
  opacity: number;
  axisHeight: number;
  ticks: BeatTickPlacement[];
  events: BeatEventPlacement[];
  forceBands: ForceBandPlacement[];
  label: string;
  isCurrent: boolean;
  /** 该行在画布上占用的垂直范围（含小节标注） */
  bounds: { top: number; bottom: number };
}

export interface BeatLyricsLayout {
  bars: BeatBarPlacement[];
  playhead: { x: number; y: number; height: number } | null;
  bounds: { left: number; top: number; right: number; bottom: number };
  currentRow: number;
}

export interface BeatFrameContext {
  time: number;
  width: number;
  height: number;
  /** 画布坐标 -> 输出坐标的整体缩放（预览时为 dpr，导出时为 1） */
  layoutScale: number;
}

/* ------------------------------------------------------------------ */
/* 单个事件的尺寸与文本                                                */
/* ------------------------------------------------------------------ */

/** 每个事件图标相对主轴中心的高度倍数 */
function iconHeightScale(e: BeatEvent): number {
  switch (e.type) {
    case 'char':
      return (e.data as { heightScale: number }).heightScale;
    case 'force':
      return 1.9;
    case 'bpm':
    case 'pause':
      return 1.8;
    case 'lrcPrev':
    case 'lrcNext':
    case 'lrcTempStart':
    case 'lrcTempEnd':
      return 1.7;
    default:
      return 1.6;
  }
}

/** 事件图标宽度（画布坐标） */
function iconWidth(e: BeatEvent, axisH: number, scale: number): number {
  switch (e.type) {
    case 'char':
      return Math.max(4, (e.data as { width: number }).width * scale);
    case 'force':
      return Math.max(14, axisH * 0.6);
    case 'bpm':
      return Math.max(16, axisH * 0.8);
    case 'pause':
      return Math.max(14, axisH * 0.7);
    default:
      return Math.max(13, axisH * 0.62);
  }
}

function eventLabelText(e: BeatEvent, lrcIndexLabel: (blockIndex: number) => string): string {
  switch (e.type) {
    case 'bpm':
      return `bpm=${(e.data as { bpm: number }).bpm}`;
    case 'pause':
      return `${(e.data as { ms: number }).ms}ms`;
    case 'force':
      return `${(e.data as { ms: number }).ms}ms`;
    case 'lrcPrev':
    case 'lrcNext':
      return `LRC→${lrcIndexLabel((e.data as { offset: number }).offset)}`;
    case 'lrcTempStart':
      return `LRC+${lrcIndexLabel((e.data as { index: number }).index)}`;
    case 'lrcTempEnd':
      return `LRC-${lrcIndexLabel((e.data as { index: number }).index)}`;
    default:
      return '';
  }
}

/** 事件是否应该参与绘制（按用户设置的可见性） */
function eventVisible(cfg: BeatDisplayConfig, type: BeatEventType, part: 'icon' | 'text'): boolean {
  const vis = cfg.eventVisibility[type];
  if (!vis) return true;
  return part === 'icon' ? vis.icon : vis.text;
}

/** 图标颜色栈（默认给一个与主轴区分度高的颜色） */
function iconColorsOf(e: BeatEvent): string[] {
  if (e.type === 'char') {
    const data = e.data as { colors?: string[] };
    return data.colors && data.colors.length ? data.colors : ['#4ea1ff'];
  }
  switch (e.type) {
    case 'bpm':
      return ['#ffb020', '#ff8a3d'];
    case 'pause':
      return ['#ffe066', '#ffc93c'];
    case 'force':
      return ['#b388ff', '#8b5cf6'];
    case 'lrcPrev':
    case 'lrcNext':
      return ['#5ee6b0', '#2fbf85'];
    default:
      return ['#ff8fa3', '#f2557a'];
  }
}

/* ------------------------------------------------------------------ */
/* 版式                                                                */
/* ------------------------------------------------------------------ */

/**
 * 计算逐拍歌词的整体版式。
 */
export function layoutBeatLyrics(
  tl: Timeline,
  ctx: BeatFrameContext,
  cfg: BeatDisplayConfig,
  lrcIndexLabel: (blockIndex: number) => string,
): BeatLyricsLayout {
  const spans = tl.spans;
  if (!spans.length) {
    return { bars: [], playhead: null, bounds: { left: 0, top: 0, right: 0, bottom: 0 }, currentRow: -1 };
  }

  const scale = clamp(cfg.scaleX, 0.05, 8) * ctx.layoutScale;
  const vScale = clamp(cfg.scaleY, 0.05, 8) * ctx.layoutScale;
  const textSize = cfg.textFontSize * scale;
  const axisH = clamp(cfg.barHeight * vScale, 2, 400);
  const tickH = Math.max(axisH, textSize * 1.8);
  const rowGap = cfg.rowGap * vScale;
  const textGap = cfg.textGap * vScale;
  const eventLabelSize = cfg.eventLabelFontSize * scale;
  const showCount = clamp(Math.round(cfg.visibleBarCount), 1, 32);

  const beatNow = secondsToBeat(tl, ctx.time);

  /**
   * 定位「视觉上的当前小节」。
   * 过渡期（当前小节最后 transitionBeats 拍）内，`slideT` 从 0 到 1 平滑变化，
   * 主位小节切换为下一个；整块内容向上平移 slideT 个行距。
   * 由于当前小节「提前」结束，下一小节会在它真正开始时正好就位。
   */
  let baseIndex = 0;
  for (let i = 0; i < spans.length; i++) {
    if (beatNow >= spans[i].startBeat) baseIndex = i;
    else break;
  }
  const transitBeats = clamp(cfg.transitionBeats, 0, 8);
  let slideT = 0;
  if (transitBeats > 0 && baseIndex < spans.length - 1) {
    const span = spans[baseIndex];
    const progress = beatNow - span.startBeat;
    const threshold = span.beatCount - transitBeats;
    if (progress >= threshold) {
      const raw = clamp((progress - threshold) / transitBeats, 0, 1);
      slideT = raw * raw * (3 - 2 * raw); // smoothstep，起止都平缓
    }
  }
  const currentIndex = slideT >= 1 && baseIndex < spans.length - 1 ? baseIndex + 1 : baseIndex;

  const layoutWidth = ctx.width * 0.94;
  const leftMargin = (ctx.width - layoutWidth) / 2;

  /**
   * 每行的垂直几何。所有项都以「像素」为单位，量纲必须一致。
   * 自上而下需要预留：
   *   aboveTextSpace 事件文本与图标在主轴上方的部分
   *   axisH          主轴本体
   *   textGap        轴与歌词字文本之间的间距
   *   maxTextH       歌词字文本（可能多行）
   *   labelBand      小节标注
   */
  let maxIconScale = 1;
  let maxTextH = textSize * 1.2;
  for (const span of spans) {
    for (const ev of span.bar.events) {
      if (ev.type === 'char') {
        const lines = (ev.data as { lines: import('../model/model').RichLine[] }).lines;
        let h = 0;
        lines.forEach((l, i) => {
          h += measureRichLineHeight(l, { fontSize: textSize, rubyScale: cfg.rubyScale, rubyGap: cfg.rubyGap * scale });
          if (i < lines.length - 1) h += textSize * 0.25;
        });
        maxTextH = Math.max(maxTextH, h);
      } else {
        maxIconScale = Math.max(maxIconScale, iconHeightScale(ev));
      }
    }
  }
  const maxIconH = Math.max(axisH * maxIconScale, tickH);
  const aboveTextSpace = Math.max(maxIconH / 2 - axisH / 2, eventLabelSize) + eventLabelSize * 0.9 + 4 * vScale;
  const belowTextSpace = textGap + maxTextH;
  const blockH = aboveTextSpace + axisH + belowTextSpace;
  const labelBand = cfg.showBarLabel ? cfg.labelFontSize * vScale * 1.9 : 0;
  const rowPitch = blockH + rowGap + labelBand;
  const breathe = textSize * 0.25;

  /* 版式的垂直锚点 */
  const anchorY = cfg.pos.y * ctx.height;
  const contentH = Math.min(showCount, spans.length - currentIndex) * rowPitch + rowPitch;
  const baseBottom =
    cfg.anchor === 'bottom'
      ? Math.min(ctx.height, anchorY)
      : cfg.anchor === 'top'
        ? anchorY + contentH
        : anchorY + contentH / 2;
  const slide = slideT * rowPitch;

  const rows = Math.min(showCount, spans.length - currentIndex);
  const placements: BeatBarPlacement[] = [];

  for (let r = rows - 1; r >= 0; r--) {
    const index = currentIndex + r;
    const span = spans[index];
    const bar = span.bar;
    const top = baseBottom - (r + 1) * rowPitch + breathe - slide;
    const axisY = top + aboveTextSpace + axisH / 2;
    // 过渡中：越靠下的行越接近「完全淡出」，用行内进度区分
    const rowSlideT = clamp(slideT - (r > 0 ? 0 : 0), 0, 1);
    const opacity =
      r === 0
        ? cfg.currentOpacity * (1 - rowSlideT) + cfg.fadingOpacity * rowSlideT
        : cfg.nextOpacity;

    const frame = computeBarLayout(span, bar, 0);
    const ticks: BeatTickPlacement[] = frame.beats.map((b) => ({
      index: b.index,
      x: leftMargin + (b.cellLeft + b.cellWidth / 2) * layoutWidth,
      beat: b.beat,
      label: String(b.index + 1),
    }));

    const forceBands: ForceBandPlacement[] = [];
    const events: BeatEventPlacement[] = [];
    const barBeatWindow = { from: span.startBeat, to: span.startBeat + span.beatCount };

    for (const ev of bar.events) {
      if (!Number.isFinite(ev.beat) || ev.beat < barBeatWindow.from - 1e-9 || ev.beat >= barBeatWindow.to - 1e-9) continue;
      const frac = beatToBarFrac(span, bar, ev.beat);
      const x = leftMargin + frac * layoutWidth;
      const w = iconWidth(ev, axisH, scale);
      const h = clamp(tickH * (iconHeightScale(ev) / 1.8), 6, blockH);
      const isChar = ev.type === 'char';
      const label = isChar ? '' : eventLabelText(ev, lrcIndexLabel);
      const iconTop = axisY - Math.max(h, axisH) / 2;
      // 歌词字文本：轴下方 textGap 处起排（基线落在第一行字的下沿）
      const firstLineH = isChar
        ? measureRichLineHeight(
            (ev.data as { lines: import('../model/model').RichLine[] }).lines[0],
            { fontSize: textSize, rubyScale: cfg.rubyScale, rubyGap: cfg.rubyGap * scale },
          )
        : 0;
      const textY = isChar
        ? axisY + axisH / 2 + textGap + firstLineH * 0.78
        : iconTop - eventLabelSize * 0.4;

      events.push({
        event: ev,
        x,
        axisY,
        width: w,
        height: h,
        textY,
        textAlign: ev.type === 'force' ? 'left' : 'center',
        textX: ev.type === 'force' ? x + w * 0.5 + 4 : x,
        pulseAge: null,
        pulseDurationMs: cfg.pulseMs,
        pulseScale: cfg.pulseScale,
        label,
        iconColors: iconColorsOf(ev),
      });

      if (ev.type === 'force') {
        const { from, to } = forceSpanBeats(span, ev);
        const x0 = leftMargin + beatToBarFrac(span, bar, span.startBeat + from) * layoutWidth;
        const x1 = leftMargin + beatToBarFrac(span, bar, span.startBeat + to) * layoutWidth;
        forceBands.push({
          x: x0,
          width: Math.max(3, x1 - x0),
          y: axisY,
          height: Math.max(tickH, axisH) * 1.15,
          ms: (ev.data as { ms: number }).ms,
          conflict: false,
        });
      }
    }

    placements.push({
      barIndex: index,
      span,
      bar,
      x: leftMargin,
      width: layoutWidth,
      y: axisY,
      rowHeight: blockH,
      opacity: clamp(opacity, 0, 1),
      axisHeight: axisH,
      ticks,
      events,
      forceBands,
      label: `${index + 1}  •  ${span.beatCount} 拍`,
      isCurrent: r === 0,
      bounds: { top, bottom: top + blockH + labelBand },
    });
  }

  /* 播放头：只画在当前行（最下面一行） */
  let playhead: BeatLyricsLayout['playhead'] = null;
  if (cfg.showPlayhead && placements.length) {
    const cur = placements[0];
    const frac = beatToBarFrac(cur.span, cur.bar, beatNow);
    playhead = {
      x: cur.x + frac * cur.width,
      y: cur.y - Math.max(tickH, axisH) * 0.62,
      height: Math.max(tickH, axisH) * 1.24,
    };
  }

  /* 扫过动画：点事件在到达后、持续事件在整段经过后进入脉冲窗口 */
  if (cfg.pulseMs > 0) {
    placements.forEach((p) => {
      p.events.forEach((pl) => {
        const ev = pl.event;
        const startSec = getEventSecondsSafe(tl, ev.beat);
        const isSpan = ev.type === 'force';
        const endSec = isSpan
          ? getEventSecondsSafe(tl, ev.beat + (ev.data as { lengthBeats: number }).lengthBeats)
          : startSec;
        const age = (ctx.time - (isSpan ? endSec : startSec)) * 1000;
        pl.pulseAge = age >= 0 && age <= cfg.pulseMs ? age : null;
      });
    });
  }

  const tops = placements.map((p) => p.bounds.top);
  const bottoms = placements.map((p) => p.bounds.bottom);
  return {
    bars: placements,
    playhead,
    bounds: {
      left: leftMargin,
      top: Math.min(...tops),
      right: leftMargin + layoutWidth,
      bottom: Math.max(...bottoms),
    },
    currentRow: 0,
  };
}

/* ------------------------------------------------------------------ */
/* 绘制                                                                */
/* ------------------------------------------------------------------ */

export interface DrawBeatOptions {
  cfg: BeatDisplayConfig;
  /** 画布坐标 -> 输出坐标的整体缩放（与 layoutScale 一致） */
  canvasScale: number;
}

export function drawBeatLyrics(ctx: Ctx2D, layout: BeatLyricsLayout, opts: DrawBeatOptions): void {
  const { cfg } = opts;
  const scale = clamp(cfg.scaleX, 0.05, 8) * opts.canvasScale;
  const vScale = clamp(cfg.scaleY, 0.05, 8) * opts.canvasScale;
  const textSize = cfg.textFontSize * scale;
  const labelSize = cfg.eventLabelFontSize * scale;

  ctx.save();
  ctx.textBaseline = 'alphabetic';

  for (const bar of layout.bars) {
    ctx.save();
    ctx.globalAlpha = bar.opacity;

    const axisH = bar.axisHeight;
    const tickH = Math.max(axisH, textSize * 1.8);

    // 强制行进覆盖区
    if (eventVisible(cfg, 'force', 'icon')) {
      bar.forceBands.forEach((band) => {
        ctx.save();
        ctx.globalAlpha = bar.opacity * 0.45;
        const g = ctx.createLinearGradient(0, band.y - band.height / 2, 0, band.y + band.height / 2);
        g.addColorStop(0, '#b388ff');
        g.addColorStop(1, '#7c4dff');
        fillRoundRect(ctx, band.x, band.y - band.height / 2, band.width, band.height, Math.min(6 * vScale, band.height / 2), g);
        ctx.restore();
        // 覆盖时长标在区间左上方
        if (eventVisible(cfg, 'force', 'text')) {
          ctx.font = fontString(labelSize, false);
          ctx.textAlign = 'left';
          strokedText(ctx, `${band.ms}ms`, band.x + 2, band.y - band.height / 2 - labelSize * 0.35, {
            outlineWidth: 2 * vScale,
            outlineColor: '#05070c',
            fill: cfg.eventLabelColor,
          });
        }
      });
    }

    // 主轴：一条横贯的圆角长条
    const axisTop = bar.y - axisH / 2;
    const axisGrad = ctx.createLinearGradient(0, axisTop, 0, axisTop + axisH);
    axisGrad.addColorStop(0, cfg.barFill.from);
    axisGrad.addColorStop(1, cfg.barFill.to);
    fillRoundRect(ctx, bar.x, axisTop, bar.width, axisH, Math.min(axisH / 2, 4 * vScale), axisGrad);
    if (cfg.barStrokeWidth > 0) {
      ctx.strokeStyle = cfg.barStroke;
      ctx.lineWidth = cfg.barStrokeWidth * vScale;
      roundRectPath(ctx, bar.x, axisTop, bar.width, axisH, Math.min(axisH / 2, 4 * vScale));
      ctx.stroke();
    }

    // 每拍刻度：细高竖条，压在主轴上下
    bar.ticks.forEach((t) => {
      const w = Math.max(1.5, cfg.beatMarkWidth * scale);
      const top = bar.y - tickH / 2;
      const g = ctx.createLinearGradient(0, top, 0, top + tickH);
      g.addColorStop(0, cfg.beatMarkFill.from);
      g.addColorStop(1, cfg.beatMarkFill.to);
      fillRoundRect(ctx, t.x - w / 2, top, w, tickH, Math.min(w / 2, 1.5), g);
      if (cfg.beatMarkStrokeWidth > 0) {
        ctx.strokeStyle = cfg.beatMarkStroke;
        ctx.lineWidth = cfg.beatMarkStrokeWidth * vScale;
        roundRectPath(ctx, t.x - w / 2, top, w, tickH, Math.min(w / 2, 1.5));
        ctx.stroke();
      }
    });

    // 节拍序号（刻度正下方）与小节标注
    if (cfg.showBeatNumbers) {
      ctx.font = fontString(cfg.beatNumberFontSize * scale, cfg.beatNumberBold);
      ctx.textAlign = 'center';
      bar.ticks.forEach((t) => {
        strokedText(ctx, t.label, t.x, bar.y + tickH / 2 + cfg.beatNumberFontSize * scale * 1.15, {
          outlineWidth: 2 * vScale,
          outlineColor: '#05070c',
          fill: cfg.beatNumberColor,
        });
      });
    }
    if (cfg.showBarLabel) {
      ctx.font = fontString(cfg.labelFontSize * vScale, false);
      ctx.fillStyle = cfg.labelColor;
      ctx.textAlign = 'left';
      ctx.fillText(bar.label, bar.x, bar.bounds.bottom - cfg.labelFontSize * vScale * 0.3);
    }

    // 事件
    bar.events.forEach((pl) => {
      const pulse = pl.pulseAge !== null && pl.pulseDurationMs > 0 ? 1 - clamp(pl.pulseAge / pl.pulseDurationMs, 0, 1) : 0;
      const pulseEase = pulse * pulse;
      const pScale = 1 + (pl.pulseScale - 1) * pulseEase;
      const pAlpha = pl.pulseAge !== null ? Math.max(0, 1 - pulse) : 1;

      ctx.save();
      ctx.globalAlpha = bar.opacity * pAlpha;

      if (eventVisible(cfg, pl.event.type, 'icon')) {
        ctx.save();
        ctx.translate(pl.x, pl.axisY);
        ctx.scale(pScale, pScale);
        drawEventIcon(ctx, pl, vScale);
        ctx.restore();
      }

      if (pl.event.type === 'char') {
        if (eventVisible(cfg, 'char', 'text')) {
          ctx.save();
          ctx.translate(pl.x, pl.textY);
          ctx.scale(pScale, pScale);
          drawCharLines(ctx, pl, cfg, textSize, scale, vScale);
          ctx.restore();
        }
      } else if (eventVisible(cfg, pl.event.type, 'text') && pl.label) {
        ctx.font = fontString(labelSize, false);
        ctx.textAlign = pl.textAlign;
        const x = pl.textAlign === 'left' ? pl.textX : pl.x;
        strokedText(ctx, pl.label, x, pl.textY, {
          outlineWidth: 2.5 * vScale,
          outlineColor: '#05070c',
          fill: cfg.eventLabelColor,
        });
      }
      ctx.restore();
    });

    ctx.restore();
  }

  // 播放头
  if (layout.playhead && cfg.showPlayhead) {
    ctx.save();
    const g = ctx.createLinearGradient(0, layout.playhead.y, 0, layout.playhead.y + layout.playhead.height);
    g.addColorStop(0, 'rgba(255,93,115,0.15)');
    g.addColorStop(0.5, cfg.playheadColor);
    g.addColorStop(1, 'rgba(255,93,115,0.15)');
    ctx.strokeStyle = g;
    ctx.lineWidth = Math.max(2, 2.5 * vScale);
    ctx.beginPath();
    ctx.moveTo(layout.playhead.x, layout.playhead.y);
    ctx.lineTo(layout.playhead.x, layout.playhead.y + layout.playhead.height);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

/** 画事件图标 */
function drawEventIcon(ctx: Ctx2D, pl: BeatEventPlacement, vScale: number): void {
  const { event: ev, width: w, height: h } = pl;
  const half = w / 2;
  const colors = pl.iconColors;
  const fillFor = (): string | CanvasGradient => {
    if (colors.length <= 1) return colors[0];
    const g = ctx.createLinearGradient(0, -h / 2, 0, h / 2);
    colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
    return g;
  };
  const stroke = 'rgba(255,255,255,0.9)';

  switch (ev.type) {
    case 'char': {
      const r = clamp((ev.data as { radius: number }).radius, 0, half);
      fillRoundRect(ctx, -half, -h / 2, w, h, r, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, r);
      ctx.stroke();
      break;
    }
    case 'force': {
      // 这里只画一个小的“起点”标记，覆盖区由 forceBand 画
      fillRoundRect(ctx, -half, -h / 2, w, h, h * 0.28, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.2 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, h * 0.28);
      ctx.stroke();
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.6 * vScale;
      const chevrons = 2;
      for (let i = 0; i < chevrons; i++) {
        const cx = -half + (i + 0.5) * (w / chevrons);
        ctx.beginPath();
        ctx.moveTo(cx - h * 0.13, -h * 0.18);
        ctx.lineTo(cx + h * 0.13, 0);
        ctx.lineTo(cx - h * 0.13, h * 0.18);
        ctx.stroke();
      }
      break;
    }
    case 'bpm': {
      fillRoundRect(ctx, -half, -h / 2, w, h, h * 0.3, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.1 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, h * 0.3);
      ctx.stroke();
      // 音符：实心符头 + 符干
      ctx.fillStyle = '#1b1200';
      const r = h * 0.15;
      ctx.beginPath();
      ctx.ellipse(-w * 0.1, h * 0.14, r, r * 0.82, -0.3, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#1b1200';
      ctx.lineWidth = Math.max(1, h * 0.09);
      ctx.beginPath();
      ctx.moveTo(-w * 0.1 + r, h * 0.1);
      ctx.lineTo(-w * 0.1 + r, -h * 0.3);
      ctx.stroke();
      break;
    }
    case 'pause': {
      fillRoundRect(ctx, -half, -h / 2, w, h, h * 0.3, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.1 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, h * 0.3);
      ctx.stroke();
      ctx.fillStyle = '#241f00';
      const barW = Math.max(1.6, w * 0.2);
      ctx.fillRect(-barW * 1.15, -h * 0.26, barW, h * 0.52);
      ctx.fillRect(barW * 0.15, -h * 0.26, barW, h * 0.52);
      break;
    }
    case 'lrcPrev':
    case 'lrcNext': {
      fillRoundRect(ctx, -half, -h / 2, w, h, h * 0.3, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.1 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, h * 0.3);
      ctx.stroke();
      const up = ev.type === 'lrcPrev';
      ctx.strokeStyle = '#04231a';
      ctx.fillStyle = '#04231a';
      ctx.lineWidth = Math.max(1.4, 1.8 * vScale);
      const s = h * 0.3;
      ctx.beginPath();
      if (up) {
        ctx.moveTo(-s * 0.8, s * 0.45);
        ctx.lineTo(0, -s * 0.5);
        ctx.lineTo(s * 0.8, s * 0.45);
      } else {
        ctx.moveTo(-s * 0.8, -s * 0.45);
        ctx.lineTo(0, s * 0.5);
        ctx.lineTo(s * 0.8, -s * 0.45);
      }
      ctx.stroke();
      break;
    }
    case 'lrcTempStart':
    case 'lrcTempEnd': {
      const start = ev.type === 'lrcTempStart';
      fillRoundRect(ctx, -half, -h / 2, w, h, h * 0.3, fillFor());
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 1.1 * vScale;
      roundRectPath(ctx, -half, -h / 2, w, h, h * 0.3);
      ctx.stroke();
      ctx.strokeStyle = '#2a0a0e';
      ctx.lineWidth = Math.max(1.4, 1.8 * vScale);
      const s = h * 0.3;
      for (let k = 0; k < 2; k++) {
        const off = (k - 0.5) * s * 0.95 * (start ? 1 : -1);
        ctx.beginPath();
        ctx.moveTo(off - s * 0.3 * (start ? 1 : -1), -s);
        ctx.lineTo(off + s * 0.5 * (start ? 1 : -1), 0);
        ctx.lineTo(off - s * 0.3 * (start ? 1 : -1), s);
        ctx.stroke();
      }
      break;
    }
    default:
      break;
  }
}

/** 画歌词字文本（多子行，使用与逐行歌词相同的富文本绘制） */
function drawCharLines(
  ctx: Ctx2D,
  pl: BeatEventPlacement,
  cfg: BeatDisplayConfig,
  textSize: number,
  scale: number,
  vScale: number,
): void {
  const ev = pl.event;
  if (ev.type !== 'char') return;
  const lines = (ev.data as { lines: import('../model/model').RichLine[] }).lines;
  const gap = textSize * 0.25;
  let cursor = 0; // 相对 textY 的偏移（第一行基线在 0）
  lines.forEach((line, i) => {
    if (i > 0) {
      const prevH = measureRichLineHeight(lines[i - 1], { fontSize: textSize, rubyScale: cfg.rubyScale, rubyGap: cfg.rubyGap * scale });
      cursor += prevH * 0.78 + gap;
    }
    drawRichLine(ctx, line, {
      baseline: cursor,
      anchorX: 0,
      align: 'center',
      fontSize: textSize,
      color: cfg.textColor,
      bold: false,
      outlineWidth: cfg.textOutlineWidth * vScale,
      outlineColor: cfg.textOutlineColor,
      rubyScale: cfg.rubyScale,
      rubyGap: cfg.rubyGap * scale,
    });
  });
}

/** 命中测试：返回命中的事件（供编辑器点击选择） */
export function hitTestBeatEvents(layout: BeatLyricsLayout, x: number, y: number, tolerance = 8): BeatEventPlacement | null {
  for (const bar of layout.bars) {
    for (const pl of bar.events) {
      const hw = Math.max(pl.width / 2, 6) + tolerance;
      const hh = Math.max(pl.height / 2, 8) + tolerance;
      if (Math.abs(x - pl.x) <= hw && Math.abs(y - pl.axisY) <= hh) return pl;
    }
  }
  return null;
}

export { measureRichLine };
