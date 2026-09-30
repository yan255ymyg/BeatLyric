/**
 * 播放控制器（单例）
 *
 * - 统一持有 AudioEngine、LrcCursor 与 requestAnimationFrame 时钟。
 * - 播放/暂停/拖动进度都由这里统筹，UI 只读取 store 里的 `positionSec`。
 * - 播放循环把「播放头时间」换算成「拍」，再推进逐行歌词状态机（LrcCursor），
 *   结果缓存在内存里供渲染器同步读取（避免每帧都触发 React 重渲染）。
 */

import { AudioEngine } from './engine';
import { LrcCursor, type LrcState } from '../core/lrc';
import { getTimeline, useStore } from '../state/store';
import { timelineDurationSafe } from './duration';
import { fetchAudioForProject } from '../ui/audioBridge';

class PlaybackController {
  readonly engine: AudioEngine;
  private cursor: LrcCursor | null = null;
  private cursorProjectKey: unknown = null;
  /** 已装入引擎的音频资源 id，避免重复加载 */
  private loadedAudioKey: string | null = null;
  private raf = 0;
  private lrcState: LrcState = { mainLine: 0, tempLines: [], cursor: 0 };
  /** 每帧回调（渲染器用来重绘画布，不触发 React 渲染） */
  private frameListeners = new Set<(positionSec: number) => void>();

  constructor() {
    this.engine = new AudioEngine({
      onEnded: () => {
        useStore.getState().setPlaying(false);
      },
    });
  }

  get lrc(): LrcState {
    return this.lrcState;
  }

  get positionSec(): number {
    return useStore.getState().positionSec;
  }

  /** 注册每帧回调（用于 canvas 重绘） */
  onFrame(fn: (positionSec: number) => void): () => void {
    this.frameListeners.add(fn);
    return () => this.frameListeners.delete(fn);
  }

  /** 项目或时间轴变化时重建逐行歌词游标 */
  private syncCursor(): void {
    const project = useStore.getState().project;
    if (this.cursorProjectKey !== project) {
      const tl = getTimeline(project);
      if (!this.cursor) this.cursor = new LrcCursor(project, tl);
      else this.cursor.setProject(project, tl);
      this.cursorProjectKey = project;
      this.lrcState = this.cursor.seek(this.positionSec);
      // 音频资源变化时同步给引擎（解码结果由 audioBridge 缓存）
      void this.syncAudio(project);
    }
  }

  /** 把项目当前的音频装进引擎（异步，失败时提示但不阻塞编辑） */
  async syncAudio(project = useStore.getState().project): Promise<void> {
    const url = project.audioAssetId;
    if (this.loadedAudioKey === url) return;
    this.loadedAudioKey = url;
    this.engine.setOffsetMs(project.timeline.audioOffsetMs);
    if (!url) {
      this.engine.clear();
      return;
    }
    const buf = await fetchAudioForProject(project);
    if (buf) await this.engine.load(buf);
  }

  /** 拖动进度条 / 外部跳转 */
  seek(sec: number): void {
    const { setPositionSec } = useStore.getState();
    const total = timelineDurationSafe(useStore.getState().project);
    const target = Math.max(0, Math.min(sec, Math.max(total, this.engine.durationSec)));
    setPositionSec(target);
    this.engine.seek(target);
    this.syncCursor();
    this.lrcState = this.cursor ? this.cursor.seek(target) : this.lrcState;
    this.emit();
  }

  async play(): Promise<void> {
    const store = useStore.getState();
    const total = Math.max(timelineDurationSafe(store.project), this.engine.durationSec);
    if (store.positionSec >= total - 1e-3) this.seek(0);
    await this.engine.resumeContext();
    await this.engine.play();
    store.setPlaying(true);
    this.startLoop();
  }

  pause(): void {
    this.engine.pause();
    useStore.getState().setPlaying(false);
    this.stopLoop();
  }

  toggle(): void {
    if (this.engine.isPlaying) this.pause();
    else void this.play();
  }

  /** 由 store 的 playing 状态驱动（UI 只改 store） */
  syncPlaybackState(): void {
    const want = useStore.getState().playing;
    if (want && !this.engine.isPlaying) {
      void this.engine.resumeContext().then(() => this.engine.play()).then(() => this.startLoop());
    } else if (!want && this.engine.isPlaying) {
      this.engine.pause();
      this.stopLoop();
    }
  }

  private startLoop(): void {
    if (this.raf) return;
    let lastStorePush = 0;
    const tick = (now: number) => {
      this.raf = requestAnimationFrame(tick);
      // 让引擎处理「播放头追上音频起点后开始出声」这类时序
      this.engine.tick();
      const playing = this.engine.isPlaying;
      const pos = this.engine.currentTime();
      const store = useStore.getState();
      /**
       * 注意：播放中**不要**每帧都写 store。
       * 每帧写会让所有订阅 positionSec 的组件以 60fps 重渲染，
       * 在低配机器上表现为画面卡顿、播放「乱动」。
       * 需要逐帧平滑的地方（进度条、画布、时间码）走 onFrame 回调，
       * store 只以约 15Hz 的频率同步，供需要粗粒度位置的组件使用。
       */
      if (now - lastStorePush > 66 || !playing) {
        lastStorePush = now;
        if (playing || Math.abs(pos - store.positionSec) > 0.0005) store.setPositionSec(pos);
      }
      this.syncCursor();
      if (this.cursor) this.lrcState = this.cursor.advance(pos);
      this.emit(pos);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.emit(useStore.getState().positionSec);
  }

  /** 即使暂停也要让渲染器重绘一次（编辑时需要看到最新状态） */
  redraw(): void {
    this.syncCursor();
    if (this.cursor) this.lrcState = this.cursor.seek(useStore.getState().positionSec);
    this.emit(useStore.getState().positionSec);
  }

  private emit(pos = useStore.getState().positionSec): void {
    this.frameListeners.forEach((fn) => fn(pos));
  }
}

let controller: PlaybackController | null = null;

export function getPlayback(): PlaybackController {
  if (!controller) controller = new PlaybackController();
  return controller;
}

export { PlaybackController };

/** 播放头时间（秒）-> 拍 */
export function positionToBeat(positionSec: number): number {
  const project = useStore.getState().project;
  const tl = getTimeline(project);
  const segs = tl.segs;
  if (!segs.length) return 0;
  let found = 0;
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].sec <= positionSec + 1e-9) found = i;
    else break;
  }
  const s = segs[found];
  const next = segs[found + 1];
  if (next && next.endSec > next.sec + 1e-12 && Math.abs(next.beat - s.endBeat) < 1e-9) {
    if (positionSec <= next.endSec + 1e-9) return s.endBeat;
  }
  return Math.max(0, s.beat + (positionSec - s.sec) / s.spb);
}
