/** 时间轴时长：取「歌词时间轴终点」与「音频时长」的较大者 */

import type { Project } from '../model/model';
import { getTimeline } from '../state/store';

export function timelineDurationSafe(project: Project): number {
  return Math.max(0, getTimeline(project).endSec);
}

/** 可用于播放的最大时间（含音频尾巴） */
export function playableDuration(project: Project, audioDuration: number): number {
  const tlEnd = timelineDurationSafe(project);
  const audioEnd = Math.max(0, audioDuration - project.timeline.audioOffsetMs / 1000);
  return Math.max(tlEnd, audioEnd);
}

/** 格式化时间码 mm:ss.mmm */
export function formatTimecode(sec: number): string {
  if (!Number.isFinite(sec)) return '--:--.---';
  const s = Math.max(0, sec);
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${String(m).padStart(2, '0')}:${rest.toFixed(3).padStart(6, '0')}`;
}

/** 格式化拍号（1 基显示） */
export function formatBeatDisplay(beatInBar: number, digits = 2): string {
  return (beatInBar + 1).toFixed(digits).replace(/\.?0+$/, '');
}
