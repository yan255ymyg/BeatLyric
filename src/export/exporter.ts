/**
 * 离线逐帧导出主流程（剪辑软件式渲染 + 硬件编码）
 *
 * 关键设计
 *  - 完全离线渲染：按 `i / fps` 逐帧调用调用方的 renderFrame()，再 `await CanvasSource.add(t, 1/fps)`。
 *    绝不使用 MediaRecorder（按墙钟时间录制，受设备性能限制、画质不可控）。
 *  - 背压：每帧 await `CanvasSource.add()`，编码器/写入器满时自动阻塞，不会无限制堆积内存。
 *  - 帧回调可以是异步的：`renderFrame(time)` 允许返回 Promise，
 *    这样调用方可以在里面 await 视频 seek（见 src/media/videoFrame.ts）而不会破坏逐帧顺序。
 *  - 关键帧：每 2 秒强制一个关键帧，便于播放器 seek。
 *  - 编码回退由 src/export/capabilities.ts 决定：视频按容器回退链回退，
 *    AAC 不可用时整体回退到 WebM + Opus，实在没有任何编码器时抛中文错误。
 */
import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
} from 'mediabunny';
import {
  resolveCodecs,
  toMediabunnyAudioCodec,
  toMediabunnyVideoCodec,
  hasWebCodecsVideoEncoder,
  WEBCODECS_UNSUPPORTED_MESSAGE,
} from './capabilities';

/* ------------------------------------------------------------------ */
/* 类型                                                                 */
/* ------------------------------------------------------------------ */

export interface ExportFrameRequest {
  /** 帧时间（秒，项目时间轴） */
  time: number;
  /** 帧序号 */
  index: number;
  /** 总帧数 */
  total: number;
}

/** 每帧渲染回调；返回值可以是 Promise，导出循环会 await 它（用于视频 seek 等异步取帧） */
export type RenderFrameFn = (time: number, frame: ExportFrameRequest) => void | Promise<void>;

export interface ExportOptions {
  canvas: HTMLCanvasElement;
  /** 每帧的渲染回调：必须把该时刻的画面同步画到 canvas 上（或返回 Promise 完成异步取帧后再画） */
  renderFrame: RenderFrameFn;
  /** 项目时间轴总时长（秒） */
  durationSec: number;
  fps: number;
  width: number;
  height: number;
  format: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  /**
   * 已按时间轴对齐好的音频（可选）。请用 src/media/audio.ts 的 sliceAudioBuffer() 生成，
   * 使它的长度与 durationSec 一致、且在 audioOffsetMs 处对齐；本函数不会再次裁切。
   */
  audio?: AudioBuffer | null;
  /** 进度回调 */
  onProgress?: (p: { phase: 'video' | 'audio' | 'finalize'; done: number; total: number }) => void;
  /** 取消信号 */
  signal?: AbortSignal;
}

export interface ExportResult {
  blob: Blob;
  bytes: number;
  durationSec: number;
  frames: number;
  mimeType: string;
  /** 编码回退说明（中文），例如「音频编码回退：AAC 不可用，已改用 Opus」 */
  fallbackNote?: string;
}

/* ------------------------------------------------------------------ */
/* 常量                                                                 */
/* ------------------------------------------------------------------ */

/** 强制关键帧间隔（秒） */
const KEYFRAME_INTERVAL_SEC = 2;
/** 每隔多少毫秒让出一次事件循环，避免导出时界面完全卡死 */
const YIELD_INTERVAL_MS = 8;
/** 进度回调最小间隔（ms）；首帧与末帧一定回调 */
const PROGRESS_INTERVAL_MS = 50;

/* ------------------------------------------------------------------ */
/* 工具                                                                 */
/* ------------------------------------------------------------------ */

function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}

