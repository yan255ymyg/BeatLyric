/**
 * 渲染层用到的少量时间轴辅助函数。
 *
 * 为什么单独放一个文件：渲染模块只需要「拍 ↔ 秒」与少量布局计算，
 * 在这里集中转出可以让依赖关系一目了然，也避免渲染层意外依赖到编辑器专用的东西。
 */

export {
  barSeconds,
  beatToBarFrac,
  beatToSeconds,
  buildBarSpans,
  computeBarLayout,
  findForceConflicts,
  forceSpanBeats,
  secondsToBeat,
  segmentAtSeconds,
  type BarLayout,
  type BarSpan,
  type Seg,
  type TickEvent,
  type Timeline,
} from '../core/timeline';

import { beatToSeconds, type Timeline } from '../core/timeline';
import type { BeatEvent } from '../model/model';

/** 安全求某拍对应的秒；不可用时返回 0 */
export function getEventSecondsSafe(tl: Timeline, beat: number): number {
  const v = beatToSeconds(tl, beat);
  return Number.isFinite(v) ? v : 0;
}

/** 事件的持续时间（拍），点事件为 0 */
export function eventDurationBeats(ev: BeatEvent): number {
  return ev.type === 'force' ? Math.max(0, (ev.data as { lengthBeats: number }).lengthBeats) : 0;
}

/** 事件是否是「持续型」（占据一段拍区间） */
export function isSpanEventType(type: BeatEvent['type']): boolean {
  return type === 'force';
}
