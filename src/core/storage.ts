/**
 * 项目存储层
 *
 * 项目 = 一个目录（约定扩展名 `.blsp`），结构：
 *   <项目目录>/
 *     project.json         项目数据（JSON）
 *     assets/              导入的图片 / 音频 / 视频（复制进项目目录，保持原始文件名）
 *     cache/peaks-*.json   波形峰值等派生缓存
 *
 * 优先使用 File System Access API（Chrome/Edge 86+）直接读写真实目录；
 * 不支持时退化为「内存项目 + 导出 ZIP」模式，功能不丢，只是不能自动落盘。
 */

import { strToU8, zipSync, strFromU8, unzipSync } from 'fflate';
import {
  ASSET_DIR,
  PROJECT_FILE,
  type AssetKind,
  type AssetRef,
  type Project,
} from '../model/model';
import { uid } from './util';
import { serializeProject, deserializeProject } from './serialize';

/* ------------------------------------------------------------------ */
/* 类型                                                                */
/* ------------------------------------------------------------------ */

export interface DirEntryLike {
  name: string;
  kind: 'file' | 'directory';
}

/** 目录句柄的最小抽象，便于在没有 File System Access API 时替换实现 */
export interface DirectoryLike {
  readonly name: string;
  readonly kind: 'directory';
  list(): Promise<DirEntryLike[]>;
  /** 列出子目录中的条目（relDir 为空或 'assets' 等） */
  listDir(relDir: string): Promise<DirEntryLike[]>;
  readFile(relPath: string): Promise<Blob>;
  writeFile(relPath: string, data: Blob | string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  remove?(relPath: string): Promise<void>;
}

export type ImportDecision = 'overwrite' | 'keep' | 'cancel';
export type ConflictResolver = (info: {
  fileName: string;
  existingSize: number;
  incomingSize: number;
}) => Promise<ImportDecision>;

export interface ImportResult {
  asset: AssetRef | null;
  /** 因为用户选择「保留现有」而跳过的文件名 */
  skipped: string[];
  /** 被覆盖的文件名 */
  overwritten: string[];
  /** 命中的已有同名资源（未改动） */
  reused: string[];
}

/* ------------------------------------------------------------------ */
/* File System Access API 实现                                          */
/* ------------------------------------------------------------------ */

/* eslint-disable @typescript-eslint/no-explicit-any */
type FSHandle = any;

const HANDLE_DB = 'beatlyric';
const HANDLE_STORE = 'handles';
const HANDLE_KEY = 'projectDir';

function idbOpen(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(HANDLE_DB, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(HANDLE_STORE)) db.createObjectStore(HANDLE_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('无法打开 IndexedDB'));
  });
}

export function fsApiSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window && typeof indexedDB !== 'undefined';
}

/** 记住项目目录句柄，刷新页面后可以自动重新打开 */
export async function rememberDirectoryHandle(handle: FSHandle | null): Promise<void> {
  try {
    const db = await idbOpen();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readwrite');
      const store = tx.objectStore(HANDLE_STORE);
      if (handle) store.put(handle, HANDLE_KEY);
      else store.delete(HANDLE_KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error ?? new Error('写入失败'));
    });
    db.close();
  } catch {
    /* 记忆失败不影响主流程 */
  }
}

export async function recallDirectoryHandle(): Promise<FSHandle | null> {
  try {
    const db = await idbOpen();
    const handle = await new Promise<FSHandle | null>((resolve, reject) => {
      const tx = db.transaction(HANDLE_STORE, 'readonly');
      const req = tx.objectStore(HANDLE_STORE).get(HANDLE_KEY);
      req.onsuccess = () => resolve((req.result as FSHandle) ?? null);
      req.onerror = () => reject(req.error ?? new Error('读取失败'));
    });
    db.close();
    return handle;
  } catch {
    return null;
  }
}

/** 包装真实的 FileSystemDirectoryHandle */
export class FsDirectory implements DirectoryLike {
  readonly kind = 'directory' as const;

  constructor(readonly handle: FSHandle) {}

  get name(): string {
    return this.handle.name as string;
  }

  async list(): Promise<DirEntryLike[]> {
    const out: DirEntryLike[] = [];
    for await (const [name, h] of this.handle.entries() as AsyncIterable<[string, FSHandle]>) {
      out.push({ name, kind: h.kind === 'directory' ? 'directory' : 'file' });
    }
    return out;
  }

  async listDir(relDir: string): Promise<DirEntryLike[]> {
    const parts = relDir.split('/').filter(Boolean);
    let dir: FSHandle = this.handle;
    for (const part of parts) {
      try {
        dir = await dir.getDirectoryHandle(part, { create: false });
      } catch {
        return [];
      }
    }
    const out: DirEntryLike[] = [];
    for await (const [name, h] of dir.entries() as AsyncIterable<[string, FSHandle]>) {
      out.push({ name, kind: h.kind === 'directory' ? 'directory' : 'file' });
    }
    return out;
  }

