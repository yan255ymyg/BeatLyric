/**
 * 资源导入
 *
 * 需求要点：导入的图片 / 音频 / 视频会被**复制一份到项目目录**；
 * 若同名文件已存在且导入的文件并非目录内的文件，则询问是否覆盖。
 * 具体决策逻辑在 `core/storage.ts` 的 `ProjectRepository.importFile`，
 * 这里负责批量导入、同类替换清理与提示。
 */

import type { AssetKind, AssetRef, Project } from '../model/model';
import { makeRepository, useStore } from '../state/store';
import { invalidateAudio } from './audioBridge';
import { invalidatePeaks } from './waveformBridge';

export interface ImportOutcome {
  added: AssetRef[];
  reused: AssetRef[];
  skipped: string[];
  overwritten: string[];
}

export function pickFiles(accept: string, multiple: boolean): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    input.style.display = 'none';
    document.body.appendChild(input);
    let settled = false;
    const done = (files: File[]) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(files);
    };
    input.addEventListener('change', () => done([...(input.files ?? [])]));
    // 用户取消时 change 不会触发，用窗口重新聚焦兜底
    window.addEventListener(
      'focus',
      () => setTimeout(() => done([]), 800),
      { once: true },
    );
    input.click();
  });
}

export async function importFiles(files: File[], kind: AssetKind): Promise<ImportOutcome> {
  const out: ImportOutcome = { added: [], reused: [], skipped: [], overwritten: [] };
  if (!files.length) return out;

  const store = useStore.getState();
  const repo = makeRepository(store.directory);
  const seenHashes = new Set<string>();

  for (const file of files) {
    const state = useStore.getState();
    const res = await repo.importFile(file, state.project);
    if (!res.asset) continue;
    if (seenHashes.has(res.asset.sha256)) continue;
    seenHashes.add(res.asset.sha256);

    const existing = state.project.assets[res.asset.id];
    if (existing) {
      out.reused.push(res.asset);
      continue;
    }
    // 同名同内容可能命中已有资源，此时也不重复登记
    const sameHash = Object.values(state.project.assets).find((a) => a.sha256 && a.sha256 === res.asset!.sha256);
    if (sameHash) {
      out.reused.push(sameHash);
      continue;
    }

    useStore.getState().commit(`导入${kindLabel(kind)}`, (d) => {
      const asset = res.asset!;
      asset.kind = kind;
      d.assets[asset.id] = asset;
      if (kind === 'audio') d.audioAssetId = asset.id;
    });
    out.added.push(res.asset);
    if (res.skipped.length) out.skipped.push(...res.skipped);
    if (res.overwritten.length) out.overwritten.push(...res.overwritten);
  }

  const s = useStore.getState();
  if (out.added.length) {
    const replaceNote = out.overwritten.length
      ? `，覆盖了 ${out.overwritten.length} 个同名文件`
      : out.skipped.length
        ? `，保留了 ${out.skipped.length} 个原有文件`
        : '';
    s.pushToast('success', `已导入 ${out.added.length} 个${kindLabel(kind)}文件${replaceNote}`);
  } else if (out.reused.length) {
    s.pushToast('info', `素材已在项目中，直接复用（${out.reused.length} 个）`);
  }

  // 需要重新解码/重算的缓存
  out.added.forEach((a) => {
    if (a.kind === 'audio') {
      invalidateAudio(a.id);
      invalidatePeaks();
    }
  });

  return out;
}

export function kindLabel(kind: AssetKind): string {
  return kind === 'audio' ? '音频' : kind === 'video' ? '视频' : '图片';
}

/** 从项目资源表里挑选某类资源，用于下拉选择 */
export function assetsOfKind(project: Project, kind: AssetKind): AssetRef[] {
  return Object.values(project.assets)
    .filter((a) => a.kind === kind)
    .sort((a, b) => a.originalName.localeCompare(b.originalName));
}

export function assetLabel(asset: AssetRef | null | undefined): string {
  if (!asset) return '（未选择）';
  return asset.originalName;
}
