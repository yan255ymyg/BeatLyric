/**
 * 逐帧离线取帧器：导出时按「项目时间」取视频画面（不使用实时播放）
 *
 * 实现要点
 *  - 内部只用一个 `<video>` 元素（muted / playsInline / preload='auto' / crossOrigin='anonymous'）。
 *  - frameAt(t)：`videoTime = t + offsetMs/1000`（可循环 / 可裁剪），与当前时间差小于 1/fps 时直接复用当前帧，
 *    否则设置 currentTime 并 await `seeked`（带超时与 error 处理）。
 *  - 严格串行：所有 seek 进同一条内部 Promise 链，绝不会对同一个元素并发 seek。
 *  - 结果缓存最后一个 seek 位置，连续调用同一时间不会重复 seek。
 *  - prefetch(t) 是可选优化：把下一次要用的帧提前排进同一条链，减少串行等待。
 */

export interface VideoFrameProviderOptions {
  /** 超出视频长度后是否循环回开头（默认 false：钳制在最后一帧） */
  loop?: boolean;
  /** 视频相对音频的时间偏移（ms），与 VideoBackgroundConfig.offsetMs 同义 */
  offsetMs?: number;
  /** 期望帧率，用于计算「足够接近就复用当前帧」的容差。默认 60。 */
  fps?: number;
  /** 显式指定容差（秒）；指定时优先于 fps */
  toleranceSec?: number;
  /** 单次 seek 的超时（ms），默认 15000 */
  seekTimeoutMs?: number;
}

/** 停在 duration 上会导致浏览器 seek 到结尾黑屏，留一点余量 */
const END_EPSILON_SEC = 0.001;
const DEFAULT_FPS = 60;
const DEFAULT_SEEK_TIMEOUT_MS = 15000;

export class VideoFrameProvider {
  /** 供调用方直接 drawImage 的视频元素 */
  readonly element: HTMLVideoElement;

  private videoDuration = 0;
  private readonly loop: boolean;
  private readonly offsetSec: number;
  private readonly tolerance: number;
  private readonly seekTimeoutMs: number;

  /** 串行链：所有 seek 依次执行，避免并发 seek 同一个元素 */
  private chain: Promise<unknown> = Promise.resolve();
  /** 上一次成功 seek 到的目标时间（项目时间轴秒数） */
  private lastSeekTarget: number | null = null;
  /** 已经排进队列、等待执行的预取目标 */
  private pendingPrefetch: number | null = null;
  private disposed = false;

  private constructor(element: HTMLVideoElement, opts: VideoFrameProviderOptions) {
    this.element = element;
    this.loop = opts.loop === true;
    const offsetMs = Number.isFinite(opts.offsetMs) ? (opts.offsetMs as number) : 0;
    this.offsetSec = offsetMs / 1000;
    const fps = Number.isFinite(opts.fps) && (opts.fps as number) > 0 ? (opts.fps as number) : DEFAULT_FPS;
    this.tolerance =
      Number.isFinite(opts.toleranceSec) && (opts.toleranceSec as number) >= 0
        ? (opts.toleranceSec as number)
        : 1 / fps;
    this.seekTimeoutMs =
      Number.isFinite(opts.seekTimeoutMs) && (opts.seekTimeoutMs as number) > 0
        ? (opts.seekTimeoutMs as number)
        : DEFAULT_SEEK_TIMEOUT_MS;
  }

  /** 视频自身时长（秒）；未知（直播/元数据缺失）时为 0 */
  get duration(): number {
    return this.videoDuration;
  }

  static async create(url: string, opts: VideoFrameProviderOptions = {}): Promise<VideoFrameProvider> {
    const element = document.createElement('video');
    element.muted = true;
    element.defaultMuted = true;
    element.playsInline = true;
    element.preload = 'auto';
    element.crossOrigin = 'anonymous';
    element.setAttribute('playsinline', '');
    element.setAttribute('muted', '');

    const provider = new VideoFrameProvider(element, opts);
    await provider.load(url);
    return provider;
  }

  /** 取 t 秒（项目时间）处的帧，返回可直接 drawImage 的元素 */
  async frameAt(t: number): Promise<HTMLVideoElement> {
    if (this.disposed) throw new Error('视频取帧器已释放（dispose 之后不能再取帧）');
    const target = this.resolveVideoTime(t);

    // 命中缓存：同一帧（或容差内的相邻帧）直接复用，不重复 seek
    if (
      this.lastSeekTarget !== null &&
      Math.abs(target - this.lastSeekTarget) <= this.tolerance &&
      this.element.readyState >= 2
    ) {
      return this.element;
    }

    return this.enqueue(() => this.seekTo(target));
  }

