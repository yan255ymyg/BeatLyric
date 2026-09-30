/**
 * 播放引擎
 *
 * 时间模型
 * ────────
 *  音频时间 = 播放头时间 + audioOffsetMs / 1000
 *
 * 也就是说偏移为正时音频整体延后（前面留白），为负时音频整体提前（跳过开头）。
 *
 * 两种起始情形都必须能正确播放（这是早期版本的缺陷）：
 *  - **播放头等音乐**：偏移为正 → 开头有一段只有时间轴、没有声音的空档。
 *    这段时间播放头必须照常前进（否则永远等不到音乐）。
 *  - **音乐等播放头**：偏移为负（或从中间开始播放）→ 音频的起始点已经在音频内部，
 *    直接 `start(when, audioTime)` 即可。
 *
 * 因此这里不使用 AudioBufferSourceNode 的原生延迟启动，而是**始终立即启动**，
 * 由自己用 `offset` 参数决定从音频的哪一位置开始；当 audioTime 为负时，
 * 先进入「无声等待」状态，等播放头追上音频起点再启动音源。
 * 位置推进统一用 `AudioContext.currentTime`（采样级稳定），
 * 并在音源真正启动的那一刻做一次时间轴重锚，避免累积误差。
 */

import { clamp } from '../core/util';

export interface AudioEngineEvents {
  onEnded?: () => void;
  onLoaded?: (duration: number) => void;
  /** 音源实际开始出声 / 停止出声（用于 UI 提示「等待音乐」） */
  onAudioActiveChange?: (active: boolean) => void;
}

export class AudioEngine {
  readonly ctx: AudioContext;
  private buffer: AudioBuffer | null = null;
  private source: AudioBufferSourceNode | null = null;
  private gain: GainNode;
  private analyserTap: AudioNode | null = null;

  /** 播放头位置（秒，项目时间轴坐标） */
  private positionSec = 0;
  private playing = false;

  /**
   * 播放中的时间锚点：
   *   播放头(now) = anchorPos + (ctx.currentTime - anchorCtxTime - silentElapsed?) * rate
   * 这里不引入额外的静默补偿 —— 静默本身就是「播放头在走、音频还没开始」，
   * 两者用同一条时间线，因此只需一个锚点。
   */
  private anchorCtxTime = 0;
  private anchorPos = 0;

  private offsetMs = 0;
  private rate = 1;
  private sourceActive = false;
  /** 需要等待播放头追上音频起点时，记录该起点对应的播放头时刻 */
  private pendingStartAt: number | null = null;

  constructor(private events: AudioEngineEvents = {}) {
    const Ctor =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    this.gain = this.ctx.createGain();
    this.gain.connect(this.ctx.destination);
  }

  get audioBuffer(): AudioBuffer | null {
    return this.buffer;
  }

  get durationSec(): number {
    return this.buffer ? this.buffer.duration : 0;
  }

