/**
 * 资源 URL 管理
 *
 * 项目资源存在项目目录里（File System Access）或内存里，画布与 <video> 无法直接使用，
 * 因此这里把 Blob 转成 object URL 并按资源 id 缓存；资源表变化时清理失效的 URL，
 * 避免长期编辑造成内存泄漏。
 */

import type { AssetRef, Project } from '../model/model';
import { useStore } from '../state/store';

const urlCache = new Map<string, string>();
const pending = new Map<string, Promise<string | null>>();

export async function getAssetUrl(asset: AssetRef): Promise<string | null> {
  const key = `${asset.id}:${asset.file}`;
  const hit = urlCache.get(key);
  if (hit) return hit;
  const inflight = pending.get(key);
  if (inflight) return inflight;

  const task = (async () => {
    try {
      const blob = await useStore.getState().directory.readFile(asset.file);
      const url = URL.createObjectURL(blob);
      urlCache.set(key, url);
      return url;
    } catch {
      return null;
    } finally {
      pending.delete(key);
    }
  })();
  pending.set(key, task);
  return task;
}

/** 资源表变化后释放不再需要的 URL */
export function pruneAssetUrls(project: Project): void {
  const alive = new Set<string>();
  for (const ref of Object.values(project.assets)) alive.add(`${ref.id}:${ref.file}`);
  for (const key of [...urlCache.keys()]) {
    if (!alive.has(key)) {
      const url = urlCache.get(key);
      if (url) URL.revokeObjectURL(url);
      urlCache.delete(key);
    }
  }
}

export function clearAssetUrls(): void {
  urlCache.forEach((url) => URL.revokeObjectURL(url));
  urlCache.clear();
}

/** 同步获取（已缓存时），供渲染循环内使用 */
export function peekAssetUrl(assetId: string | null): string | null {
  if (!assetId) return null;
  for (const [key, url] of urlCache) {
    if (key.startsWith(`${assetId}:`)) return url;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 图片 / 视频元素缓存                                                 */
/* ------------------------------------------------------------------ */

const imageCache = new Map<string, HTMLImageElement>();
const videoCache = new Map<string, HTMLVideoElement>();

export function peekImage(assetId: string | null): HTMLImageElement | null {
  if (!assetId) return null;
  return imageCache.get(assetId) ?? null;
}

export function peekVideo(assetId: string | null): HTMLVideoElement | null {
  if (!assetId) return null;
  return videoCache.get(assetId) ?? null;
}

export async function loadImageAsset(asset: AssetRef): Promise<HTMLImageElement | null> {
  const hit = imageCache.get(asset.id);
  if (hit) return hit;
  const url = await getAssetUrl(asset);
  if (!url) return null;
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      imageCache.set(asset.id, img);
      resolve(img);
    };
    img.onerror = () => resolve(null);
    img.src = url;
  });
}

export async function loadVideoAsset(asset: AssetRef): Promise<HTMLVideoElement | null> {
  const hit = videoCache.get(asset.id);
  if (hit) return hit;
  const url = await getAssetUrl(asset);
  if (!url) return null;
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.muted = true;
    v.playsInline = true;
    v.preload = 'auto';
    v.loop = true;
    v.crossOrigin = 'anonymous';
    v.onloadedmetadata = () => {
      videoCache.set(asset.id, v);
      resolve(v);
    };
    v.onerror = () => resolve(null);
    v.src = url;
  });
}

export function disposeMediaCaches(): void {
  imageCache.clear();
  videoCache.forEach((v) => {
    v.pause();
    v.removeAttribute('src');
    v.load();
  });
  videoCache.clear();
}
