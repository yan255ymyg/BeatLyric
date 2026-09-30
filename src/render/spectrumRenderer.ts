/**
 * 频谱图绘制
 *
 * 数据来源由调用方提供（`SpectrumSource.sample()`），
 * 这样实时预览（AnalyserNode）与离线导出（OfflineSpectrum）可以共用同一套绘制代码。
 */

import type { SpectrumConfig } from '../model/model';
import { clamp } from '../core/util';
import { type Ctx2D } from './canvasKit';

export interface SpectrumSource {
  /** 列数（应与配置一致） */
  readonly columns: number;
  /** 取当前时刻的频谱列，值域 0..1；可复用 out 缓冲区 */
  sample(out?: Float32Array): Float32Array;
}

export interface SpectrumDrawContext {
  width: number;
  height: number;
  layoutScale: number;
}

export function renderSpectrum(
  ctx: Ctx2D,
  cfg: SpectrumConfig,
  source: SpectrumSource,
  dctx: SpectrumDrawContext,
): void {
  const columns = Math.max(4, Math.min(cfg.columns, 512));
  const values = source.sample();
  if (!values || values.length === 0) return;

  const areaW = clamp(cfg.width, 0.01, 4) * dctx.width;
  const areaH = clamp(cfg.height, 0.01, 4) * dctx.height;
  const x0 = cfg.pos.x * dctx.width - areaW / 2;
  const y0 = cfg.pos.y * dctx.height - areaH / 2;

  const horizontal = cfg.direction === 'left' || cfg.direction === 'right';
  const slots = horizontal ? Math.max(1, Math.round(areaH / Math.max(1, areaW / columns))) : columns;
  const count = Math.min(slots, values.length);
  const step = (horizontal ? areaH : areaW) / count;
  const gap = clamp(cfg.barGap, 0, 0.9);
  const thickness = Math.max(1, step * (1 - gap));

  ctx.save();
  ctx.globalAlpha = clamp(cfg.opacity, 0, 1);

  const makeFill = (top: number, bottom: number): string | CanvasGradient => {
    if (!cfg.gradient) return cfg.color;
    const g = ctx.createLinearGradient(0, top, 0, bottom);
    g.addColorStop(0, cfg.color);
    g.addColorStop(1, cfg.colorTo);
    return g;
  };

  const style = cfg.style;

  for (let i = 0; i < count; i++) {
    const idx = Math.min(values.length - 1, Math.round((i / Math.max(1, count - 1)) * (values.length - 1)));
    const raw = clamp(values[idx] * clamp(cfg.gain, 0, 20), 0, 1);
    const v = Math.pow(raw, 0.85);

    if (!horizontal) {
      const x = x0 + i * step + (step - thickness) / 2;
      const full = areaH;
      const h = Math.max(1, v * full);
      const up = cfg.direction === 'up';
      const top = up ? y0 + full - h : y0;
      const fill = makeFill(top, top + h);
      ctx.fillStyle = fill;
      if (style === 'mirror') {
        const half = Math.max(1, (v * full) / 2);
        ctx.fillRect(x, y0 + full / 2 - half, thickness, half * 2);
      } else if (style === 'dots') {
        const dot = Math.max(1, thickness * 0.9);
        const n = Math.max(1, Math.round(v * 16));
        for (let k = 0; k < n; k++) {
          const t = k / 16;
          const yy = up ? y0 + full - t * full : y0 + t * full;
          ctx.fillRect(x + (thickness - dot) / 2, yy, dot, dot);
        }
      } else if (style === 'wave') {
        ctx.fillRect(x, y0 + full / 2 - h / 2, thickness, Math.max(1, h));
      } else {
        ctx.fillRect(x, top, thickness, h);
      }
      if (cfg.outline) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(x, top, thickness, h);
      }
    } else {
      const y = y0 + i * step + (step - thickness) / 2;
      const right = cfg.direction === 'right';
      const full = areaW;
      const w = Math.max(1, v * full);
      const left = right ? x0 : x0 + full - w;
      const fill = makeFill(y, y + thickness);
      ctx.fillStyle = fill;
      if (style === 'mirror') {
        const half = Math.max(1, (v * full) / 2);
        ctx.fillRect(x0 + full / 2 - half, y, half * 2, thickness);
      } else if (style === 'dots') {
        const dot = Math.max(1, thickness * 0.9);
        const n = Math.max(1, Math.round(v * 16));
        for (let k = 0; k < n; k++) {
          const t = k / 16;
          const xx = right ? x0 + t * full : x0 + full - t * full;
          ctx.fillRect(xx, y + (thickness - dot) / 2, dot, dot);
        }
      } else if (style === 'wave') {
        ctx.fillRect(x0 + full / 2 - w / 2, y, Math.max(1, w), thickness);
      } else {
        ctx.fillRect(left, y, w, thickness);
      }
      if (cfg.outline) {
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.lineWidth = 1;
        ctx.strokeRect(left, y, w, thickness);
      }
    }
  }

  ctx.restore();
}

/** 由「离线频谱」构造渲染数据源 */
export function offlineSpectrumSource(
  sampler: (t: number, out?: Float32Array) => Float32Array,
  time: number,
  columns: number,
): SpectrumSource {
  let scratch: Float32Array | null = null;
  return {
    columns,
    sample(out?: Float32Array): Float32Array {
      const target = out ?? scratch ?? new Float32Array(columns);
      scratch = target;
      return sampler(time, target);
    },
  };
}

/** 由「实时分析器」构造渲染数据源 */
export function realtimeSpectrumSource(
  analyser: { getFloatFrequencyData(array: Float32Array): void; frequencyBinCount: number; context: BaseAudioContext; fftSize: number },
  mapBands: (magnitudes: Float32Array, out?: Float32Array) => Float32Array,
  columns: number,
): SpectrumSource {
  const bins = new Float32Array(analyser.frequencyBinCount);
  let scratch: Float32Array | null = null;
  return {
    columns,
    sample(out?: Float32Array): Float32Array {
      const target = out ?? scratch ?? new Float32Array(columns);
      scratch = target;
      analyser.getFloatFrequencyData(bins);
      return mapBands(bins, target);
    },
  };
}
