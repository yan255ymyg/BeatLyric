/**
 * 全局状态仓库
 *
 * 设计
 * ────
 * - 项目数据是**不可变**的：任何编辑都通过 `commit(label, recipe)` 产生一份新 Project，
 *   同时把上一份压入撤销栈。撤销/重做因此是完全免费的。
 * - 注意：`recipe` 收到的是一份深拷贝（draft），可以随意就地修改。
 * - 小节内事件位置 `BeatEvent.beat` 使用**全局拍号**（第 1 小节第 1 拍 = 0），
 *   UI 里显示的小节内拍号 = beat - span.startBeat + 1。
 * - 派生时间轴用 WeakMap 按 Project 对象缓存（Project 不可变，天然安全）。
 */

import { create } from 'zustand';
import type {
  Bar,
  BeatEvent,
  BeatEventType,
  EffectConfig,
  LyricLine,
  PlaybackConfig,
  Project,
  RichLine,
} from '../model/model';
import { createProject, defaultEventData } from '../core/factories';
import { deepClone, uid } from '../core/util';
import { buildTimeline, findForceConflicts, type BarSpan, type Timeline } from '../core/timeline';
import { MemoryDirectory, ProjectRepository, type DirectoryLike, type ImportDecision } from '../core/storage';
import { computePeaks, encodePeaks } from '../media/decode';

export type EditorPage = 'lyrics' | 'player';
export type LyricsTab = 'beat' | 'line';
export type PlayerToolbarTab =
  | 'canvas'
  | 'album'
  | 'beat'
  | 'line'
  | 'background'
  | 'effects'
  | 'spectrum'
  | 'export';

export interface ToastMessage {
  id: string;
  kind: 'info' | 'success' | 'warn' | 'error';
  text: string;
  detail?: string;
}

export interface ConflictRequest {
  fileName: string;
  existingSize: number;
  incomingSize: number;
  resolve: (d: ImportDecision) => void;
}

export interface ProgressInfo {
  active: boolean;
  title: string;
  detail: string;
  value: number;
  total: number;
}

interface HistoryEntry {
  label: string;
  project: Project;
}

const HISTORY_LIMIT = 120;

export interface AppState {
  project: Project;
  /** 当前项目目录（内存或磁盘） */
  directory: DirectoryLike;
  /** 项目是否已落盘 */
  persisted: boolean;
  dirty: boolean;
  lastSavedAt: number | null;

  page: EditorPage;
  lyricsTab: LyricsTab;
  playerToolbarTab: PlayerToolbarTab;

  /** 选中的小节（点击小节背景） */
  selectedBarId: string | null;
  /** 选中的事件（可多选）；与 selectedBarId 是两套独立的状态 */
  selectedEventIds: string[];
  selectedLineId: string | null;

  /** 剪贴板（复制的事件副本） */
  clipboard: BeatEvent[];

  /** 当前编辑的吸附分母：>0 表示 1/snap；0 表示使用 timeline.customSnap */
  snap: number;

  playing: boolean;
  positionSec: number;
  previewFollow: boolean;

  history: { past: HistoryEntry[]; future: HistoryEntry[] };

  toasts: ToastMessage[];
  conflict: ConflictRequest | null;
  progress: ProgressInfo | null;

  /* ---- 动作 ---- */
  commit: (label: string, recipe: (draft: Project) => void) => void;
  undo: () => void;
  redo: () => void;

  replaceProject: (project: Project, opts?: { persisted?: boolean; dir?: DirectoryLike }) => void;
  markSaved: () => void;

  setPage: (page: EditorPage) => void;
  setLyricsTab: (tab: LyricsTab) => void;
  setPlayerToolbarTab: (tab: PlayerToolbarTab) => void;
  selectBar: (id: string | null) => void;
  selectEvent: (id: string | null, additive?: boolean) => void;
  selectEvents: (ids: string[]) => void;
  clearEventSelection: () => void;
  selectLine: (id: string | null) => void;
  setSnap: (snap: number) => void;

  copySelectedEvents: () => void;
  pasteEvents: (targetBarId?: string | null) => void;
  deleteSelectedEvents: () => void;

  setPlaying: (playing: boolean) => void;
  togglePlaying: () => void;
  setPositionSec: (sec: number) => void;
  setPreviewFollow: (v: boolean) => void;

