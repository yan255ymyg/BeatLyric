/**
 * 导出编排
 *
 * 把「逐帧渲染」与「编码封装」接起来。关键点：
 *  - 用一块**独立的离屏画布**，尺寸严格等于导出尺寸（CanvasSource 不允许帧尺寸变化）。
 *  - 逐帧循环里按时间 t 重建全部状态：逐行歌词游标重放、离线频谱取值、视频背景 seek 取帧。
 *    因此导出结果与实时预览一致，且速度只受渲染与编码吞吐限制，不受实时播放限制。
 *  - 音频用 sliceAudioBuffer 按项目时间轴对齐（与播放引擎同一套偏移约定）。
 */

import type { Project } from '../model/model';
import { getTimeline } from '../state/store';
import { prepareCanvas } from '../render/canvasKit';
import { makeEffectsPlan, renderFrame, type RenderResources } from '../render/frameRenderer';
import { OfflineSpectrum } from '../media/spectrum';
import { sliceAudioBuffer } from '../media/audio';
import { VideoFrameProvider } from '../media/videoFrame';
import { getDiscTexture, getCircleMask, loadImage } from '../media/albumArt';
import { LrcCursor } from '../core/lrc';
import { exportVideo } from './exporter';
import { resolveCodecs } from './capabilities';
import { getAssetUrl } from '../ui/assetUrls';
import { fetchAudioForProject } from '../ui/audioBridge';
import { useStore } from '../state/store';

export interface RunExportOptions {
  project: Project;
  fps: number;
  width: number;
  height: number;
  format: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  /** 时间轴起止（秒），默认 0 到时间轴末尾 */
  fromSec?: number;
  toSec?: number;
  onProgress?: (p: { phase: string; done: number; total: number }) => void;
  signal?: AbortSignal;
}

export interface RunExportResult {
  blob: Blob;
  bytes: number;
  frames: number;
  durationSec: number;
  mimeType: string;
  fallbackNote?: string;
}

export async function runExport(opts: RunExportOptions): Promise<RunExportResult> {
  const { project } = opts;
  const timeline = getTimeline(project);
  const from = Math.max(0, opts.fromSec ?? 0);
  const to = Math.max(from, opts.toSec ?? timeline.endSec);
  const durationSec = Math.max(1 / opts.fps, to - from);

  // 解析实际可用的编码组合
  const resolved = await resolveCodecs({
    format: opts.format,
    videoCodec: opts.videoCodec,
    audioCodec: opts.audioCodec,
    width: opts.width,
    height: opts.height,
    fps: opts.fps,
    videoBitrateMbps: opts.videoBitrateMbps,
    audioBitrateKbps: opts.audioBitrateKbps,
  });

  // 离屏画布
  const canvas = document.createElement('canvas');
  canvas.width = opts.width;
  canvas.height = opts.height;
  const ctx = prepareCanvas(canvas, opts.width, opts.height, 1);

  // 资源准备
  const resources: RenderResources = {
    video: null,
    album: null,
    discTexture: null,
    circleMask: null,
    spectrum: null,
    effects: makeEffectsPlan(project, timeline),
  };

  let videoProvider: VideoFrameProvider | null = null;
  const pb = project.playback;
  if (pb.video.enabled && pb.video.assetId) {
    const asset = project.assets[pb.video.assetId];
    const url = asset ? await getAssetUrl(asset) : null;
    if (url) {
      try {
        videoProvider = await VideoFrameProvider.create(url, { loop: true, offsetMs: pb.video.offsetMs, fps: opts.fps });
      } catch {
        videoProvider = null;
      }
    }
  }
  if (pb.album.enabled && pb.album.assetId) {
    const asset = project.assets[pb.album.assetId];
    const url = asset ? await getAssetUrl(asset) : null;
    if (url) {
      try {
        resources.album = await loadImage(url);
      } catch {
        resources.album = null;
      }
    }
    if (pb.album.discStyle) {
      resources.discTexture = getDiscTexture(512, pb.album.discColor);
      resources.circleMask = getCircleMask(512);
    }
  }

  const audioBuffer = await fetchAudioForProject(project);

  // 离线频谱：导出时不能用实时 AnalyserNode，必须能对任意时刻求值
  let offlineSpectrum: OfflineSpectrum | null = null;
  if (pb.spectrum.enabled && audioBuffer) {
    offlineSpectrum = new OfflineSpectrum(audioBuffer, {
      minFreq: pb.spectrum.minFreq,
      maxFreq: pb.spectrum.maxFreq,
      columns: pb.spectrum.columns,
      gain: pb.spectrum.gain,
    });
  }

  // 逐行歌词游标（导出时按时间重放，保证确定性）
  const cursor = new LrcCursor(project, timeline);

  // 音频：按时间轴对齐
  let exportAudio: AudioBuffer | null = null;
  if (audioBuffer) {
    try {
      const anyCtx = new OfflineAudioContext(2, Math.max(1, Math.ceil(durationSec * audioBuffer.sampleRate)), audioBuffer.sampleRate);
      exportAudio = sliceAudioBuffer(anyCtx, audioBuffer, {
        offsetMs: project.timeline.audioOffsetMs,
        durationSec,
      });
    } catch {
      // 极端情况下退化为直接使用原音频（可能与时轴不完全对齐）
      exportAudio = audioBuffer;
    }
  }

  const renderFrameFn = async (time: number) => {
    const t = time + from;
    if (offlineSpectrum) {
      const audioTime = t + project.timeline.audioOffsetMs / 1000;
      resources.spectrum = {
        columns: pb.spectrum.columns,
        sample: (out?: Float32Array) => offlineSpectrum!.timeAt(audioTime, out),
      };
    }
    if (videoProvider) {
      try {
        resources.video = await videoProvider.frameAt(t);
      } catch {
        resources.video = videoProvider.element;
      }
    }
    const lrcState = cursor.seek(t);
    renderFrame(
      ctx,
      project,
      timeline,
      t,
      resources,
      { width: opts.width, height: opts.height, layoutScale: 1, lrcState },
    );
  };

  try {
    const result = await exportVideo({
      canvas,
      renderFrame: renderFrameFn,
      durationSec,
      fps: opts.fps,
      width: opts.width,
      height: opts.height,
      format: resolved.format,
      videoCodec: resolved.videoCodec,
      audioCodec: resolved.audioCodec ?? 'aac',
      videoBitrateMbps: opts.videoBitrateMbps,
      audioBitrateKbps: opts.audioBitrateKbps,
      audio: resolved.audioCodec ? exportAudio : null,
      onProgress: opts.onProgress,
      signal: opts.signal,
    });
    return {
      blob: result.blob,
      bytes: result.bytes,
      frames: result.frames,
      durationSec: result.durationSec,
      mimeType: result.mimeType,
      fallbackNote: resolved.fallbackNote ?? result.fallbackNote,
    };
  } finally {
    videoProvider?.dispose();
  }
}

/** 默认导出范围：整个时间轴 */
export function defaultExportRange(project: Project): { fromSec: number; toSec: number } {
  const tl = getTimeline(project);
  return { fromSec: 0, toSec: Math.max(tl.endSec, 0.1) };
}

export function pushExportToast(kind: 'success' | 'error' | 'info' | 'warn', text: string, detail?: string): void {
  useStore.getState().pushToast(kind, text, detail);
}
