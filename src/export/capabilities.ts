/**
 * 导出能力探测与导出预设
 *
 * 设计要点
 *  - 能力判定一律走 WebCodecs 的 `VideoEncoder.isConfigSupported` / `AudioEncoder.isConfigSupported`，
 *    绝不用 `typeof VideoEncoder !== 'undefined'` 这种粗糙判断（那只能说明 API 存在，不能说明某个编码器可用）。
 *  - 本模块必须在 node（vitest，没有 DOM / 没有 WebCodecs）下也能安全导入并返回结果：
 *    所有 WebCodecs 访问都通过 globalThis 弱引用获取，缺少 API 时优雅降级为 supported: false。
 *  - 纯逻辑（listPresets / preferredOrder / 预设结构）与探测逻辑分离，便于单测。
 *  - 编码名约定：本模块对外统一使用项目侧命名 'h264' | 'hevc' | 'av1' | 'vp9' | 'aac' | 'opus'
 *    （与 src/model/model.ts 的 ExportConfig 注释一致），通过 toMediabunny*Codec() 映射到 mediabunny 的
 *    'avc' | 'hevc' | 'av1' | 'vp9' | 'aac' | 'opus'。
 */
import type { AudioCodec, VideoCodec } from 'mediabunny';

/* ------------------------------------------------------------------ */
/* 对外类型                                                             */
/* ------------------------------------------------------------------ */

export type CodecKind = 'video' | 'audio';

export interface CodecSupport {
  /** 形如 'h264' | 'hevc' | 'av1' | 'vp9' | 'aac' | 'opus' */
  codec: string;
  label: string;
  kind: CodecKind;
  supported: boolean;
  /** 不支持的硬件加速回退链，例如 prefer-software */
  notes?: string;
}

export interface ExportPreset {
  id: string;
  label: string;
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  /**
   * 当前环境下是否可用（由 listPresetsWithSupport() / annotatePresets() 填充）。
   * listPresets() 是纯同步函数，不探测，因此该字段为 undefined。
   */
  available?: boolean;
}

/** 硬件加速偏好，与 WebCodecs 的 VideoEncoderConfig.hardwareAcceleration 一致 */
export type HardwareAccelerationPreference = 'no-preference' | 'prefer-hardware' | 'prefer-software';

/** 编码解析结果：给 exporter 用的最终可用组合 */
export interface ResolvedExportCodecs {
  format: 'mp4' | 'webm';
  /** 实际使用的视频编码（项目侧命名） */
  videoCodec: string;
  /** 实际使用的音频编码；null 表示音轨不可用，只能导出无音轨视频 */
  audioCodec: string | null;
  /** 建议透传给 mediabunny CanvasSource 的 hardwareAcceleration */
  videoHardwareAcceleration?: HardwareAccelerationPreference;
  /** 中文回退说明；没有发生回退时为 undefined */
  fallbackNote?: string;
}

/** WebCodecs 完全缺失时的统一提示文案 */
export const WEBCODECS_UNSUPPORTED_MESSAGE =
  '当前浏览器不支持 WebCodecs 硬件编码导出，请使用 Chrome/Edge 114+';

/* ------------------------------------------------------------------ */
/* 编码器目录（纯数据，可测）                                            */
/* ------------------------------------------------------------------ */

interface CodecDefinition {
  /** 项目侧命名 */
  codec: string;
  label: string;
  kind: CodecKind;
  /** mediabunny 使用的编码名 */
  mbCodec: VideoCodec | AudioCodec;
  /** 交给 isConfigSupported 的 codec string 候选，从高规格到低规格（高 level 可覆盖低分辨率，避免 4K 误判） */
  codecStrings: string[];
}