/** 让出事件循环：优先用 scheduler.yield（Chromium 115+），否则用 setTimeout(0) */
async function yieldToEventLoop(): Promise<void> {
  const scheduler = (globalThis as unknown as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (scheduler && typeof scheduler.yield === 'function') {
    await scheduler.yield();
    return;
  }
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createAbortError(): Error {
  if (typeof DOMException === 'function') {
    return new DOMException('导出已取消', 'AbortError');
  }
  const error = new Error('导出已取消');
  error.name = 'AbortError';
  return error;
}

async function cancelQuietly(output: Output): Promise<void> {
  try {
    if (output.state !== 'finalized' && output.state !== 'canceled') {
      await output.cancel();
    }
  } catch {
    // 取消阶段的错误无需上报（原始错误更重要）
  }
}

function assertPositive(value: number, message: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(message);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

export async function exportVideo(opts: ExportOptions): Promise<ExportResult> {
  if (!hasWebCodecsVideoEncoder()) throw new Error(WEBCODECS_UNSUPPORTED_MESSAGE);

  const { canvas, fps, width, height } = opts;
  assertPositive(opts.durationSec, '导出时长必须大于 0 秒');
  assertPositive(fps, '导出帧率必须大于 0');
  assertPositive(width, '导出宽度必须大于 0');
  assertPositive(height, '导出高度必须大于 0');
  assertPositive(opts.videoBitrateMbps, '视频码率必须大于 0');

  const totalFrames = Math.max(1, Math.round(opts.durationSec * fps));
  const frameDuration = 1 / fps;
  const keyFrameIntervalFrames = Math.max(1, Math.round(KEYFRAME_INTERVAL_SEC * fps));
  const notes: string[] = [];

  // 1) 决定实际可用的编码组合（自动回退）
  const resolved = await resolveCodecs({
    format: opts.format,
    videoCodec: opts.videoCodec,
    audioCodec: opts.audioCodec,
    width,
    height,
    fps,
    videoBitrateMbps: opts.videoBitrateMbps,
    audioBitrateKbps: opts.audioBitrateKbps,
    needAudio: !!opts.audio,
  });
  if (opts.signal?.aborted) throw createAbortError();
  if (resolved.fallbackNote) notes.push(resolved.fallbackNote);

  const mediabunnyVideoCodec = toMediabunnyVideoCodec(resolved.videoCodec);
  if (!mediabunnyVideoCodec) throw new Error(`未知的视频编码：${resolved.videoCodec}`);

  // 音频编码器整体不可用时 resolveCodecs 会返回 audioCodec: null，并把原因写进 fallbackNote；
  // 这里选择「保留画面、放弃音轨」而不是整段导出失败。
  const mediabunnyAudioCodec = resolved.audioCodec ? toMediabunnyAudioCodec(resolved.audioCodec) : null;
  if (resolved.audioCodec && !mediabunnyAudioCodec) {
    throw new Error(`未知的音频编码：${resolved.audioCodec}`);
  }

  // 2) 画布尺寸必须与导出参数一致（CanvasSource 默认拒绝尺寸变化的帧）
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  // 3) 构建输出
  const target = new BufferTarget();
  const output = new Output({
    format:
      resolved.format === 'webm' ? new WebMOutputFormat() : new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target,
  });

  const videoSource = new CanvasSource(canvas, {
    codec: mediabunnyVideoCodec,
    quality: new Quality({ bitrate: Math.round(opts.videoBitrateMbps * 1e6) }),
    keyFrameInterval: KEYFRAME_INTERVAL_SEC,
    ...(resolved.videoHardwareAcceleration
      ? { hardwareAcceleration: resolved.videoHardwareAcceleration }
      : {}),
  });
  output.addVideoTrack(videoSource, { frameRate: fps });

  let audioSource: AudioBufferSource | null = null;
  if (opts.audio && mediabunnyAudioCodec) {
    audioSource = new AudioBufferSource({
      codec: mediabunnyAudioCodec,
      quality: new Quality({ bitrate: Math.round(opts.audioBitrateKbps * 1e3) }),
    });
    output.addAudioTrack(audioSource, {});
  }

  let lastProgressAt = 0;
  let lastYieldAt = nowMs();
  try {
    await output.start();

    // 4) 音频：整段一次性编码（调用方已用 sliceAudioBuffer 对齐长度）
    if (audioSource && opts.audio) {
      lastProgressAt = nowMs();
      opts.onProgress?.({ phase: 'audio', done: 0, total: 1 });
      await audioSource.add(opts.audio);
      audioSource.close();
      opts.onProgress?.({ phase: 'audio', done: 1, total: 1 });
    }

    // 5) 逐帧离线渲染 + 编码
    for (let index = 0; index < totalFrames; index++) {
      if (opts.signal?.aborted) throw createAbortError();

      const time = index * frameDuration;
      await opts.renderFrame(time, { time, index, total: totalFrames });

      if (opts.signal?.aborted) throw createAbortError();

      const isKeyFrame = index % keyFrameIntervalFrames === 0;
      await videoSource.add(time, frameDuration, isKeyFrame ? { keyFrame: true } : undefined);

      const now = nowMs();
      if (index === 0 || index === totalFrames - 1 || now - lastProgressAt >= PROGRESS_INTERVAL_MS) {
        lastProgressAt = now;
        opts.onProgress?.({ phase: 'video', done: index + 1, total: totalFrames });
      }

      if (now - lastYieldAt >= YIELD_INTERVAL_MS) {
        await yieldToEventLoop();
        lastYieldAt = nowMs();
      }
    }

    // 6) 收尾
    videoSource.close();
    audioSource?.close();
    opts.onProgress?.({ phase: 'finalize', done: 0, total: 1 });
    await output.finalize();
    opts.onProgress?.({ phase: 'finalize', done: 1, total: 1 });
  } catch (error) {
    await cancelQuietly(output);
    throw error;
  }

  const buffer = target.buffer;
  if (!buffer) throw new Error('导出失败：编码器没有产出任何数据');

  const mimeType = resolved.format === 'webm' ? 'video/webm' : 'video/mp4';
  const result: ExportResult = {
    blob: new Blob([buffer], { type: mimeType }),
    bytes: buffer.byteLength,
    durationSec: totalFrames / fps,
    frames: totalFrames,
    mimeType,
  };
  if (notes.length > 0) result.fallbackNote = notes.join('；');
  return result;
}