  pushToast: (kind: ToastMessage['kind'], text: string, detail?: string) => void;
  dismissToast: (id: string) => void;
  setConflict: (req: ConflictRequest | null) => void;
  setProgress: (p: ProgressInfo | null) => void;

  /* ---- 小节 ---- */
  addBar: (atIndex?: number) => void;
  removeBar: (barId: string) => void;
  moveBar: (barId: number, delta: number) => void;
  setBarBeatCount: (barId: string, count: number) => void;
  setBarTransform: (barId: string, patch: { scaleX?: number; offsetX?: number }) => void;
  addEvent: (barId: string, type: BeatEventType, beat: number) => string;
  updateEvent: (barId: string, eventId: string, recipe: (ev: BeatEvent) => void) => void;
  removeEvent: (barId: string, eventId: string) => void;
  removeEvents: (eventIds: string[]) => void;
  moveEvent: (eventId: string, targetBarId: string, beat: number) => void;

  /* ---- 逐行歌词 ---- */
  addLine: (afterLineId?: string | null) => string;
  removeLine: (lineId: string) => void;
  duplicateLine: (lineId: string) => void;
  moveLine: (lineId: string, delta: number) => void;

  /* ---- 播放设置 ---- */
  updatePlayback: (recipe: (draft: PlaybackConfig) => void) => void;
  updateEffect: (id: string, recipe: (fx: EffectConfig) => void) => void;
  addEffect: () => void;
  removeEffect: (id: string) => void;
}

const initialProject = createProject('未命名项目');

/** 供 ProjectRepository 使用的共享冲突解决器（由 UI 设置） */
let conflictResolver: (info: { fileName: string; existingSize: number; incomingSize: number }) => Promise<ImportDecision> =
  async () => 'overwrite';

export function setConflictResolver(fn: typeof conflictResolver): void {
  conflictResolver = fn;
}

export function makeRepository(dir: DirectoryLike): ProjectRepository {
  return new ProjectRepository(dir, (info) => conflictResolver(info));
}