const VIDEO_CODEC_DEFINITIONS: CodecDefinition[] = [
  {
    codec: 'h264',
    label: 'H.264 / AVC',
    kind: 'video',
    mbCodec: 'avc',
    // High 5.2 > High 5.1 > High 4.0 > Main 5.2 > Baseline 3.0
    codecStrings: ['avc1.640034', 'avc1.640033', 'avc1.640028', 'avc1.4D0034', 'avc1.42E01E'],
  },
  {
    codec: 'hevc',
    label: 'H.265 / HEVC',
    kind: 'video',
    mbCodec: 'hevc',
    codecStrings: [
      'hvc1.2.4.L153.B0',
      'hvc1.1.6.L150.B0',
      'hvc1.1.6.L123.B0',
      'hvc1.1.6.L120.90',
      'hvc1.1.6.L93.B0',
      'hev1.1.6.L93.B0',
    ],
  },
  {
    codec: 'av1',
    label: 'AV1',
    kind: 'video',
    mbCodec: 'av1',
    codecStrings: ['av01.0.12M.08', 'av01.0.09M.08', 'av01.0.08M.08', 'av01.0.04M.08'],
  },
  {
    codec: 'vp9',
    label: 'VP9',
    kind: 'video',
    mbCodec: 'vp9',
    codecStrings: ['vp09.00.51.08', 'vp09.00.50.08', 'vp09.00.41.08', 'vp09.00.10.08'],
  },
];

const AUDIO_CODEC_DEFINITIONS: CodecDefinition[] = [
  {
    codec: 'aac',
    label: 'AAC-LC',
    kind: 'audio',
    mbCodec: 'aac',
    codecStrings: ['mp4a.40.2'],
  },
  {
    codec: 'opus',
    label: 'Opus',
    kind: 'audio',
    mbCodec: 'opus',
    codecStrings: ['opus'],
  },
];

/** 每个容器下允许的视频编码回退链（按优先级）。WebM 不支持 H.264/H.265。 */
const VIDEO_CHAINS: Record<'mp4' | 'webm', string[]> = {
  mp4: ['h264', 'hevc', 'av1', 'vp9'],
  webm: ['vp9', 'av1'],
};

/** 每个容器下允许的音频编码回退链。MP4 只走 AAC；AAC 不可用时整体回退到 WebM + Opus。 */
const AUDIO_CHAINS: Record<'mp4' | 'webm', string[]> = {
  mp4: ['aac'],
  webm: ['opus'],
};

const ALL_DEFINITIONS: CodecDefinition[] = [...VIDEO_CODEC_DEFINITIONS, ...AUDIO_CODEC_DEFINITIONS];

/** 把项目侧编码名映射为 mediabunny 编码名 */
export function toMediabunnyVideoCodec(codec: string): VideoCodec | null {
  const def = VIDEO_CODEC_DEFINITIONS.find((d) => d.codec === codec);
  if (def) return def.mbCodec as VideoCodec;
  // 允许调用方直接传 mediabunny 的名字
  const direct = VIDEO_CODEC_DEFINITIONS.find((d) => d.mbCodec === codec);
  return direct ? (direct.mbCodec as VideoCodec) : null;
}

/** 把项目侧编码名映射为 mediabunny 编码名 */
export function toMediabunnyAudioCodec(codec: string): AudioCodec | null {
  const def = AUDIO_CODEC_DEFINITIONS.find((d) => d.codec === codec);
  if (def) return def.mbCodec as AudioCodec;
  const direct = AUDIO_CODEC_DEFINITIONS.find((d) => d.mbCodec === codec);
  return direct ? (direct.mbCodec as AudioCodec) : null;
}

export function codecLabel(codec: string): string {
  return ALL_DEFINITIONS.find((d) => d.codec === codec)?.label ?? codec;
}

/** 该编码是否属于该容器允许的集合 */
export function isCodecAllowedInFormat(kind: CodecKind, codec: string, format: 'mp4' | 'webm'): boolean {
  const chain = kind === 'video' ? VIDEO_CHAINS[format] : AUDIO_CHAINS[format];
  return chain.includes(codec);
}

