/**
 * 画布绘制基础设施
 *
 * 约定
 * ────
 * 所有渲染代码都以「画布逻辑坐标」工作：画布被设置为 `canvas.width = W * dpr`，
 * 并通过 `ctx.setTransform(dpr, 0, 0, dpr, 0, 0)` 把绘图坐标缩放回 W x H。
 * 这样导出（dpr=1）与预览（dpr=设备像素比）使用同一套坐标。
 */

import type { Gradient, SpanStyle } from '../model/model';
import { clamp, hexToRgb } from '../core/util';

export type Ctx2D = CanvasRenderingContext2D;

/* ------------------------------------------------------------------ */
/* 字体                                                                */
/* ------------------------------------------------------------------ */

export const CJK_FONT_STACK =
  '"Noto Sans CJK SC", "Source Han Sans SC", "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif';

export const ROMAN_FONT_STACK =
  '"Inter", "Segoe UI", "Helvetica Neue", Arial, "Noto Sans", sans-serif';

export function fontString(size: number, bold: boolean, italic = false): string {
  const style = italic ? 'italic ' : '';
  const weight = bold ? '700 ' : '400 ';
  return `${style}${weight}${size}px ${CJK_FONT_STACK}`;
}

export interface TextMeasureCacheEntry {
  width: number;
  height: number;
}

const measureCache = new Map<string, TextMeasureCacheEntry>();
let measureCtx: Ctx2D | null = null;

function getMeasureCtx(): Ctx2D {
  if (measureCtx) return measureCtx;
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 8;
  const ctx = c.getContext('2d');
  if (!ctx) throw new Error('无法获取 2D 上下文');
  measureCtx = ctx;
  return ctx;
}

/** 测量文本宽度（带缓存）。文本内容变化频繁时缓存 key 会退化，因此限制缓存大小。 */
export function measureText(text: string, size: number, bold: boolean, italic = false, letterSpacing = 0): TextMeasureCacheEntry {
  const key = `${size}|${bold ? 1 : 0}|${italic ? 1 : 0}|${letterSpacing}|${text}`;
  const hit = measureCache.get(key);
  if (hit) return hit;
  const ctx = getMeasureCtx();
  ctx.font = fontString(size, bold, italic);
  const w = ctx.measureText(text || ' ').width + letterSpacing * Math.max(0, text.length - 1);
  const entry = { width: w, height: size };
  if (measureCache.size > 4000) measureCache.clear();
  measureCache.set(key, entry);
  return entry;
}

/* ------------------------------------------------------------------ */
/* 颜色与渐变                                                          */
/* ------------------------------------------------------------------ */

export function makeVerticalGradient(
  ctx: Ctx2D,
  x: number,
  top: number,
  bottom: number,
  grad: Gradient,
): CanvasGradient {
  const g = ctx.createLinearGradient(x, top, x, bottom);
  g.addColorStop(0, grad.from);
  g.addColorStop(1, grad.to);
  return g;
}

export function styleFill(
  ctx: Ctx2D,
  style: SpanStyle | undefined,
  x: number,
  top: number,
  bottom: number,
  fallback: string,
): string | CanvasGradient {
  const colors = style?.colors;
  if (!colors || colors.length === 0) return fallback;
  if (colors.length === 1) return colors[0];
  const g = ctx.createLinearGradient(x, top, x, bottom);
  colors.forEach((c, i) => g.addColorStop(i / (colors.length - 1), c));
  return g;
}

/* ------------------------------------------------------------------ */
/* 基本图元                                                            */
/* ------------------------------------------------------------------ */

export function roundRectPath(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number): void {
  const radius = clamp(r, 0, Math.min(Math.abs(w), Math.abs(h)) / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + w - radius, y);
  ctx.arcTo(x + w, y, x + w, y + radius, radius);
  ctx.lineTo(x + w, y + h - radius);
  ctx.arcTo(x + w, y + h, x + w - radius, y + h, radius);
  ctx.lineTo(x + radius, y + h);
  ctx.arcTo(x, y + h, x, y + h - radius, radius);
  ctx.lineTo(x, y + radius);
  ctx.arcTo(x, y, x + radius, y, radius);
  ctx.closePath();
}

export function fillRoundRect(ctx: Ctx2D, x: number, y: number, w: number, h: number, r: number, fill: string | CanvasGradient): void {
  roundRectPath(ctx, x, y, w, h, r);
  ctx.fillStyle = fill;
  ctx.fill();
}

/** 带描边的文字（先把文字路径化描边，再填充，保证描边在字形外部） */
export function strokedText(
  ctx: Ctx2D,
  text: string,
  x: number,
  y: number,
  opts: { outlineWidth: number; outlineColor: string; fill: string | CanvasGradient; strokeFirst?: boolean },
): void {
  if (!text) return;
  if (opts.outlineWidth > 0 && opts.strokeFirst !== false) {
    ctx.lineJoin = 'round';
    ctx.miterLimit = 2;
    ctx.strokeStyle = opts.outlineColor;
    ctx.lineWidth = opts.outlineWidth * 2; // 一半会被字形覆盖
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = opts.fill;
  ctx.fillText(text, x, y);
}

/** 阴影辅助 */
export function withShadow(ctx: Ctx2D, enabled: boolean, color: string, blur: number, offsetY = 0, fn?: () => void): void {
  if (enabled) {
    ctx.shadowColor = color;
    ctx.shadowBlur = blur;
    ctx.shadowOffsetY = offsetY;
  }
  fn?.();
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
}

/* ------------------------------------------------------------------ */
/* 颜色工具                                                            */
/* ------------------------------------------------------------------ */

export function mixColor(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const r = Math.round(ca.r + (cb.r - ca.r) * t);
  const g = Math.round(ca.g + (cb.g - ca.g) * t);
  const bl = Math.round(ca.b + (cb.b - ca.b) * t);
  return `rgb(${r},${g},${bl})`;
}

/* ------------------------------------------------------------------ */
/* 画布准备                                                            */
/* ------------------------------------------------------------------ */

export interface CanvasSize {
  width: number;
  height: number;
}

/** 按设备像素比设置画布尺寸，并返回已经缩放好的 2D 上下文 */
export function prepareCanvas(canvas: HTMLCanvasElement, width: number, height: number, dpr = 1): Ctx2D {
  const ratio = clamp(dpr, 1, 3);
  const pxW = Math.max(1, Math.round(width * ratio));
  const pxH = Math.max(1, Math.round(height * ratio));
  if (canvas.width !== pxW) canvas.width = pxW;
  if (canvas.height !== pxH) canvas.height = pxH;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('无法获取 2D 上下文');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.textBaseline = 'alphabetic';
  return ctx;
}

/** 清空为背景色（pixelWidth/pixelHeight 为画布后备存储的实际像素尺寸） */
export function clearCanvas(
  ctx: Ctx2D,
  background: string,
  gradient?: Gradient,
  pixelWidth?: number,
  pixelHeight?: number,
): void {
  const m = ctx.getTransform();
  const w = pixelWidth ?? ctx.canvas.width;
  const h = pixelHeight ?? ctx.canvas.height;
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  if (gradient) {
    const g = ctx.createLinearGradient(0, 0, 0, h);
    g.addColorStop(0, gradient.from);
    g.addColorStop(1, gradient.to);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = background;
  }
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
  ctx.setTransform(m);
}

/** 画布尺寸测量文字（供需要按画布宽度对齐的布局使用） */
export function fitsWidth(text: string, size: number, bold: boolean, maxWidth: number): boolean {
  return measureText(text, size, bold).width <= maxWidth;
}
