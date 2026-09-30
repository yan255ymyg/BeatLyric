/**
 * 富文本行绘制（逐行歌词与编辑器预览共用）
 *
 * 为什么抽出来：编辑器里的「行内预览」必须与播放画面**完全一致**，
 * 因此两者调用同一个函数。任何样式（颜色栈渐变、粗体、斜体、ruby、字号）都只在这里实现一次。
 */

import type { LrcDisplayConfig, RichLine, SpanStyle } from '../model/model';
import { fontString, measureText, strokedText, type Ctx2D } from './canvasKit';
import { fillForColors, primaryColor } from '../core/richText';

export interface RichLineDrawOptions {
  /** 文本基线（y） */
  baseline: number;
  /** 水平锚点 */
  anchorX: number;
  align: 'left' | 'center' | 'right';
  /** 基准字号（已含所有缩放） */
  fontSize: number;
  /** 默认颜色 */
  color: string;
  /** 默认是否加粗 */
  bold?: boolean;
  outlineWidth: number;
  outlineColor: string;
  /** ruby 字号比例与间距 */
  rubyScale: number;
  rubyGap: number;
  /** 每个字之间的额外间距 */
  letterSpacing?: number;
}

/** 计算一行文本的像素宽度 */
export function measureRichLine(line: RichLine, opts: { fontSize: number; bold?: boolean; letterSpacing?: number }): number {
  let w = 0;
  for (const span of line.spans) {
    if (!span.text) continue;
    const size = span.style?.fontSize ? (span.style.fontSize * opts.fontSize) / 100 : opts.fontSize;
    const bold = !!(span.style?.bold || opts.bold);
    w += measureText(span.text, size, bold, !!span.style?.italic, opts.letterSpacing ?? 0).width;
  }
  return w;
}

/** 计算一行文本的像素高度（含 ruby 占位） */
export function measureRichLineHeight(line: RichLine, opts: { fontSize: number; rubyScale: number; rubyGap: number }): number {
  let h = opts.fontSize * 1.18;
  for (const span of line.spans) {
    const size = span.style?.fontSize ? (span.style.fontSize * opts.fontSize) / 100 : opts.fontSize;
    const base = size * 1.18;
    const rubyH = span.style?.ruby ? size * opts.rubyScale + opts.rubyGap : 0;
    h = Math.max(h, base + rubyH);
  }
  return h;
}

/**
 * 画一行富文本。
 *
 * 说明：`SpanStyle.fontSize` 与 `dy` 用「相对基准字号的百分比 / 像素」表示，
 * 这样同一份数据在任何画布尺寸下都成立（预览与导出各自传入自己的 fontSize）。
 */
export function drawRichLine(ctx: Ctx2D, line: RichLine, opts: RichLineDrawOptions): void {
  const spans = line.spans.filter((s) => s.text.length > 0);
  if (!spans.length) return;

  const spacing = opts.letterSpacing ?? 0;
  const items = spans.map((span) => {
    const size = span.style?.fontSize ? (span.style.fontSize * opts.fontSize) / 100 : opts.fontSize;
    const bold = !!(span.style?.bold || opts.bold);
    const italic = !!span.style?.italic;
    const width = measureText(span.text, size, bold, italic, spacing).width;
    return { span, style: span.style, size, bold, italic, width };
  });
  const total = items.reduce((acc, it) => acc + it.width, 0);

  let x = opts.align === 'center' ? opts.anchorX - total / 2 : opts.align === 'right' ? opts.anchorX - total : opts.anchorX;

  ctx.save();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  for (const it of items) {
    const st: SpanStyle = it.style ?? {};
    const baseline = opts.baseline - (st.dy ?? 0);
    // 行盒范围：用于颜色栈的竖直渐变
    const top = baseline - it.size * 0.9;
    const bottom = baseline + it.size * 0.12;
    const fill = fillForColors(ctx, st.colors, x, top, bottom, opts.color);

    ctx.font = fontString(it.size, it.bold, it.italic);
    strokedText(ctx, it.span.text, x, baseline, {
      outlineWidth: opts.outlineWidth,
      outlineColor: opts.outlineColor,
      fill,
    });

    if (spacing > 0 && it.span.text.length > 1) {
      // 已通过 measureText 计入宽度，这里无需额外处理（保持实现简单，直接用默认字距）
    }

    if (st.ruby) {
      const rubySize = it.size * opts.rubyScale;
      ctx.font = fontString(rubySize, it.bold);
      ctx.textAlign = 'left';
      ctx.fillStyle = primaryColor(st, opts.color);
      const rubyW = measureText(st.ruby, rubySize, it.bold).width;
      ctx.fillText(st.ruby, x + (it.width - rubyW) / 2, top - opts.rubyGap);
    }

    x += it.width;
  }

  ctx.restore();
}

/** 一行富文本的整体盒尺寸（供版式计算） */
export function richLineBox(
  line: RichLine,
  fontSize: number,
  cfg: Pick<LrcDisplayConfig, 'rubyScale' | 'rubyGap'>,
): { width: number; height: number } {
  return {
    width: measureRichLine(line, { fontSize }),
    height: measureRichLineHeight(line, { fontSize, rubyScale: cfg.rubyScale, rubyGap: cfg.rubyGap }),
  };
}