/** 候选顺序：优先调用方请求的编码（若该容器允许），随后是容器的回退链 */
export function preferredOrder(requested: string, chain: string[]): string[] {
  if (!chain.includes(requested)) return [...chain];
  return [requested, ...chain.filter((c) => c !== requested)];
}

/* ------------------------------------------------------------------ */
/* WebCodecs 弱引用                                                     */
/* ------------------------------------------------------------------ */

interface ConfigSupportResult {
  supported?: boolean;
}

interface EncoderClass<C> {
  isConfigSupported(config: C): Promise<ConfigSupportResult>;
}

function getGlobal(name: string): unknown {
  return (globalThis as unknown as Record<string, unknown>)[name];
}

function asEncoderClass<C>(value: unknown): EncoderClass<C> | null {
  if (typeof value !== 'function') return null;
  const isConfigSupported = (value as { isConfigSupported?: unknown }).isConfigSupported;
  if (typeof isConfigSupported !== 'function') return null;
  return value as unknown as EncoderClass<C>;
}

function getVideoEncoderClass(): EncoderClass<VideoEncoderConfig> | null {
  return asEncoderClass<VideoEncoderConfig>(getGlobal('VideoEncoder'));
}

function getAudioEncoderClass(): EncoderClass<AudioEncoderConfig> | null {
  return asEncoderClass<AudioEncoderConfig>(getGlobal('AudioEncoder'));
}

/** 当前环境是否提供 WebCodecs 视频编码器（导出的硬性前提） */
export function hasWebCodecsVideoEncoder(): boolean {
  return getVideoEncoderClass() !== null;
}

/** 当前环境是否提供 WebCodecs 音频编码器（没有音频资源时不影响导出） */
export function hasWebCodecsAudioEncoder(): boolean {
  return getAudioEncoderClass() !== null;
}

/* ------------------------------------------------------------------ */
/* 探测                                                                 */
/* ------------------------------------------------------------------ */

export interface ProbeOptions {
  /** 视频探测分辨率，默认 1920x1080 */
  width?: number;
  height?: number;
  /** 视频探测帧率，默认 60 */
  fps?: number;
  /** 视频探测码率，默认 12 Mbps */
  videoBitrateMbps?: number;
  /** 音频探测声道数，默认 2 */
  audioChannels?: number;
  /** 音频探测采样率，默认 48000（Opus 只接受 48k 系采样率，mediabunny 会自动重采样） */
  audioSampleRate?: number;
  /** 音频探测码率，默认 192 kbps */
  audioBitrateKbps?: number;
  /** 绕过缓存强制重新探测 */
  refresh?: boolean;
}

interface ProbeParams {
  width: number;
  height: number;
  fps: number;
  videoBitrate: number;
  audioChannels: number;
  audioSampleRate: number;
  audioBitrate: number;
}

const DEFAULT_PROBE_PARAMS: ProbeParams = {
  width: 1920,
  height: 1080,
  fps: 60,
  videoBitrate: 12e6,
  audioChannels: 2,
  audioSampleRate: 48000,
  audioBitrate: 192e3,
};

const probeCache = new Map<string, Promise<CodecSupport[]>>();

