/**
 * 逐行歌词绘制
 *
 * 需求要点
 * ────────
 *  - 主歌词只有一块：决定竖直中心位置与突出显示。
 *  - 临时行由逐拍歌词事件驱动；进入后移到主歌词行**下方**，与主歌词一起突出显示，
 *    并挤占其它未突出显示行的空间。
 *  - 每个块内部的多个子行是独立的文本行；每行的样式挂在各自的**分段**上
 *    （颜色栈：1 色纯色 / 多色渐变、粗体、斜体、ruby、字号）。
 *
 * 版式计算在 `core/lrc.ts`（纯函数），行绘制复用 `render/richTextRenderer.ts`
 * —— 这样编辑器里的行内预览与播放画面天然一致。
 */

import type { LrcLayout, PlacedLine } from '../core/lrc';
import { lineBlockHeight } from '../core/lrc';
import type { LyricLine, LrcDisplayConfig } from '../model/model';
import { roundRectPath, type Ctx2D } from './canvasKit';
import { drawRichLine, measureRichLine } from './richTextRenderer';
import { clamp } from '../core/util';

export interface LrcDrawContext {
  /** 归一化位置（x 为中心，y 为中心） */
  pos: { x: number; y: number };
  cfg: LrcDisplayConfig;
  canvasWidth: number;
  canvasHeight: number;
  /** 全局缩放（画布尺寸自适应） */
  globalScale: number;
}

/** 版式中心在画布上的像素坐标 */
export function anchorXY(ctx: LrcDrawContext): { cx: number; cy: number } {
  return { cx: ctx.pos.x * ctx.canvasWidth, cy: ctx.pos.y * ctx.canvasHeight };
}

export function drawLrc(context: Ctx2D, layout: LrcLayout, lines: LyricLine[], draw: LrcDrawContext): void {
  const { cx, cy } = anchorXY(draw);
  const fontSize = draw.cfg.fontSize * draw.globalScale;

  context.save();
  context.textBaseline = 'alphabetic';

  // 非突出行先画、突出行后画，避免互相覆盖
  const ordered = [...layout.placed].sort((a, b) => (a.highlighted === b.highlighted ? 0 : a.highlighted ? 1 : -1));

  for (const placed of ordered) {
    const line = lines[placed.lineIndex];
    if (!line) continue;
    drawPlacedLine(context, line, placed, { cx, cy, fontSize, cfg: draw.cfg, globalScale: draw.globalScale });
  }

  context.restore();
}

interface LineDrawParams {
  cx: number;
  cy: number;
  fontSize: number;
  cfg: LrcDisplayConfig;
  globalScale: number;
}

function drawPlacedLine(ctx: Ctx2D, line: LyricLine, placed: PlacedLine, p: LineDrawParams): void {
  const scale = placed.scale;
  const subs = line.subLines.length ? line.subLines : [];
  const fontSize = p.fontSize;
  // 块高与内部子行偏移必须与版式计算（lineBlockHeight）完全一致
  const subH = subs.map((s) => lineBlockHeight({ id: s.id, subLines: [s] }, fontSize, p.cfg));
  const intraGap = fontSize * (p.cfg.lineSpacing - 1.18);
  const blockH = Math.max(fontSize, subH.reduce((a, b) => a + b, 0) + intraGap * Math.max(0, subs.length - 1));
  const y0 = p.cy + placed.y;

  ctx.save();
  ctx.globalAlpha = clamp(placed.opacity, 0, 1);

  const align = p.cfg.align;
  const anchorX = align === 'center' ? p.cx : align === 'right' ? p.cx + blockWidthOf(subs, fontSize, p.cfg) / 2 : p.cx - blockWidthOf(subs, fontSize, p.cfg) / 2;

  // 背景条（仅突出行，用于提升可读性）
  if (placed.highlighted && p.cfg.outlineWidth > 0) {
    const w = blockWidthOf(subs, fontSize, p.cfg);
    ctx.save();
    ctx.globalAlpha *= 0.34;
    ctx.fillStyle = p.cfg.outlineColor;
    const bw = w * scale + p.cfg.outlineWidth * p.globalScale * 6;
    const bh = blockH * scale + p.cfg.outlineWidth * p.globalScale * 4;
    const bx = align === 'center' ? p.cx - bw / 2 : align === 'right' ? p.cx + w * scale / 2 - bw : p.cx - w * scale / 2;
    roundRectPath(ctx, bx, y0 - bh / 2, bw, bh, Math.min(10, bh * 0.28));
    ctx.fill();
    ctx.restore();
  }

  let lineTop = y0 - (blockH * scale) / 2;
  subs.forEach((sub, i) => {
    const h = subH[i];
    const scaledH = h * scale;
    drawRichLine(ctx, sub, {
      baseline: lineTop + scaledH * 0.78,
      anchorX,
      align,
      fontSize: fontSize * scale,
      color: placed.color,
      bold: placed.bold,
      outlineWidth: p.cfg.outlineWidth * p.globalScale * scale,
      outlineColor: p.cfg.outlineColor,
      rubyScale: p.cfg.rubyScale,
      rubyGap: p.cfg.rubyGap * p.globalScale,
    });
    lineTop += scaledH + intraGap * scale;
  });

  ctx.restore();
}

function blockWidthOf(subs: LyricLine['subLines'], fontSize: number, cfg: LrcDisplayConfig): number {
  let w = 10;
  for (const sub of subs) {
    w = Math.max(w, measureRichLine(sub, { fontSize, bold: cfg.bold }));
  }
  return w;
}

/** 命中测试：返回点击位置对应的块索引 */
export function hitTestLrc(
  layout: LrcLayout,
  lines: LyricLine[],
  draw: LrcDrawContext,
  px: number,
  py: number,
): number | null {
  const { cx, cy } = anchorXY(draw);
  const fontSize = draw.cfg.fontSize * draw.globalScale;
  for (const placed of layout.placed) {
    const line = lines[placed.lineIndex];
    if (!line) continue;
    const h = lineBlockHeight(line, fontSize, draw.cfg) * placed.scale;
    const w = blockWidthOf(line.subLines, fontSize, draw.cfg);
    const top = cy + placed.y - h / 2;
    const left = cx - w / 2 - 12;
    if (py >= top - 4 && py <= top + h + 4 && px >= left && px <= left + w + 24) return placed.lineIndex;
  }
  return null;
}
