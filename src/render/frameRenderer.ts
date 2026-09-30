/**
 * 画面合成器
 *
 * 这是「播放预览」与「导出视频」**共用**的唯一渲染入口：
 * `renderFrame(project, timeline, time, resources)` 必须是一个**纯时间函数** ——
 * 给定任意时刻 t 都能画出完全确定的画面，不依赖上一帧、不依赖墙钟时间。
 * 只有满足这一点，离线逐帧导出才能与实时预览完全一致。
 *
 * 图层顺序（自下而上）
 *   背景色 → 视频背景 → 专辑图（光碟）→ 频谱 → 逐拍歌词 → 逐行歌词 → 闪光 → 火星
 */

import type { AlbumConfig, EffectConfig, Project, VideoBackgroundConfig } from '../model/model';
import type { Timeline } from '../core/timeline';
import { beatToSeconds } from '../core/timeline';
import { clamp } from '../core/util';
import { clearCanvas, fillRoundRect, roundRectPath, type Ctx2D } from './canvasKit';
import { layoutBeatLyrics, drawBeatLyrics } from './beatLyrics';
import { computeLrcLayout } from '../core/lrc';
import type { LrcState } from '../core/lrc';
import { drawLrc } from './lrcRenderer';
import { EffectsPlan, type EffectFrame } from './effects';
import { renderSpectrum, type SpectrumSource } from './spectrumRenderer';

export interface RenderResources {
  /** 视频背景（实时播放时由 video 元素提供；导出时由 seek 好的 video 提供） */
  video: HTMLVideoElement | HTMLImageElement | null;
  /** 专辑图 */
  album: HTMLImageElement | HTMLCanvasElement | null;
  /** 光碟纹理与圆形遮罩 */
  discTexture: HTMLCanvasElement | null;
  circleMask: HTMLCanvasElement | null;
  /** 频谱数据源 */
  spectrum: SpectrumSource | null;
  /** 特效计划（可选：没有时不施加特效） */
  effects: EffectsPlan | null;
}

export interface RenderOptions {
  /** 画布逻辑尺寸 */
  width: number;
  height: number;
  /** 画布坐标 -> 输出坐标的缩放（预览用 dpr，导出用 1） */
  layoutScale: number;
  /** 逐行歌词状态（时间驱动） */
  lrcState: LrcState;
  /** 调试：显示辅助网格 */
  debug?: boolean;
}

export interface FrameRenderResult {
  effectFrame: EffectFrame | null;
}

/** 供 UI 展示的临时对象，避免每帧分配 */
let effectScratch: EffectFrame | null = null;