function normalizeProbeParams(options?: ProbeOptions): ProbeParams {
  const positive = (value: number | undefined, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  return {
    width: positive(options?.width, DEFAULT_PROBE_PARAMS.width),
    height: positive(options?.height, DEFAULT_PROBE_PARAMS.height),
    fps: positive(options?.fps, DEFAULT_PROBE_PARAMS.fps),
    videoBitrate: positive(options?.videoBitrateMbps, DEFAULT_PROBE_PARAMS.videoBitrate / 1e6) * 1e6,
    audioChannels: positive(options?.audioChannels, DEFAULT_PROBE_PARAMS.audioChannels),
    audioSampleRate: positive(options?.audioSampleRate, DEFAULT_PROBE_PARAMS.audioSampleRate),
    audioBitrate: positive(options?.audioBitrateKbps, DEFAULT_PROBE_PARAMS.audioBitrate / 1e3) * 1e3,
  };
}

function probeCacheKey(params: ProbeParams): string {
  return [
    params.width,
    params.height,
    params.fps,
    params.videoBitrate,
    params.audioChannels,
    params.audioSampleRate,
    params.audioBitrate,
  ].join('x');
}

async function isVideoConfigSupported(
  cls: EncoderClass<VideoEncoderConfig>,
  codecString: string,
  params: ProbeParams,
  hardwareAcceleration?: HardwareAccelerationPreference,
): Promise<boolean> {
  const config: VideoEncoderConfig = {
    codec: codecString,
    width: Math.round(params.width),
    height: Math.round(params.height),
    bitrate: Math.round(params.videoBitrate),
    framerate: params.fps,
  };
  if (hardwareAcceleration) config.hardwareAcceleration = hardwareAcceleration;
  try {
    const result = await cls.isConfigSupported(config);
    return result?.supported === true;
  } catch {
    // 某些实现对无法识别的 codec string 会直接抛错，视为不支持
    return false;
  }
}

async function isAudioConfigSupported(
  cls: EncoderClass<AudioEncoderConfig>,
  codecString: string,
  params: ProbeParams,
): Promise<boolean> {
  const config: AudioEncoderConfig = {
    codec: codecString,
    numberOfChannels: Math.round(params.audioChannels),
    sampleRate: Math.round(params.audioSampleRate),
    bitrate: Math.round(params.audioBitrate),
  };
  try {
    const result = await cls.isConfigSupported(config);
    return result?.supported === true;
  } catch {
    return false;
  }
}

async function probeVideoCandidate(
  cls: EncoderClass<VideoEncoderConfig>,
  codecStrings: string[],
  params: ProbeParams,
  hardwareAcceleration: HardwareAccelerationPreference,
): Promise<boolean> {
  for (const codecString of codecStrings) {
    if (await isVideoConfigSupported(cls, codecString, params, hardwareAcceleration)) return true;
  }
  return false;
}

async function probeVideoCodec(def: CodecDefinition, params: ProbeParams): Promise<CodecSupport> {
  const base = { codec: def.codec, label: def.label, kind: 'video' as const };
  const cls = getVideoEncoderClass();
  if (!cls) {
    return { ...base, supported: false, notes: '当前环境没有 WebCodecs（VideoEncoder 不存在）' };
  }
  if (await probeVideoCandidate(cls, def.codecStrings, params, 'prefer-hardware')) {
    return { ...base, supported: true, notes: '硬件加速可用（prefer-hardware）' };
  }
  if (await probeVideoCandidate(cls, def.codecStrings, params, 'no-preference')) {
    return { ...base, supported: true, notes: '浏览器未确认硬件加速，将自行选择（可能回退软件编码）' };
  }
  if (await probeVideoCandidate(cls, def.codecStrings, params, 'prefer-software')) {
    return { ...base, supported: true, notes: '仅软件编码（prefer-software）可用，导出速度较慢' };
  }
  return { ...base, supported: false, notes: '当前浏览器不支持该编码器' };
}

async function probeAudioCodec(def: CodecDefinition, params: ProbeParams): Promise<CodecSupport> {
  const base = { codec: def.codec, label: def.label, kind: 'audio' as const };
  const cls = getAudioEncoderClass();
  if (!cls) {
    return { ...base, supported: false, notes: '当前环境没有 WebCodecs（AudioEncoder 不存在）' };
  }
  for (const codecString of def.codecStrings) {
    if (await isAudioConfigSupported(cls, codecString, params)) {
      return { ...base, supported: true };
    }
  }
  return { ...base, supported: false, notes: '当前浏览器不支持该音频编码器' };
}

/**
 * 探测浏览器支持的编码器（用 WebCodecs 的 VideoEncoder/AudioEncoder isConfigSupported）。
 * 在缺少 WebCodecs 的环境（如 node/vitest、旧版 Firefox）下不会抛异常，而是全部返回 supported: false。
 */
export async function probeCodecs(options?: ProbeOptions): Promise<CodecSupport[]> {
  const params = normalizeProbeParams(options);
  const key = probeCacheKey(params);
  if (options?.refresh) probeCache.delete(key);
  const cached = probeCache.get(key);
  if (cached) return cached;

  const task = (async (): Promise<CodecSupport[]> => {
    const video = await Promise.all(VIDEO_CODEC_DEFINITIONS.map((def) => probeVideoCodec(def, params)));
    const audio = await Promise.all(AUDIO_CODEC_DEFINITIONS.map((def) => probeAudioCodec(def, params)));
    return [...video, ...audio];
  })();

  probeCache.set(key, task);
  try {
    return await task;
  } catch (error) {
    // 探测本身不应让调用方失败：退化为「全部不支持」，但仍把错误记录下来方便排查
    probeCache.delete(key);
    console.warn('[capabilities] 编码器探测失败，按不支持处理：', error);
    return ALL_DEFINITIONS.map((def) => ({
      codec: def.codec,
      label: def.label,
      kind: def.kind,
      supported: false,
      notes: '编码器探测失败，已按不支持处理',
    }));
  }
}

/** 清空探测缓存（例如用户在系统设置里改了硬件加速后重新探测） */
export function clearProbeCache(): void {
  probeCache.clear();
}

/* ------------------------------------------------------------------ */
/* 预设                                                                 */
/* ------------------------------------------------------------------ */

/**
 * 内置导出预设（1080p60 / 1080p30 / 720p60 / 4K30 / WebM 1080p60）。
 * 纯函数：不探测、不访问 DOM，因此可以在 node 中直接单测。
 */
export function listPresets(): ExportPreset[] {
  return [
    {
      id: 'mp4-1080p60',
      label: '1080p 60fps（MP4 / H.264 + AAC）',
      width: 1920,
      height: 1080,
      fps: 60,
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoBitrateMbps: 12,
      audioBitrateKbps: 192,
    },
    {
      id: 'mp4-1080p30',
      label: '1080p 30fps（MP4 / H.264 + AAC）',
      width: 1920,
      height: 1080,
      fps: 30,
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoBitrateMbps: 10,
      audioBitrateKbps: 192,
    },
    {
      id: 'mp4-720p60',
      label: '720p 60fps（MP4 / H.264 + AAC）',
      width: 1280,
      height: 720,
      fps: 60,
      format: 'mp4',
      videoCodec: 'h264',
      audioCodec: 'aac',
      videoBitrateMbps: 6,
      audioBitrateKbps: 160,
    },
    {
      id: 'mp4-2160p30',
      label: '4K 30fps（MP4 / H.265 + AAC）',
      width: 3840,
      height: 2160,
      fps: 30,
      format: 'mp4',
      videoCodec: 'hevc',
      audioCodec: 'aac',
      videoBitrateMbps: 40,
      audioBitrateKbps: 256,
    },
    {
      id: 'webm-1080p60',
      label: '1080p 60fps（WebM / VP9 + Opus）',
      width: 1920,
      height: 1080,
      fps: 60,
      format: 'webm',
      videoCodec: 'vp9',
      audioCodec: 'opus',
      videoBitrateMbps: 10,
      audioBitrateKbps: 160,
    },
  ];
}

/* ------------------------------------------------------------------ */
/* 编码组合解析                                                         */
/* ------------------------------------------------------------------ */

export interface CodecResolutionRequest {
  format: 'mp4' | 'webm';
  videoCodec: string;
  audioCodec: string;
  width: number;
  height: number;
  fps: number;
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  /** 是否需要音轨；false 时不会因为音频编码器缺失而失败 */
  needAudio?: boolean;
}

interface ContainerPick {
  videoCodec: string;
  audioCodec: string | null;
  videoHardwareAcceleration?: HardwareAccelerationPreference;
  /** 该组合是否缺少音轨（视频可用但音频不可用） */
  audioDropped: boolean;
}

function hardwarePreferenceFromSupport(support: CodecSupport): HardwareAccelerationPreference | undefined {
  if (!support.supported) return undefined;
  // 只有「必须走软件编码」时才显式指定 prefer-software；
  // 硬件可用时保持不指定（no-preference），交给浏览器自行选择——
  // 显式 prefer-hardware 在个别驱动/浏览器上会让 encoder configure 直接失败。
  return (support.notes ?? '').includes('prefer-software') ? 'prefer-software' : undefined;
}

function findSupport(list: CodecSupport[], kind: CodecKind, codec: string): CodecSupport | undefined {
  return list.find((item) => item.kind === kind && item.codec === codec);
}

/** 在给定容器下挑选可用的视频/音频组合；视频不可用返回 null */
function pickContainer(
  format: 'mp4' | 'webm',
  request: CodecResolutionRequest,
  support: CodecSupport[],
): ContainerPick | null {
  const needAudio = request.needAudio !== false;
  const videoOrder = preferredOrder(request.videoCodec, VIDEO_CHAINS[format]);
  const videoCodec = videoOrder.find((codec) => findSupport(support, 'video', codec)?.supported);
  if (!videoCodec) return null;

  const videoSupport = findSupport(support, 'video', videoCodec);
  const videoHardwareAcceleration = videoSupport ? hardwarePreferenceFromSupport(videoSupport) : undefined;

  if (!needAudio) {
    return { videoCodec, audioCodec: null, videoHardwareAcceleration, audioDropped: false };
  }

  const audioOrder = preferredOrder(request.audioCodec, AUDIO_CHAINS[format]);
  const audioCodec = audioOrder.find((codec) => findSupport(support, 'audio', codec)?.supported) ?? null;
  return { videoCodec, audioCodec, videoHardwareAcceleration, audioDropped: audioCodec === null };
}

/**
 * 给定请求（预设或导出参数）返回当前环境下实际可用的编码组合：
 *  - 视频编码按容器回退链自动回退（mp4: h264 → hevc → av1 → vp9；webm: vp9 → av1）；
 *  - 音频不可用（例如 aac 不被支持）时整体回退到 webm + opus；
 *  - 实在没有任何视频编码器时抛出中文错误。
 * 音轨缺失不算失败：audioCodec 返回 null，由调用方决定是否放弃音轨。
 */
export async function resolveCodecs(request: CodecResolutionRequest): Promise<ResolvedExportCodecs> {
  const support = await probeCodecs({
    width: request.width,
    height: request.height,
    fps: request.fps,
    videoBitrateMbps: request.videoBitrateMbps,
    audioBitrateKbps: request.audioBitrateKbps,
  });

  const containers: Array<'mp4' | 'webm'> = request.format === 'mp4' ? ['mp4', 'webm'] : ['webm', 'mp4'];

  let partial: { format: 'mp4' | 'webm'; pick: ContainerPick } | null = null;

  for (const format of containers) {
    const pick = pickContainer(format, request, support);
    if (!pick) continue;
    if (pick.audioDropped) {
      // 记住这个「只有视频」的方案，但继续尝试下一个容器能否同时满足音轨
      if (!partial) partial = { format, pick };
      continue;
    }
    return buildResolution(format, pick, request, support);
  }

  if (partial) return buildResolution(partial.format, partial.pick, request, support);

  throw new Error(
    '当前浏览器不支持任何可用的 WebCodecs 视频编码器，无法导出视频。请使用 Chrome / Edge 114 或更高版本；若已是最新版本，请检查硬件加速是否被禁用。',
  );
}

function buildResolution(
  format: 'mp4' | 'webm',
  pick: ContainerPick,
  request: CodecResolutionRequest,
  support: CodecSupport[],
): ResolvedExportCodecs {
  const notes: string[] = [];
  if (format !== request.format) {
    notes.push(
      `容器回退：${request.format.toUpperCase()} 下没有可用的编码组合，已改用 ${format.toUpperCase()}`,
    );
  }
  if (pick.videoCodec !== request.videoCodec) {
    notes.push(
      `视频编码回退：${codecLabel(request.videoCodec)} 不可用，已改用 ${codecLabel(pick.videoCodec)}`,
    );
  }
  if (pick.audioCodec === null) {
    notes.push('音频编码器不可用，已放弃音轨，导出无声视频');
  } else if (pick.audioCodec !== request.audioCodec) {
    notes.push(
      `音频编码回退：${codecLabel(request.audioCodec)} 不可用，已改用 ${codecLabel(pick.audioCodec)}`,
    );
  }
  const videoNotes = findSupport(support, 'video', pick.videoCodec)?.notes;
  if (videoNotes && videoNotes.includes('prefer-software')) notes.push(videoNotes);

  const result: ResolvedExportCodecs = {
    format,
    videoCodec: pick.videoCodec,
    audioCodec: pick.audioCodec,
  };
  if (pick.videoHardwareAcceleration) result.videoHardwareAcceleration = pick.videoHardwareAcceleration;
  if (notes.length > 0) result.fallbackNote = notes.join('；');
  return result;
}

/* ------------------------------------------------------------------ */
/* 预设级 API                                                           */
/* ------------------------------------------------------------------ */

function presetToRequest(preset: ExportPreset, needAudio: boolean): CodecResolutionRequest {
  return {
    format: preset.format,
    videoCodec: preset.videoCodec,
    audioCodec: preset.audioCodec,
    width: preset.width,
    height: preset.height,
    fps: preset.fps,
    videoBitrateMbps: preset.videoBitrateMbps,
    audioBitrateKbps: preset.audioBitrateKbps,
    needAudio,
  };
}

/** 给定预设返回当前环境下实际可用的编码组合（不支持的自动回退） */
export async function resolvePreset(
  preset: ExportPreset,
): Promise<ExportPreset & { fallbackNote?: string }> {
  if (!hasWebCodecsVideoEncoder()) throw new Error(WEBCODECS_UNSUPPORTED_MESSAGE);

  const resolved = await resolveCodecs(presetToRequest(preset, true));
  if (!resolved.audioCodec) {
    throw new Error(
      '当前浏览器没有任何可用的音频编码器（AAC / Opus 均不可用），无法导出带音轨的视频。请使用 Chrome / Edge 114 或更高版本。',
    );
  }

  const result: ExportPreset & { fallbackNote?: string } = {
    ...preset,
    format: resolved.format,
    videoCodec: resolved.videoCodec,
    audioCodec: resolved.audioCodec,
    available: true,
  };
  if (resolved.fallbackNote) result.fallbackNote = resolved.fallbackNote;
  return result;
}

/** 给预设列表打上 available 标记（只以视频编码是否可用为准，避免仅因音频编码器缺失就判为不可用） */
export async function annotatePresets(presets: ExportPreset[]): Promise<ExportPreset[]> {
  const annotated: ExportPreset[] = [];
  for (const preset of presets) {
    try {
      const resolved = await resolveCodecs(presetToRequest(preset, false));
      annotated.push({
        ...preset,
        available: resolved.videoCodec === preset.videoCodec && resolved.format === preset.format,
      });
    } catch {
      annotated.push({ ...preset, available: false });
    }
  }
  return annotated;
}

/** listPresets() + 能力探测，返回带 available 标记的预设列表 */
export async function listPresetsWithSupport(): Promise<ExportPreset[]> {
  return annotatePresets(listPresets());
}