  private async resolveDir(relPath: string, create: boolean): Promise<FSHandle> {
    const parts = relPath.split('/').filter(Boolean);
    parts.pop();
    let dir: FSHandle = this.handle;
    for (const part of parts) {
      dir = await dir.getDirectoryHandle(part, { create });
    }
    return dir;
  }

  async readFile(relPath: string): Promise<Blob> {
    const dir = await this.resolveDir(relPath, false);
    const name = relPath.split('/').filter(Boolean).pop() as string;
    const fh = await dir.getFileHandle(name, { create: false });
    return (await fh.getFile()) as Blob;
  }

  async writeFile(relPath: string, data: Blob | string): Promise<void> {
    const dir = await this.resolveDir(relPath, true);
    const name = relPath.split('/').filter(Boolean).pop() as string;
    const fh = await dir.getFileHandle(name, { create: true });
    const writable = await fh.createWritable();
    await writable.write(data);
    await writable.close();
  }

  async exists(relPath: string): Promise<boolean> {
    try {
      const dir = await this.resolveDir(relPath, false);
      const name = relPath.split('/').filter(Boolean).pop() as string;
      await dir.getFileHandle(name, { create: false });
      return true;
    } catch {
      return false;
    }
  }

  async remove(relPath: string): Promise<void> {
    try {
      const dir = await this.resolveDir(relPath, false);
      const name = relPath.split('/').filter(Boolean).pop() as string;
      await dir.removeEntry(name);
    } catch {
      /* 忽略 */
    }
  }
}

/** 内存目录（不支持 File System Access API 或用户选择不落盘时使用） */
export class MemoryDirectory implements DirectoryLike {
  readonly kind = 'directory' as const;
  private files = new Map<string, Blob>();

  constructor(readonly name = '未保存项目.blsp') {}

  async list(): Promise<DirEntryLike[]> {
    const names = new Set<string>();
    for (const key of this.files.keys()) names.add(key.split('/')[0]);
    return [...names].map((n) => ({ name: n, kind: 'directory' as const }));
  }

  async listDir(relDir: string): Promise<DirEntryLike[]> {
    const prefix = relDir ? `${relDir.replace(/\/+$/, '')}/` : '';
    const out = new Map<string, DirEntryLike>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { name: rest, kind: 'file' });
      else out.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'directory' });
    }
    return [...out.values()];
  }

  async readFile(relPath: string): Promise<Blob> {
    const b = this.files.get(relPath);
    if (!b) throw new Error(`文件不存在：${relPath}`);
    return b;
  }

  async writeFile(relPath: string, data: Blob | string): Promise<void> {
    this.files.set(relPath, typeof data === 'string' ? new Blob([data], { type: 'application/json' }) : data);
  }

  async exists(relPath: string): Promise<boolean> {
    return this.files.has(relPath);
  }

  async remove(relPath: string): Promise<void> {
    this.files.delete(relPath);
  }

  /** 列出所有文件路径（用于保存为 ZIP） */
  filePaths(): string[] {
    return [...this.files.keys()].filter((p) => p !== PROJECT_FILE).sort();
  }

  blobOf(relPath: string): Blob | undefined {
    return this.files.get(relPath);
  }

  /** 用 ZIP 内容填充（打开 .blsp 压缩包时使用） */
  loadZip(bytes: Uint8Array): void {
    const entries = unzipSync(bytes);
    for (const [name, data] of Object.entries(entries)) {
      if (name.endsWith('/')) continue;
      this.files.set(name, new Blob([data as BlobPart]));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 文件工具                                                            */
/* ------------------------------------------------------------------ */

/** 清洗文件名：去掉路径分隔符与非法字符，保留原始可读性 */
export function sanitizeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? name;
  const cleaned = base
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || `file-${uid('a')}`;
}

export async function sha256Hex(data: ArrayBuffer | Blob): Promise<string> {
  const buf = data instanceof Blob ? await data.arrayBuffer() : data;
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', buf);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  // 退化实现（仅用于极旧环境）：FNV-1a 变体，只保证内容变化时结果变化
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  const view = new Uint8Array(buf);
  for (let i = 0; i < view.length; i++) {
    h1 = (h1 ^ view[i]) * 16777619;
    h2 = (h2 + view[i] * (i + 1)) >>> 0;
  }
  return `fnv${(h1 >>> 0).toString(16)}${h2.toString(16)}`;
}

export function guessKind(mime: string, fileName: string): AssetKind {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('image/')) return 'image';
  const ext = (fileName.split('.').pop() ?? '').toLowerCase();
  if (['mp3', 'wav', 'ogg', 'm4a', 'aac', 'flac', 'opus', 'webm'].includes(ext)) return 'audio';
  if (['mp4', 'mov', 'mkv', 'avi', 'm4v'].includes(ext)) return 'video';
  return 'image';
}

