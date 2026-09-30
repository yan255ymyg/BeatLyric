/**
 * 播放页面设置（含时间轴、图片、视频、频谱、特效、导出六类）
 *
 * 位置与尺寸一律使用**归一化坐标**（相对画布），这样更换画布尺寸后布局自动等比缩放：
 *   x = 0 左边缘，0.5 居中，1 右边缘
 *   y = 0 上边缘，0.5 居中，1 下边缘
 */

import { ALL_EVENT_TYPES, EVENT_META, type BeatEventType, type Project } from '../model/model';
import { uid } from '../core/util';
import { defaultAlbum, defaultExport, defaultLrcDisplay, defaultSpectrum } from '../core/factories';

export const CANVAS_PRESETS: { id: string; label: string; width: number; height: number }[] = [
  { id: '1080p', label: '1920 × 1080 (16:9)', width: 1920, height: 1080 },
  { id: '720p', label: '1280 × 720 (16:9)', width: 1280, height: 720 },
  { id: '4k', label: '3840 × 2160 (16:9)', width: 3840, height: 2160 },
  { id: '1440p', label: '2560 × 1440 (16:9)', width: 2560, height: 1440 },
  { id: 'vertical', label: '1080 × 1920 (9:16 竖屏)', width: 1080, height: 1920 },
  { id: 'square', label: '1080 × 1080 (1:1)', width: 1080, height: 1080 },
  { id: 'cinema', label: '1920 × 800 (2.40:1 宽银幕)', width: 1920, height: 800 },
];

export function applyCanvasPreset(
  update: (recipe: (draft: Project) => void) => void,
  width: number,
  height: number,
  alsoExport: boolean,
): void {
  update((d) => {
    d.canvas.width = Math.max(16, Math.round(width));
    d.canvas.height = Math.max(16, Math.round(height));
    if (alsoExport) {
      d.playback.export.width = d.canvas.width;
      d.playback.export.height = d.canvas.height;
      d.playback.export.useCanvasSize = true;
    }
  });
}

export const PAGE_BG_PRESETS = [
  { label: '深夜黑', value: '#05070c' },
  { label: '纯黑', value: '#000000' },
  { label: '石板灰', value: '#1a1d24' },
  { label: '藏青', value: '#0b1526' },
  { label: '暗红', value: '#180a0e' },
  { label: '纯白', value: '#ffffff' },
];

export { ALL_EVENT_TYPES, EVENT_META, defaultAlbum, defaultExport, defaultLrcDisplay, defaultSpectrum, uid };

export type { BeatEventType };