export const useStore = create<AppState>((set, get) => ({
  project: initialProject,
  directory: new MemoryDirectory(),
  persisted: false,
  dirty: false,
  lastSavedAt: null,

  page: 'lyrics',
  lyricsTab: 'beat',
  playerToolbarTab: 'canvas',

  selectedBarId: initialProject.bars[0]?.id ?? null,
  selectedEventIds: [],
  selectedLineId: null,
  clipboard: [],
  snap: initialProject.timeline.defaultSnap,

  playing: false,
  positionSec: 0,
  previewFollow: true,

  history: { past: [], future: [] },
  toasts: [],
  conflict: null,
  progress: null,

  commit: (label, recipe) => {
    const state = get();
    const next = deepClone(state.project);
    recipe(next);
    next.meta = { ...next.meta, updatedAt: Date.now() };
    const entry: HistoryEntry = { label, project: state.project };
    const past = [...state.history.past, entry].slice(-HISTORY_LIMIT);
    set({ project: next, history: { past, future: [] }, dirty: true });
  },

  undo: () => {
    const { history, project } = get();
    if (!history.past.length) return;
    const entry = history.past[history.past.length - 1];
    set({
      project: entry.project,
      history: {
        past: history.past.slice(0, -1),
        future: [{ label: entry.label, project }, ...history.future].slice(0, HISTORY_LIMIT),
      },
      dirty: true,
    });
  },

  redo: () => {
    const { history, project } = get();
    if (!history.future.length) return;
    const [entry, ...rest] = history.future;
    set({
      project: entry.project,
      history: { past: [...history.past, { label: entry.label, project }].slice(-HISTORY_LIMIT), future: rest },
      dirty: true,
    });
  },

  replaceProject: (project, opts) => {
    set({
      project,
      directory: opts?.dir ?? get().directory,
      persisted: opts?.persisted ?? get().persisted,
      dirty: false,
      history: { past: [], future: [] },
      selectedBarId: project.bars[0]?.id ?? null,
      selectedEventIds: [],
      selectedLineId: project.lines[0]?.id ?? null,
      clipboard: [],
      snap: project.timeline.defaultSnap,
      positionSec: 0,
      playing: false,
    });
  },

  markSaved: () => set({ dirty: false, lastSavedAt: Date.now() }),

  setPage: (page) => set({ page }),
  setLyricsTab: (lyricsTab) => set({ lyricsTab }),
  setPlayerToolbarTab: (playerToolbarTab) => set({ playerToolbarTab }),
  /** 选中小节：不影响事件选中状态（两套状态独立） */
  selectBar: (selectedBarId) => set({ selectedBarId }),
  /**
   * 选中事件。additive = true 时切换该事件的选中状态（Ctrl+点击）。
   * 注意：选中事件**不会**改变选中的小节，反之亦然。
   */
  selectEvent: (id, additive) => {
    if (id === null) {
      set({ selectedEventIds: [] });
      return;
    }
    const cur = get().selectedEventIds;
    if (!additive) {
      set({ selectedEventIds: [id] });
      return;
    }
    set({ selectedEventIds: cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id] });
  },
  selectEvents: (ids) => set({ selectedEventIds: [...new Set(ids)] }),
  clearEventSelection: () => set({ selectedEventIds: [] }),
  selectLine: (selectedLineId) => set({ selectedLineId }),
  setSnap: (snap) => set({ snap }),

  /* ---------------- 剪贴板 ---------------- */

  copySelectedEvents: () => {
    const { project, selectedEventIds } = get();
    const picked: BeatEvent[] = [];
    for (const bar of project.bars) {
      for (const ev of bar.events) {
        if (selectedEventIds.includes(ev.id)) picked.push(deepClone(ev));
      }
    }
    if (!picked.length) return;
    set({ clipboard: picked });
    get().pushToast('info', `已复制 ${picked.length} 个事件`, '在小节内按 Ctrl+V 粘贴到该小节开头');
  },

  pasteEvents: (targetBarId) => {
    const { clipboard, project } = get();
    if (!clipboard.length) return;
    const barId = targetBarId ?? get().selectedBarId ?? project.bars[0]?.id ?? null;
    if (!barId) return;
    // 以剪贴板中最早的事件为基准，整体平移到目标小节
    const sorted = [...clipboard].sort((a, b) => a.beat - b.beat);
    const baseBeat = Math.floor(sorted[0].beat);
    const newIds: string[] = [];
    get().commit('粘贴事件', (d) => {
      const bar = d.bars.find((b) => b.id === barId);
      if (!bar) return;
      const barStart = (() => {
        let acc = 0;
        for (const b of d.bars) {
          if (b.id === barId) break;
          acc += b.beatCount;
        }
        return acc;
      })();
      for (const ev of sorted) {
        const offset = ev.beat - baseBeat;
        const beat = barStart + Math.min(offset, bar.beatCount - 1e-6);
        const id = uid('ev');
        newIds.push(id);
        bar.events.push({ ...deepClone(ev), id, beat });
      }
    });
    set({ selectedEventIds: newIds, selectedBarId: barId });
    get().pushToast('success', `已粘贴 ${newIds.length} 个事件`);
  },

  deleteSelectedEvents: () => {
    const ids = get().selectedEventIds;
    if (!ids.length) return;
    get().removeEvents(ids);
  },

  setPlaying: (playing) => set({ playing }),
  togglePlaying: () => set((s) => ({ playing: !s.playing })),
  setPositionSec: (positionSec) => set({ positionSec }),
  setPreviewFollow: (previewFollow) => set({ previewFollow }),

  pushToast: (kind, text, detail) => {
    const id = uid('toast');
    set((s) => ({ toasts: [...s.toasts, { id, kind, text, detail }].slice(-6) }));
    if (kind !== 'error') {
      setTimeout(() => get().dismissToast(id), kind === 'warn' ? 9000 : 4000);
    }
  },
  dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  setConflict: (conflict) => set({ conflict }),
  setProgress: (progress) => set({ progress }),

  /* ---------------- 小节 ---------------- */

  addBar: (atIndex) => {
    const newId = uid('bar');
    get().commit('新增小节', (d) => {
      const idx = atIndex ?? d.bars.length;
      // 新增小节使用「新增小节时每小节节拍数」；已有小节各自保存自己的拍数，不受影响
      d.bars.splice(idx, 0, {
        id: newId,
        beatCount: d.timeline.beatsPerNewBar,
        transform: { scaleX: 1, offsetX: 0 },
        events: [],
      });
    });
    set({ selectedBarId: newId });
  },

  removeBar: (barId) => {
    const idx = get().project.bars.findIndex((b) => b.id === barId);
    if (idx < 0) return;
    get().commit('删除小节', (d) => {
      d.bars.splice(idx, 1);
    });
    const next = get().project.bars[Math.min(idx, get().project.bars.length - 1)];
    // 小节被删掉后，它里面的事件选中状态也要清理
    const alive = new Set<string>();
    get().project.bars.forEach((b) => b.events.forEach((e) => alive.add(e.id)));
    set({
      selectedBarId: next?.id ?? null,
      selectedEventIds: get().selectedEventIds.filter((id) => alive.has(id)),
    });
  },

  moveBar: (from, delta) => {
    get().commit('移动小节', (d) => {
      const to = from + delta;
      if (from < 0 || to < 0 || to >= d.bars.length) return;
      const [bar] = d.bars.splice(from, 1);
      d.bars.splice(to, 0, bar);
    });
  },

  setBarBeatCount: (barId, count) => {
    get().commit('修改小节拍数', (d) => {
      const bar = d.bars.find((b) => b.id === barId);
      if (!bar) return;
      bar.beatCount = Math.max(1, Math.min(256, Math.round(count)));
      bar.transform.scaleX = Math.min(1, Math.max(0.05, bar.transform.scaleX));
      bar.transform.offsetX = Math.min(Math.max(0, bar.transform.offsetX), 1 - bar.transform.scaleX);
    });
  },

  setBarTransform: (barId, patch) => {
    get().commit('调整时间轴变换', (d) => {
      const bar = d.bars.find((b) => b.id === barId);
      if (!bar) return;
      if (patch.scaleX !== undefined) bar.transform.scaleX = Math.min(1, Math.max(0.05, patch.scaleX));
      const maxOffset = 1 - bar.transform.scaleX;
      if (patch.offsetX !== undefined) bar.transform.offsetX = Math.min(maxOffset, Math.max(0, patch.offsetX));
      bar.transform.offsetX = Math.min(bar.transform.offsetX, Math.max(0, 1 - bar.transform.scaleX));
    });
  },

  addEvent: (barId, type, beat) => {
    const id = uid('ev');
    // 吸附：snap > 0 用该分母；snap === 0 用 timeline.customSnap
    const state = get();
    const divisor = state.snap > 0 ? state.snap : state.project.timeline.customSnap;
    const snapped = divisor > 0 ? Math.round(beat * divisor) / divisor : beat;
    get().commit('插入事件', (d) => {
      const bar = d.bars.find((b) => b.id === barId);
      if (!bar) return;
      const ev = { id, type, beat: snapped, snap: state.snap, data: defaultEventData(type) } as BeatEvent;
      if (type === 'bpm') (ev.data as { bpm: number }).bpm = d.timeline.bpm;
      bar.events.push(ev);
    });
    // 只选中事件，不改变选中的小节
    set({ selectedEventIds: [id] });
    return id;
  },

  updateEvent: (barId, eventId, recipe) => {
    get().commit('修改事件', (d) => {
      const bar = d.bars.find((b) => b.id === barId);
      const ev = bar?.events.find((e) => e.id === eventId);
      if (ev) recipe(ev);
    });
  },

  removeEvent: (barId, eventId) => {
    get().removeEvents([eventId]);
    void barId;
  },

  removeEvents: (eventIds) => {
    if (!eventIds.length) return;
    const idSet = new Set(eventIds);
    get().commit(eventIds.length > 1 ? `删除 ${eventIds.length} 个事件` : '删除事件', (d) => {
      for (const bar of d.bars) {
        if (bar.events.some((e) => idSet.has(e.id))) {
          bar.events = bar.events.filter((e) => !idSet.has(e.id));
        }
      }
    });
    set({ selectedEventIds: get().selectedEventIds.filter((id) => !idSet.has(id)) });
  },

  moveEvent: (eventId, targetBarId, beat) => {
    get().commit('移动事件', (d) => {
      let found: { bar: Bar; ev: BeatEvent } | null = null;
      for (const bar of d.bars) {
        const ev = bar.events.find((e) => e.id === eventId);
        if (ev) {
          found = { bar, ev };
          break;
        }
      }
      const target = d.bars.find((b) => b.id === targetBarId);
      if (!found || !target) return;
      if (found.bar.id !== targetBarId) {
        found.bar.events = found.bar.events.filter((e) => e.id !== eventId);
        target.events.push(found.ev);
      }
      found.ev.beat = beat;
    });
  },

  /* ---------------- 逐行歌词 ---------------- */

  addLine: (afterLineId) => {
    const id = uid('line');
    get().commit('新增歌词块', (d) => {
      const line: LyricLine = { id, subLines: [{ id: uid('rl'), spans: [{ text: '' }] }] };
      const idx = afterLineId ? d.lines.findIndex((l) => l.id === afterLineId) : d.lines.length - 1;
      d.lines.splice(idx + 1, 0, line);
    });
    set({ selectedLineId: id });
    return id;
  },

  removeLine: (lineId) => {
    const idx = get().project.lines.findIndex((l) => l.id === lineId);
    if (idx < 0) return;
    get().commit('删除歌词块', (d) => {
      d.lines.splice(idx, 1);
    });
    const next = get().project.lines[Math.min(idx, get().project.lines.length - 1)];
    set({ selectedLineId: next?.id ?? null });
  },

  duplicateLine: (lineId) => {
    const id = uid('line');
    get().commit('复制歌词块', (d) => {
      const idx = d.lines.findIndex((l) => l.id === lineId);
      if (idx < 0) return;
      const copy = deepClone(d.lines[idx]);
      copy.id = id;
      copy.subLines.forEach((s: RichLine) => {
        s.id = uid('rl');
      });
      d.lines.splice(idx + 1, 0, copy);
    });
    set({ selectedLineId: id });
  },

  moveLine: (lineId, delta) => {
    get().commit('调整歌词顺序', (d) => {
      const from = d.lines.findIndex((l) => l.id === lineId);
      const to = from + delta;
      if (from < 0 || to < 0 || to >= d.lines.length) return;
      const [line] = d.lines.splice(from, 1);
      d.lines.splice(to, 0, line);
    });
  },

  /* ---------------- 播放设置 ---------------- */

  updatePlayback: (recipe) => {
    get().commit('修改播放设置', (d) => {
      recipe(d.playback);
    });
  },

  updateEffect: (id, recipe) => {
    get().commit('修改特效', (d) => {
      const fx = d.playback.effects.find((f) => f.id === id);
      if (fx) recipe(fx);
    });
  },

  addEffect: () => {
    const id = uid('fx');
    get().commit('新增特效', (d) => {
      d.playback.effects.push({
        id,
        type: 'beatPulse',
        enabled: true,
        trigger: 'beat',
        strength: 0.05,
        durationMs: 150,
        frequency: 2,
      });
    });
  },

  removeEffect: (id) => {
    get().commit('删除特效', (d) => {
      d.playback.effects = d.playback.effects.filter((f) => f.id !== id);
    });
  },
}));