export function renderFrame(
  ctx: Ctx2D,
  project: Project,
  timeline: Timeline,
  time: number,
  resources: RenderResources,
  opts: RenderOptions,
): FrameRenderResult {
  const { width, height, layoutScale } = opts;
  const pb = project.playback;

  // 特效求值（先算，因为整体变换要作用到所有图层）
  let frame: EffectFrame | null = null;
  if (resources.effects) {
    effectScratch = resources.effects.at(time, effectScratch ?? undefined);
    frame = effectScratch;
  }

  clearCanvas(ctx, project.canvas.background, project.canvas.gradient, ctx.canvas.width, ctx.canvas.height);

  ctx.save();
  // 整体特效变换：缩放围绕画面中心，抖动为平移
  const fx = frame;
  if (fx) {
    const s = clamp(fx.scale, 0.2, 4);
    ctx.translate(width / 2 + fx.shakeX * layoutScale + fx.offsetX * layoutScale, height / 2 + fx.shakeY * layoutScale + fx.offsetY * layoutScale);
    ctx.scale(s, s);
    ctx.translate(-width / 2, -height / 2);
  }

  // 1) 视频背景
  if (pb.video.enabled && resources.video) {
    drawVideoBackground(ctx, resources.video, width, height, pb.video);
  }

  // 2) 专辑图
  if (pb.album.enabled && resources.album) {
    drawAlbum(ctx, resources.album, resources.discTexture, resources.circleMask, width, height, pb.album, time, layoutScale);
  }

  // 3) 频谱
  if (pb.spectrum.enabled && resources.spectrum) {
    renderSpectrum(ctx, pb.spectrum, resources.spectrum, { width, height, layoutScale });
  }

  // 4) 逐拍歌词
  if (pb.beat.visibleBarCount > 0) {
    const beatLayout = layoutBeatLyrics(
      timeline,
      { time, width, height, layoutScale },
      pb.beat,
      (n) => String(n),
    );
    drawBeatLyrics(ctx, beatLayout, { cfg: pb.beat, canvasScale: layoutScale });
  }

  // 5) 逐行歌词
  const lrcLayout = computeLrcLayout(project.lines, opts.lrcState, pb.lrc);
  drawLrc(ctx, lrcLayout, project.lines, {
    pos: pb.lrc.pos,
    cfg: pb.lrc,
    canvasWidth: width,
    canvasHeight: height,
    globalScale: layoutScale,
  });

  ctx.restore();

  // 6) 闪光（不受整体变换影响）
  if (fx && fx.flashColor && fx.flashAlpha > 0.001) {
    ctx.save();
    ctx.globalAlpha = clamp(fx.flashAlpha, 0, 1);
    ctx.fillStyle = fx.flashColor;
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
  }

  // 7) 火星粒子（比例坐标 -> 画布坐标）
  if (fx && fx.particles.length) {
    ctx.save();
    for (const p of fx.particles) {
      if (p.alpha <= 0.002) continue;
      ctx.globalAlpha = clamp(p.alpha, 0, 1);
      ctx.fillStyle = p.color;
      const size = Math.max(0.6, p.size * Math.min(width, height) * 0.01);
      ctx.beginPath();
      ctx.arc(p.x * width, p.y * height, size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  if (opts.debug) drawDebugOverlay(ctx, width, height);

  return { effectFrame: frame };
}

/* ------------------------------------------------------------------ */
/* 图层实现                                                            */
/* ------------------------------------------------------------------ */

export function drawVideoBackground(
  ctx: Ctx2D,
  src: HTMLVideoElement | HTMLImageElement,
  width: number,
  height: number,
  cfg: VideoBackgroundConfig,
): void {
  const sw = src instanceof HTMLVideoElement ? src.videoWidth : src.naturalWidth || src.width;
  const sh = src instanceof HTMLVideoElement ? src.videoHeight : src.naturalHeight || src.height;
  if (!sw || !sh) return;

  const zoom = clamp(cfg.zoom, 0.1, 8);
  let dw = width;
  let dh = height;
  if (cfg.fit === 'cover') {
    const scale = Math.max(width / sw, height / sh) * zoom;
    dw = sw * scale;
    dh = sh * scale;
  } else if (cfg.fit === 'contain') {
    const scale = Math.min(width / sw, height / sh) * zoom;
    dw = sw * scale;
    dh = sh * scale;
  } else {
    dw = width * zoom;
    dh = height * zoom;
  }

  ctx.save();
  ctx.globalAlpha = clamp(cfg.opacity, 0, 1);
  try {
    ctx.drawImage(src, (width - dw) / 2, (height - dh) / 2, dw, dh);
  } catch {
    /* 视频尚未解码出帧时忽略 */
  }
  ctx.restore();
}

export function drawAlbum(
  ctx: Ctx2D,
  art: HTMLImageElement | HTMLCanvasElement,
  discTexture: HTMLCanvasElement | null,
  circleMask: HTMLCanvasElement | null,
  width: number,
  height: number,
  cfg: AlbumConfig,
  time: number,
  layoutScale: number,
): void {
  const sizePx = clamp(cfg.size, 0.01, 3) * width;
  const cx = cfg.pos.x * width;
  const cy = cfg.pos.y * height;
  const half = sizePx / 2;

  ctx.save();
  ctx.globalAlpha = clamp(cfg.opacity, 0, 1);

  if (cfg.discStyle) {
    // 黑胶：外圈纹理 + 内嵌封面（封面裁成圆）
    if (cfg.shadow) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 26 * layoutScale;
      ctx.shadowOffsetY = 8 * layoutScale;
    }
    ctx.fillStyle = cfg.discColor;
    ctx.beginPath();
    ctx.arc(cx, cy, half, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    if (discTexture) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, half, 0, Math.PI * 2);
      ctx.clip();
      ctx.globalAlpha *= 0.5;
      ctx.drawImage(discTexture, cx - half, cy - half, sizePx, sizePx);
      ctx.restore();
    }

    const artSize = sizePx * 0.62;
    ctx.save();
    const rotation = cfg.rotate ? (time * clamp(cfg.rotateSpeed, -720, 720) * Math.PI) / 180 : 0;
    ctx.translate(cx, cy);
    ctx.rotate(rotation);
    if (circleMask) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(0, 0, artSize / 2, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(art, -artSize / 2, -artSize / 2, artSize, artSize);
      ctx.restore();
    } else {
      ctx.beginPath();
      ctx.arc(0, 0, artSize / 2, 0, Math.PI * 2);
      ctx.save();
      ctx.clip();
      ctx.drawImage(art, -artSize / 2, -artSize / 2, artSize, artSize);
      ctx.restore();
    }
    // 中心圆孔
    ctx.beginPath();
    ctx.arc(0, 0, Math.max(2, sizePx * 0.02), 0, Math.PI * 2);
    ctx.fillStyle = cfg.discColor;
    ctx.fill();
    ctx.restore();
    ctx.restore();
    return;
  }

  // 方图（可圆角）
  ctx.save();
  ctx.translate(cx, cy);
  if (cfg.rotate) ctx.rotate((time * clamp(cfg.rotateSpeed, -720, 720) * Math.PI) / 180);
  const r = clamp(cfg.cornerRadius, 0, sizePx / 2);
  if (cfg.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.5)';
    ctx.shadowBlur = 24 * layoutScale;
    ctx.shadowOffsetY = 8 * layoutScale;
  }
  roundRectPath(ctx, -half, -half, sizePx, sizePx, r);
  ctx.save();
  ctx.clip();
  try {
    ctx.drawImage(art, -half, -half, sizePx, sizePx);
  } catch {
    /* 忽略 */
  }
  ctx.restore();
  ctx.restore();

  if (cfg.spinAnimation) {
    ctx.save();
    ctx.globalAlpha *= 0.18;
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1.5 * layoutScale;
    ctx.beginPath();
    ctx.arc(cx, cy, half + 6 * layoutScale, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();
}

function drawDebugOverlay(ctx: Ctx2D, width: number, height: number): void {
  ctx.save();
  ctx.strokeStyle = 'rgba(78,161,255,0.35)';
  ctx.lineWidth = 1;
  ctx.setLineDash([4, 4]);
  for (let i = 1; i < 4; i++) {
    ctx.beginPath();
    ctx.moveTo((width * i) / 4, 0);
    ctx.lineTo((width * i) / 4, height);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, (height * i) / 4);
    ctx.lineTo(width, (height * i) / 4);
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.strokeStyle = 'rgba(255,93,115,0.6)';
  ctx.strokeRect(0.5, 0.5, width - 1, height - 1);
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 辅助                                                                */
/* ------------------------------------------------------------------ */

/** 为某个时刻构造特效计划（项目或特效设置变化时重建） */
export function makeEffectsPlan(project: Project, timeline: Timeline): EffectsPlan | null {
  const enabled = project.playback.effects.filter((e: EffectConfig) => e.enabled);
  if (!enabled.length) return null;
  return new EffectsPlan(timeline, enabled, {
    width: project.canvas.width,
    height: project.canvas.height,
    beatsPerBar: project.timeline.beatsPerNewBar,
  });
}

/** 拍 -> 秒（导出时用来把事件时间换算成帧号） */
export function eventFrameIndex(timeline: Timeline, beat: number, fps: number): number {
  return Math.round(beatToSeconds(timeline, beat) * fps);
}

/** 生成光碟纹理（同心圆 + 细密纹路）——复用 media/albumArt 的缓存实现 */
export { getDiscTexture as makeDiscTexture, getCircleMask as makeCircleMask } from '../media/albumArt';

/** 画一个占位（未选择素材时） */
export function drawPlaceholder(ctx: Ctx2D, width: number, height: number, text: string): void {
  ctx.save();
  ctx.fillStyle = 'rgba(255,255,255,0.06)';
  fillRoundRect(ctx, width / 2 - 120, height / 2 - 40, 240, 80, 10, ctx.fillStyle as string);
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = '16px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(text, width / 2, height / 2 + 6);
  ctx.restore();
}