  get sampleRate(): number {
    return this.ctx.sampleRate;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** 音源是否正在出声（偏移为正的前奏期间为 false） */
  get isAudioActive(): boolean {
    return this.sourceActive;
  }

  /** 音频在时间轴上的起点（秒）：播放头到达这里时开始出声 */
  get audioStartSec(): number {
    return -this.offsetMs / 1000;
  }

  /** 音频在时间轴上的终点（秒） */
  get audioEndSec(): number {
    return this.buffer ? this.buffer.duration - this.offsetMs / 1000 : 0;
  }

  get outputNode(): AudioNode {
    return this.gain;
  }

  setOffsetMs(ms: number): void {
    const wasPlaying = this.playing;
    const pos = this.currentTime();
    this.offsetMs = ms;
    if (wasPlaying) {
      this.playing = false;
      this.stopSource();
      this.positionSec = pos;
      this.playing = true;
      this.anchorCtxTime = this.ctx.currentTime;
      this.anchorPos = pos;
      this.maybeStartSource();
    }
  }

  setVolume(v: number): void {
    this.gain.gain.value = clamp(v, 0, 2);
  }

  insertNode(node: AudioNode): void {
    this.gain.disconnect();
    this.gain.connect(node);
    node.connect(this.ctx.destination);
    this.analyserTap = node;
  }

  clearInsertedNode(): void {
    if (!this.analyserTap) return;
    try {
      this.gain.disconnect();
      this.analyserTap.disconnect();
    } catch {
      /* 忽略 */
    }
    this.gain.connect(this.ctx.destination);
    this.analyserTap = null;
  }

  async load(buffer: AudioBuffer): Promise<void> {
    this.pause();
    this.buffer = buffer;
    this.positionSec = 0;
    this.events.onLoaded?.(buffer.duration);
  }

  clear(): void {
    this.pause();
    this.buffer = null;
    this.positionSec = 0;
  }

  async resumeContext(): Promise<void> {
    if (this.ctx.state === 'suspended') await this.ctx.resume();
  }

  /** 当前播放头位置（秒） */
  currentTime(): number {
    if (!this.playing) return this.positionSec;
    const elapsed = (this.ctx.currentTime - this.anchorCtxTime) * this.rate;
    return Math.max(0, this.anchorPos + elapsed);
  }

  async play(): Promise<void> {
    if (this.playing) return;
    await this.resumeContext();
    this.playing = true;
    this.anchorCtxTime = this.ctx.currentTime;
    this.anchorPos = this.positionSec;
    this.maybeStartSource();
  }

  pause(): void {
    if (!this.playing) return;
    this.positionSec = this.currentTime();
    this.playing = false;
    this.stopSource();
  }

  seek(sec: number): void {
    const target = Math.max(0, sec);
    if (this.playing) {
      this.anchorPos = target;
      this.anchorCtxTime = this.ctx.currentTime;
      this.positionSec = target;
      this.stopSource();
      this.maybeStartSource();
    } else {
      this.positionSec = target;
    }
  }

  setRate(rate: number): void {
    const next = clamp(rate, 0.25, 4);
    if (next === this.rate) return;
    const pos = this.currentTime();
    this.rate = next;
    if (this.playing) {
      this.anchorPos = pos;
      this.anchorCtxTime = this.ctx.currentTime;
      this.stopSource();
      this.maybeStartSource();
    }
  }

  /**
   * 每帧调用：负责「播放头追上音频起点后启动音源」。
   * 播放循环已经每帧驱动，因此这里不需要额外定时器。
   */
  tick(): void {
    if (!this.playing) return;
    if (this.pendingStartAt !== null && this.currentTime() >= this.pendingStartAt - 1e-6) {
      this.pendingStartAt = null;
      this.startSource(this.currentTime());
    }
  }

  dispose(): void {
    this.pause();
    void this.ctx.close();
  }

  /* ---------------- 内部 ---------------- */

  private maybeStartSource(): void {
    if (!this.buffer) {
      this.sourceActive = false;
      this.events.onAudioActiveChange?.(false);
      return;
    }
    const pos = this.currentTime();
    const audioTime = pos + this.offsetMs / 1000;
    if (audioTime < 0) {
      // 播放头还没追上音频起点：记录需要等待到的播放头时刻
      this.pendingStartAt = -this.offsetMs / 1000;
      this.setActive(false);
      return;
    }
    if (audioTime >= this.buffer.duration) {
      // 已经越过音频末尾：不再启动，靠时间轴继续走
      this.pendingStartAt = null;
      this.setActive(false);
      return;
    }
    this.pendingStartAt = null;
    this.startSource(pos);
  }

  private startSource(pos: number): void {
    if (!this.buffer) return;
    this.stopSource();
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.gain);
    const audioTime = clamp(pos + this.offsetMs / 1000, 0, Math.max(0, this.buffer.duration - 1e-4));
    src.start(this.ctx.currentTime, audioTime);
    src.onended = () => {
      if (this.source === src && this.playing) {
        this.setActive(false);
        this.source = null;
        this.events.onEnded?.();
      }
    };
    this.source = src;
    // 重锚：把启动瞬间作为新的时间原点，消除调度延迟带来的偏差
    this.anchorPos = pos;
    this.anchorCtxTime = this.ctx.currentTime;
    this.setActive(true);
  }

  private stopSource(): void {
    this.pendingStartAt = null;
    if (!this.source) {
      this.setActive(false);
      return;
    }
    try {
      this.source.onended = null;
      this.source.stop();
      this.source.disconnect();
    } catch {
      /* 已经停止 */
    }
    this.source = null;
    this.setActive(false);
  }

  private setActive(active: boolean): void {
    if (this.sourceActive === active) return;
    this.sourceActive = active;
    this.events.onAudioActiveChange?.(active);
  }
}
