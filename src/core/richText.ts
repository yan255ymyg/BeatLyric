/**
 * 富文本行的样式工具
 *
 * 颜色模型（v2）
 * ──────────────
 * `SpanStyle.colors` 是一个**颜色栈**：
 *   - 只有 1 个颜色 → 纯色；
 *   - 多个颜色 → 自上而下的渐变（均匀分布色标）。
 * 这样「纯色/渐变」不再是两种互斥的设置，而只是颜色数量的自然结果。
 */

import type { Gradient, RichLine, SpanStyle, TextSpan } from '../model/model';

/** 颜色栈 -> 画布填充（在给定上下范围内） */
export function fillForColors(
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  colors: string[] | undefined,
  x: number,
  top: number,
  bottom: number,
  fallback: string,
): string | CanvasGradient {
  if (!colors || colors.length === 0) return fallback;
  if (colors.length === 1) return colors[0];
  const g = ctx.createLinearGradient(x, top, x, bottom);
  colors.forEach((c, i) => {
    g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c);
  });
  return g;
}

/** 颜色栈的等效 Gradient（用于需要显式渐变对象的场合） */
export function colorsToGradient(colors: string[] | undefined): Gradient | undefined {
  if (!colors || colors.length < 2) return undefined;
  return { from: colors[0], to: colors[colors.length - 1] };
}

/** 该段文本的主色（用于 ruby 等单色场合） */
export function primaryColor(style: SpanStyle | undefined, fallback: string): string {
  const c = style?.colors;
  if (!c || c.length === 0) return fallback;
  return c[0];
}

/** 该段文本是否是渐变 */
export function isGradient(style: SpanStyle | undefined): boolean {
  return (style?.colors?.length ?? 0) > 1;
}

/** span 列表 -> 纯文本 */
export function spansToText(spans: TextSpan[]): string {
  return spans.map((s) => s.text).join('');
}

/** 定位 offset 落在哪个 span（及其内部偏移） */
export function locateInSpans(spans: TextSpan[], offset: number): { index: number; inner: number } {
  let acc = 0;
  for (let i = 0; i < spans.length; i++) {
    const len = spans[i].text.length;
    if (offset <= acc + len) return { index: i, inner: offset - acc };
    acc += len;
  }
  return { index: Math.max(0, spans.length - 1), inner: spans[spans.length - 1]?.text.length ?? 0 };
}

/**
 * 把纯文本变化应用到 span 列表（保留未受影响部分的样式）。
 * 用于「整段就是一个 span」的简单场景；分段编辑器则直接改单个 span 的 text。
 */
export function applyTextChange(spans: TextSpan[], nextText: string): TextSpan[] {
  const prevText = spansToText(spans);
  if (nextText === prevText) return spans;

  let prefix = 0;
  const maxPrefix = Math.min(prevText.length, nextText.length);
  while (prefix < maxPrefix && prevText[prefix] === nextText[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < Math.min(prevText.length, nextText.length) - prefix &&
    prevText[prevText.length - 1 - suffix] === nextText[nextText.length - 1 - suffix]
  ) {
    suffix++;
  }
  const removedStart = prefix;
  const removedEnd = prevText.length - suffix;
  const inserted = nextText.slice(prefix, nextText.length - suffix);

  const out: TextSpan[] = [];
  const startLoc = locateInSpans(spans, removedStart);
  const endLoc = locateInSpans(spans, removedEnd);

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    if (i < startLoc.index || i > endLoc.index) {
      out.push({ ...span });
      continue;
    }
    if (i === startLoc.index) {
      const head = span.text.slice(0, startLoc.inner);
      const tailText = i === endLoc.index ? span.text.slice(endLoc.inner) : '';
      const merged = head + inserted + tailText;
      if (merged) out.push({ ...span, text: merged });
    }
  }
  const cleaned = out.filter((s) => s.text.length > 0);
  return cleaned.length ? cleaned : [{ text: '' }];
}

/** 对 [from, to) 应用样式补丁；patch 中值为 undefined 表示删除该样式 */
export function applyStyleToRange(spans: TextSpan[], from: number, to: number, patch: Partial<SpanStyle> | null): TextSpan[] {
  if (to <= from) return spans;
  const out: TextSpan[] = [];
  let acc = 0;
  const push = (text: string, style?: SpanStyle) => {
    if (!text) return;
    const last = out[out.length - 1];
    if (last && JSON.stringify(last.style ?? {}) === JSON.stringify(style ?? {})) last.text += text;
    else out.push(style ? { text, style } : { text });
  };

  for (const span of spans) {
    const len = span.text.length;
    const s0 = acc;
    const s1 = acc + len;
    acc = s1;
    if (s1 <= from || s0 >= to) {
      push(span.text, span.style);
      continue;
    }
    const localFrom = Math.max(0, from - s0);
    const localTo = Math.min(len, to - s0);
    if (localFrom > 0) push(span.text.slice(0, localFrom), span.style);
    const mid = span.text.slice(localFrom, localTo);
    if (patch === null) {
      push(mid, undefined);
    } else {
      const next: SpanStyle = { ...(span.style ?? {}) };
      (Object.keys(patch) as (keyof SpanStyle)[]).forEach((k) => {
        const v = patch[k];
        if (v === undefined || v === null) delete next[k];
        else (next as Record<string, unknown>)[k as string] = v;
      });
      push(mid, Object.keys(next).length ? next : undefined);
    }
    if (localTo < len) push(span.text.slice(localTo), span.style);
  }
  return out.length ? out : [{ text: '' }];
}

/** 一整行的纯文本（子行之间用换行连接，仅用于列表展示） */
export function linePlainText(line: RichLine): string {
  return spansToText(line.spans);
}
