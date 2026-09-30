/** 事件图标（编辑器与列表共用的小型矢量图标） */

import type { BeatEventType } from '../../model/model';

const COLORS: Record<BeatEventType, string> = {
  char: '#4ea1ff',
  bpm: '#ff9f43',
  pause: '#ffd93d',
  force: '#a06bff',
  lrcPrev: '#36d399',
  lrcNext: '#36d399',
  lrcTempStart: '#f87272',
  lrcTempEnd: '#f87272',
};

export function EventGlyph({ type, size = 12, color }: { type: BeatEventType; size?: number; color?: string }) {
  const c = color ?? COLORS[type];
  const s = size;
  const common = { width: s, height: s, viewBox: '0 0 16 16', fill: 'none' as const, stroke: c, strokeWidth: 1.6, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

  switch (type) {
    case 'char':
      return (
        <svg {...common} aria-hidden>
          <rect x="5.5" y="2.5" width="5" height="11" rx="1.6" fill={c} stroke="none" />
        </svg>
      );
    case 'bpm':
      return (
        <svg {...common} aria-hidden>
          <circle cx="5.6" cy="11.4" r="2.3" fill={c} stroke="none" />
          <path d="M7.9 11.4V3.6l4.6 1.5" />
        </svg>
      );
    case 'pause':
      return (
        <svg {...common} aria-hidden>
          <rect x="4.2" y="3.4" width="2.6" height="9.2" rx="0.7" fill={c} stroke="none" />
          <rect x="9.2" y="3.4" width="2.6" height="9.2" rx="0.7" fill={c} stroke="none" />
        </svg>
      );
    case 'force':
      return (
        <svg {...common} aria-hidden>
          <rect x="1.4" y="3.6" width="13.2" height="8.8" rx="2.2" />
          <path d="M3.6 6.4l2 1.6-2 1.6M6.8 6.4l2 1.6-2 1.6M10 6.4l2 1.6-2 1.6" />
        </svg>
      );
    case 'lrcPrev':
      return (
        <svg {...common} aria-hidden>
          <path d="M8 12.5V3.8M3.8 7.8L8 3.6l4.2 4.2" />
        </svg>
      );
    case 'lrcNext':
      return (
        <svg {...common} aria-hidden>
          <path d="M8 3.5v8.7M3.8 8.2L8 12.4l4.2-4.2" />
        </svg>
      );
    case 'lrcTempStart':
      return (
        <svg {...common} aria-hidden>
          <path d="M4.4 3.6L8.2 8l-3.8 4.4M8.4 3.6L12.2 8l-3.8 4.4" />
        </svg>
      );
    case 'lrcTempEnd':
      return (
        <svg {...common} aria-hidden>
          <path d="M11.6 3.6L7.8 8l3.8 4.4M7.6 3.6L3.8 8l3.8 4.4" />
        </svg>
      );
    default:
      return null;
  }
}

export function eventColor(type: BeatEventType): string {
  return COLORS[type];
}
