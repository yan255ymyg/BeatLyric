/**
 * 波形峰值桥接
 *
 * 音频解码后计算峰值并缓存到项目目录（cache/peaks-*.json），
 * 编辑器与时间轴需要波形时从这里同步/异步读取。
 */

import { useStore } from '../state/store';
import { computePeaks, decodePeaks, encodePeaks } from '../media/decode';
import { fetchAudioForProject } from './audioBridge';
import type { Project } from '../model/model';

const peaksCache = new Map<string, Float32Array>();

export const PEAK_BINS = 4096;

export function peekSharedPeaks(project: Project): Float32Array | null {
  if (!project.peaksFile) return null;
  return peaksCache.get(project.peaksFile) ?? null;
}

export function setSharedPeaks(file: string, peaks: Float32Array): void {
  peaksCache.set(file, peaks);
}

/** 确保峰值可用：优先读缓存文件，缺失则重新计算并落盘 */
export async function ensurePeaks(): Promise<Float32Array | null> {
  const state = useStore.getState();
  const project = state.project;
  if (project.peaksFile && peaksCache.has(project.peaksFile)) return peaksCache.get(project.peaksFile)!;

  const buffer = await fetchAudioForProject(project);
  if (!buffer) return null;

  if (project.peaksFile) {
    try {
      const text = await state.directory.readFile(project.peaksFile).then((b: Blob) => b.text());
      const peaks = decodePeaks(text);
      peaksCache.set(project.peaksFile, peaks);
      return peaks;
    } catch {
      /* 文件缺失，继续重算 */
    }
  }

  const peaks = computePeaks(buffer, PEAK_BINS);
  const file = `cache/peaks-${buffer.length}-${PEAK_BINS}.json`;
  peaksCache.set(file, peaks);
  try {
    await state.directory.writeFile(file, encodePeaks(peaks));
  } catch {
    /* 缓存写入失败不影响使用 */
  }
  if (state.project.peaksFile !== file) {
    state.commit('记录波形缓存', (d: Project) => {
      d.peaksFile = file;
    });
  }
  return peaks;
}

export function invalidatePeaks(): void {
  peaksCache.clear();
}