/** 资源在项目目录中的相对路径 */
export function assetRelPath(fileName: string): string {
  return `${ASSET_DIR}/${fileName}`;
}

export function findAssetByHash(project: Project, hash: string): AssetRef | null {
  for (const ref of Object.values(project.assets)) {
    if (ref.sha256 && ref.sha256 === hash) return ref;
  }
  return null;
}

export function findAssetByFile(project: Project, relPath: string): AssetRef | null {
  for (const ref of Object.values(project.assets)) {
    if (ref.file === relPath) return ref;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 项目文件仓储                                                        */
/* ------------------------------------------------------------------ */

export interface SaveResult {
  ok: boolean;
  /** 出错时的可读说明 */
  error?: string;
}

/**
 * 项目仓储：负责 project.json 的读写与资源导入。
 */
export class ProjectRepository {
  constructor(
    private dir: DirectoryLike,
    private onConflict: ConflictResolver,
  ) {}

  get directory(): DirectoryLike {
    return this.dir;
  }

  setDirectory(dir: DirectoryLike): void {
    this.dir = dir;
  }

  async hasProject(): Promise<boolean> {
    return this.dir.exists(PROJECT_FILE);
  }

  async listAllFiles(): Promise<Set<string>> {
    const files = new Set<string>();
    const entries = await this.dir.list().catch(() => [] as DirEntryLike[]);
    for (const e of entries) {
      if (e.kind === 'file') files.add(e.name);
    }
    const assets = await this.dir.listDir(ASSET_DIR).catch(() => [] as DirEntryLike[]);
    for (const e of assets) {
      if (e.kind === 'file') files.add(`${ASSET_DIR}/${e.name}`);
    }
    const cache = await this.dir.listDir('cache').catch(() => [] as DirEntryLike[]);
    for (const e of cache) {
      if (e.kind === 'file') files.add(`cache/${e.name}`);
    }
    return files;
  }

  /** 列出 assets/ 目录中已存在的文件名 */
  async listAssetNames(): Promise<Set<string>> {
    const out = new Set<string>();
    const entries = await this.dir.listDir(ASSET_DIR).catch(() => [] as DirEntryLike[]);
    for (const e of entries) {
      if (e.kind === 'file') out.add(e.name);
    }
    return out;
  }

  async readProjectText(): Promise<string> {
    const blob = await this.dir.readFile(PROJECT_FILE);
    return await blob.text();
  }

  async loadProject(): Promise<Project> {
    const text = await this.readProjectText();
    return deserializeProject(text).project;
  }

  async saveProject(project: Project): Promise<SaveResult> {
    try {
      await this.dir.writeFile(PROJECT_FILE, serializeProject(project));
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async writeDerived(relPath: string, text: string): Promise<SaveResult> {
    try {
      await this.dir.writeFile(relPath, text);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async readDerived(relPath: string): Promise<string | null> {
    try {
      return await (await this.dir.readFile(relPath)).text();
    } catch {
      return null;
    }
  }

  /**
   * 把一个用户选择的文件导入项目。
   *
   * 规则（对应需求）：
   *  1. 导入的文件会被复制一份到项目目录的 assets/ 下。
   *  2. 若同名文件已存在，**且导入的文件并非目录内的文件**，则询问是否覆盖。
   *     - 若内容相同（哈希一致）：静默复用，不打扰用户。
   *     - 若用户选择覆盖：写入新内容并更新资源记录。
   *     - 若用户选择保留：不写入，沿用已有资源记录。
   *  3. 资源在项目内按内容去重（同一文件重复导入只占一份）。
   */
  async importFile(file: File, project: Project): Promise<ImportResult> {
    const result: ImportResult = { asset: null, skipped: [], overwritten: [], reused: [] };
    const fileName = sanitizeFileName(file.name);
    const relPath = assetRelPath(fileName);
    const buffer = await file.arrayBuffer();
    const hash = await sha256Hex(buffer.slice(0));

    // 1) 内容已在项目内：直接复用，不产生新文件
    const byHash = findAssetByHash(project, hash);
    if (byHash) {
      result.asset = byHash;
      result.reused.push(fileName);
      return result;
    }

    const existing = await this.dir.exists(relPath);
    if (existing) {
      const existingBlob = await this.dir.readFile(relPath).catch(() => null);
      const existingHash = existingBlob ? await sha256Hex(existingBlob) : '';
      if (existingHash && existingHash === hash) {
        // 同名同内容：静默复用
        const known = findAssetByFile(project, relPath);
        const ref: AssetRef = known ?? {
          id: uid('asset'),
          kind: guessKind(file.type, fileName),
          file: relPath,
          originalName: file.name,
          mime: file.type || 'application/octet-stream',
          size: buffer.byteLength,
          sha256: hash,
          addedAt: Date.now(),
        };
        result.asset = ref;
        result.reused.push(fileName);
        return result;
      }
      const decision = await this.onConflict({
        fileName,
        existingSize: existingBlob?.size ?? 0,
        incomingSize: buffer.byteLength,
      });
      if (decision === 'cancel') return result;
      if (decision === 'keep') {
        const known = findAssetByFile(project, relPath);
        if (known) {
          result.asset = known;
          result.skipped.push(fileName);
          return result;
        }
        // 目录里有同名文件但项目并不认识它：换个名字写入，避免破坏现有文件
        const alt = await this.uniqueName(fileName, hash);
        await this.dir.writeFile(assetRelPath(alt), new Blob([buffer], { type: file.type }));
        result.skipped.push(fileName);
        result.asset = this.makeRef(alt, file, buffer, hash);
        return result;
      }
      result.overwritten.push(fileName);
      await this.dir.writeFile(relPath, new Blob([buffer], { type: file.type }));
      result.asset = this.makeRef(fileName, file, buffer, hash);
      return result;
    }

    await this.dir.writeFile(relPath, new Blob([buffer], { type: file.type }));
    result.asset = this.makeRef(fileName, file, buffer, hash);
    return result;
  }

  private makeRef(fileName: string, file: File, buffer: ArrayBuffer, hash: string): AssetRef {
    return {
      id: uid('asset'),
      kind: guessKind(file.type, fileName),
      file: assetRelPath(fileName),
      originalName: file.name,
      mime: file.type || 'application/octet-stream',
      size: buffer.byteLength,
      sha256: hash,
      addedAt: Date.now(),
    };
  }

  /** 生成一个未占用的文件名：name-<hash 前 6 位>.ext */
  private async uniqueName(fileName: string, hash: string): Promise<string> {
    const dot = fileName.lastIndexOf('.');
    const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
    const ext = dot > 0 ? fileName.slice(dot) : '';
    for (let i = 0; i < 50; i++) {
      const suffix = i === 0 ? hash.slice(0, 6) : `${hash.slice(0, 6)}-${i}`;
      const candidate = `${stem}-${suffix}${ext}`;
      if (!(await this.dir.exists(assetRelPath(candidate)))) return candidate;
    }
    return `${stem}-${uid('f')}${ext}`;
  }

  async readAsset(relPath: string): Promise<Blob> {
    return this.dir.readFile(relPath);
  }

  /** 把项目打包为 ZIP（内存模式下「保存为文件」、以及备份用） */
  async exportZip(project: Project): Promise<Blob> {
    const files: Record<string, Uint8Array> = {};
    files[PROJECT_FILE] = strToU8(serializeProject(project));
    for (const ref of Object.values(project.assets)) {
      try {
        const blob = await this.dir.readFile(ref.file);
        files[ref.file] = new Uint8Array(await blob.arrayBuffer());
      } catch {
        /* 缺失的资源跳过，不阻塞导出 */
      }
    }
    if (this.dir instanceof MemoryDirectory) {
      for (const p of this.dir.filePaths()) {
        if (p in files) continue;
        const blob = this.dir.blobOf(p);
        if (blob) files[p] = new Uint8Array(await blob.arrayBuffer());
      }
    }
    return new Blob([zipSync(files, { level: 6 }) as BlobPart], { type: 'application/zip' });
  }

  /** 从 ZIP 载入到内存目录（用于打开 .blsp 压缩包） */
  static openZip(bytes: Uint8Array, name: string): { dir: MemoryDirectory; text: string } {
    const dir = new MemoryDirectory(name);
    dir.loadZip(bytes);
    const entries = unzipSync(bytes);
    const textEntry = entries[PROJECT_FILE];
    if (!textEntry) throw new Error('这个压缩包里没有 project.json，无法作为项目打开。');
    return { dir, text: strFromU8(textEntry) };
  }
}

/** 触发浏览器下载 */
export function downloadBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** 弹出目录选择器 */
export async function pickDirectory(): Promise<FsDirectory | null> {
  if (!fsApiSupported()) return null;
  const handle = await (window as unknown as { showDirectoryPicker: (o?: unknown) => Promise<FSHandle> }).showDirectoryPicker({
    id: 'beatlyric-project',
    mode: 'readwrite',
  });
  return new FsDirectory(handle);
}