/* ------------------------------------------------------------------ */
/* 派生数据                                                            */
/* ------------------------------------------------------------------ */

const timelineCache = new WeakMap<Project, Timeline>();

export function getTimeline(project: Project): Timeline {
  const hit = timelineCache.get(project);
  if (hit) return hit;
  const tl = buildTimeline(project);
  timelineCache.set(project, tl);
  return tl;
}

export function useTimeline(): Timeline {
  const project = useStore((s) => s.project);
  return getTimeline(project);
}

export function useSelectedBar(): { bar: Bar | null; span: BarSpan | null } {
  const project = useStore((s) => s.project);
  const barId = useStore((s) => s.selectedBarId);
  const tl = getTimeline(project);
  const span = tl.spans.find((s) => s.id === barId) ?? null;
  return { bar: span?.bar ?? null, span };
}

/** 强制行进事件的冲突集合（事件 id） */
export function computeForceConflicts(project: Project): Set<string> {
  const out = new Set<string>();
  buildTimeline(project).spans.forEach((span) => {
    findForceConflicts(span, span.bar.events).forEach((c) => {
      out.add(c.forceId);
      out.add(c.conflictId);
    });
  });
  return out;
}

export function useForceConflicts(): Set<string> {
  const project = useStore((s) => s.project);
  return computeForceConflicts(project);
}

/** 计算波形峰值并写入项目目录缓存 */
export async function cachePeaks(audioBuffer: AudioBuffer, bins = 4096): Promise<{ file: string; peaks: Float32Array }> {
  const peaks = computePeaks(audioBuffer, bins);
  const file = `cache/peaks-${audioBuffer.length}-${bins}.json`;
  const dir = useStore.getState().directory;
  const repo = makeRepository(dir);
  const existing = await repo.readDerived(file);
  if (!existing) await repo.writeDerived(file, encodePeaks(peaks));
  return { file, peaks };
}