  /** 尽量预取 t 附近；用于减少串行 seek 的等待（可选实现，失败不影响主流程） */
  prefetch(t: number): void {
    if (this.disposed) return;
    const target = this.resolveVideoTime(t);
    if (this.lastSeekTarget !== null && Math.abs(target - this.lastSeekTarget) <= this.tolerance) return;
    if (this.pendingPrefetch !== null && Math.abs(target - this.pendingPrefetch) <= this.tolerance) return;
    this.pendingPrefetch = target;
    void this.enqueue(() => this.seekTo(target)).catch(() => {
      // 预取失败无所谓，真正的 frameAt 会重新 seek 并抛错
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pendingPrefetch = null;
    const element = this.element;
    try {
      element.pause();
    } catch {
      // 忽略：某些状态下 pause 可能抛错
    }
    element.removeAttribute('src');
    try {
      element.load(); // 断开网络请求 / 释放解码器
    } catch {
      // 忽略
    }
  }

  /* ---------------------------------------------------------------- */
  /* 内部                                                              */
  /* ---------------------------------------------------------------- */

  /** 把项目时间映射为视频元素时间（含 offsetMs / loop / 边界钳制） */
  private resolveVideoTime(t: number): number {
    const raw = (Number.isFinite(t) ? t : 0) + this.offsetSec;
    if (this.videoDuration <= 0) return Math.max(0, raw);

    const max = Math.max(0, this.videoDuration - END_EPSILON_SEC);
    if (this.loop) {
      const wrapped = raw % this.videoDuration;
      const positive = wrapped < 0 ? wrapped + this.videoDuration : wrapped;
      return Math.min(positive, max);
    }
    return Math.min(Math.max(raw, 0), max);
  }

  /** 串行执行：把任务接到链尾，前一个任务失败也不会中断后续任务 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task);
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private clearPendingPrefetch(target: number): void {
    if (this.pendingPrefetch !== null && Math.abs(this.pendingPrefetch - target) <= this.tolerance) {
      this.pendingPrefetch = null;
    }
  }

  private seekTo(target: number): Promise<HTMLVideoElement> {
    const element = this.element;
    if (this.disposed) {
      return Promise.reject(new Error('视频取帧器已释放（dispose 之后不能再取帧）'));
    }

    // 已经在目标帧上：直接返回（同时规避「把 currentTime 设为相同值可能不触发 seeked」的坑）
    if (element.readyState >= 2 && Math.abs(element.currentTime - target) <= this.tolerance) {
      this.lastSeekTarget = target;
      this.clearPendingPrefetch(target);
      return Promise.resolve(element);
    }

    if (element.readyState === 0) {
      return Promise.reject(new Error('视频尚未加载完成，无法取帧'));
    }

    return new Promise<HTMLVideoElement>((resolve, reject) => {
      let settled = false;

      function cleanup(): void {
        element.removeEventListener('seeked', onSeeked);
        element.removeEventListener('loadeddata', onLoadedData);
        element.removeEventListener('error', onError);
        clearTimeout(timer);
      }

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) {
          reject(error);
          return;
        }
        provider.lastSeekTarget = target;
        provider.clearPendingPrefetch(target);
        resolve(element);
      }

      function onSeeked(): void {
        // seeked 之后 readyState 通常已 >= 2；否则再等一次 loadeddata
        if (element.readyState >= 2) finish();
        else element.addEventListener('loadeddata', onLoadedData, { once: true });
      }

      function onLoadedData(): void {
        if (element.readyState >= 2) finish();
      }

      function onError(): void {
        const mediaError = element.error;
        const detail = mediaError ? `（code=${mediaError.code}${mediaError.message ? `, ${mediaError.message}` : ''}）` : '';
        finish(new Error(`视频取帧失败${detail}`));
      }

      const provider = this;
      const timer = setTimeout(() => {
        finish(new Error(`视频取帧超时（目标 ${target.toFixed(3)}s，超过 ${provider.seekTimeoutMs}ms）`));
      }, this.seekTimeoutMs);

      element.addEventListener('seeked', onSeeked);
      element.addEventListener('loadeddata', onLoadedData, { once: true });
      element.addEventListener('error', onError, { once: true });

      try {
        element.currentTime = target;
      } catch (error) {
        finish(new Error(`无法设置视频时间点 ${target.toFixed(3)}s：${String(error)}`));
      }
    });
  }

  private load(url: string): Promise<void> {
    const element = this.element;
    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timeoutMs = Math.max(this.seekTimeoutMs, 30000);

      function cleanup(): void {
        element.removeEventListener('loadedmetadata', onLoadedMetadata);
        element.removeEventListener('error', onError);
        clearTimeout(timer);
      }

      function finish(error?: Error): void {
        if (settled) return;
        settled = true;
        cleanup();
        if (error) reject(error);
        else resolve();
      }

      function onLoadedMetadata(): void {
        const duration = element.duration;
        provider.videoDuration = Number.isFinite(duration) && duration > 0 ? duration : 0;
        provider.lastSeekTarget = null;
        finish();
      }

      function onError(): void {
        const mediaError = element.error;
        const detail = mediaError ? `（code=${mediaError.code}${mediaError.message ? `, ${mediaError.message}` : ''}）` : '';
        finish(new Error(`无法加载视频资源${detail}：${url}`));
      }

      const provider = this;
      const timer = setTimeout(() => {
        finish(new Error(`加载视频元数据超时（超过 ${timeoutMs}ms）：${url}`));
      }, timeoutMs);

      if (element.readyState >= 1 && Number.isFinite(element.duration)) {
        onLoadedMetadata();
        return;
      }

      element.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
      element.addEventListener('error', onError, { once: true });

      element.src = url;
      try {
        element.load();
      } catch (error) {
        finish(new Error(`无法加载视频资源：${url}（${String(error)}）`));
      }
    });
  }
}
