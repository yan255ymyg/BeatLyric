/**
 * 音频桥接
 *
 * 项目里的音频资源需要被解码成 AudioBuffer，供播放引擎、波形与频谱共用。
 * 这里按资源 id 缓存解码结果，避免重复解码（解码大文件很贵）。
 */

import type { Project } from '../model/model';
import { useStore } from '../state/store';
import { decodeAudioFile } from '../media/decode';

const bufferCache = new Map<string, AudioBuffer>();
const inflight = new Map<string, Promise<AudioBuffer | null>>();

export async function fetchAudioForProject(project: Project): Promise<AudioBuffer | null> {
  const id = project.audioAssetId;
  if (!id) return null;
  const ref = project.assets[id];
  if (!ref) return null;
  const key = `${ref.id}:${ref.file}`;
  const hit = bufferCache.get(key);
  if (hit) return hit;
  const running = inflight.get(key);
  if (running) return running;

  const task = (async (): Promise<AudioBuffer | null> => {
    try {
      const blob = await useStore.getState().directory.readFile(ref.file);
      const buf = await blob.arrayBuffer();
      const decoded = await decodeAudioFile(buf);
      bufferCache.set(key, decoded);
      return decoded;
    } catch (err) {
      useStore.getState().pushToast('error', `音频「${ref.originalName}」解码失败`, String(err));
      return null;
    } finally {
      inflight.delete(key);
    }
  })();
  inflight.set(key, task);
  return task;
}

export function peekAudioForProject(project: Project): AudioBuffer | null {
  const id = project.audioAssetId;
  if (!id) return null;
  const ref = project.assets[id];
  if (!ref) return null;
  return bufferCache.get(`${ref.id}:${ref.file}`) ?? null;
}

export function invalidateAudio(assetId: string): void {
  for (const key of [...bufferCache.keys()]) {
    if (key.startsWith(`${assetId}:`)) bufferCache.delete(key);
  }
}
