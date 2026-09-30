/** 默认值与工厂函数 */

import {
  ALL_EVENT_TYPES,
  APP_VERSION,
  DEFAULT_BAR_TRANSFORM,
  FORMAT_VERSION,
  type Bar,
  type BeatDisplayConfig,
  type BeatEvent,
  type BeatEventType,
  type CharEventData,
  type EffectConfig,
  type ExportConfig,
  type LineRole,
  type LyricLine,
  type PlaybackConfig,
  type Project,
  type RichLine,
  type TextSpan,
} from '../model/model';
import { uid } from './util';

export function defaultCharData(): CharEventData {
  return {
    width: 18,
    heightScale: 1.7,
    radius: 3,
    colors: ['#4ea1ff'],
    lines: [{ id: uid('rl'), spans: [{ text: 'あ' }] }],
  };
}

export function defaultEventData(type: BeatEventType): BeatEvent['data'] {
  switch (type) {
    case 'char':
      return defaultCharData();
    case 'bpm':
      return { bpm: 120 };
    case 'pause':
      return { ms: 100 };
    case 'force':
      return { lengthBeats: 1, ms: 500 };
    case 'lrcPrev':
      return { offset: 1, mode: 'rel' };
    case 'lrcNext':
      return { offset: 1, mode: 'rel' };
    case 'lrcTempStart':
      return { index: 0, indexMode: 'zeroBased' };
    case 'lrcTempEnd':
      return { index: 0, indexMode: 'zeroBased' };
  }
}

export function createEvent(type: BeatEventType, beat: number, snap = 2): BeatEvent {
  const base = { id: uid('ev'), beat, snap, type } as BeatEvent;
  return { ...base, data: defaultEventData(type) } as BeatEvent;
}

export function createBar(beatCount: number): Bar {
  return {
    id: uid('bar'),
    beatCount,
    transform: { ...DEFAULT_BAR_TRANSFORM },
    events: [],
  };
}

export function createRichLine(text = ''): RichLine {
  return { id: uid('rl'), spans: text ? [{ text }] : [{ text: '' }] };
}

export function createLyricLine(role: LineRole = 'original'): LyricLine {
  void role;
  return { id: uid('line'), subLines: [createRichLine()] };
}

export function spanOf(text: string, style?: TextSpan['style']): TextSpan {
  return style ? { text, style } : { text };
}

export function defaultBeatDisplay(): BeatDisplayConfig {
  const eventVisibility = {} as Record<BeatEventType, { icon: boolean; text: boolean }>;
  ALL_EVENT_TYPES.forEach((t) => {
    // 默认全部显示：图标是事件的形态，文本是它的含义（歌词字文本在图标正下方）
    eventVisibility[t] = { icon: true, text: true };
  });
  return {
    pos: { x: 0.5, y: 0.84 },
    anchor: 'bottom',
    scaleX: 1,
    scaleY: 1,
    visibleBarCount: 2,
    currentOpacity: 1,
    nextOpacity: 0.85,
    fadingOpacity: 0,
    barHeight: 14,
    barFill: { from: '#3fb6e8', to: '#2f8fd0' },
    barStroke: '#9fd6f5',
    barStrokeWidth: 1,
    beatMarkWidth: 4,
    beatMarkFill: { from: '#ffd93d', to: '#f5b800' },
    beatMarkStroke: '#fff3b0',
    beatMarkStrokeWidth: 0.8,
    showBeatNumbers: true,
    beatNumberColor: '#dbe6f5',
    beatNumberFontSize: 13,
    beatNumberBold: false,
    textFontSize: 34,
    textColor: '#dbe6f5',
    textOutlineColor: '#05070c',
    textOutlineWidth: 3,
    textGap: 14,
    rowGap: 34,
    showBarLabel: true,
    labelColor: '#8fa3c0',
    labelFontSize: 13,
    showPlayhead: true,
    playheadColor: '#ff5d73',
    pulseMs: 320,
    pulseScale: 1.7,
    eventVisibility,
    eventLabelFontSize: 12,
    eventLabelColor: '#e8eef8',
    transitionBeats: 0.5,
    rubyScale: 0.55,
    rubyGap: 2,
  };
}

export function defaultAlbum() {
  return {
    enabled: true,
    assetId: null,
    pos: { x: 0.2, y: 0.42 },
    size: 0.3,
    discStyle: false,
    discColor: '#0d0f14',
    rotate: false,
    rotateSpeed: 12,
    spinAnimation: false,
    opacity: 1,
    cornerRadius: 8,
    shadow: true,
  };
}

export function defaultLrcDisplay() {
  return {
    pos: { x: 0.68, y: 0.45 },
    fontSize: 34,
    rubyScale: 0.55,
    rubyGap: 2,
    bold: true,
    color: '#dbe6f5',
    outlineColor: '#0b1018',
    outlineWidth: 4,
    shadow: true,
    lineSpacing: 1.45,
    mainScale: 1.18,
    mainBold: true,
    mainColor: '#ffffff',
    aboveCount: 2,
    belowCount: 2,
    inactiveOpacity: 0.45,
    tempOpacity: 1,
    mainOpacity: 1,
    tempGapScale: 1,
    align: 'left' as const,
  };
}

export function defaultSpectrum() {
  return {
    enabled: false,
    style: 'bars' as const,
    direction: 'up' as const,
    columns: 48,
    pos: { x: 0.5, y: 0.5 },
    width: 0.8,
    height: 0.2,
    barGap: 0.25,
    color: '#4ea1ff',
    colorTo: '#ff5d73',
    gradient: true,
    opacity: 0.85,
    minFreq: 40,
    maxFreq: 16000,
    smoothing: 0.75,
    gain: 1,
    outline: false,
  };
}

export function defaultVideo() {
  return {
    enabled: false,
    assetId: null,
    offsetMs: 0,
    fit: 'cover' as const,
    zoom: 1,
    opacity: 1,
    loop: true,
  };
}

export function defaultEffects(): EffectConfig[] {
  return [
    { id: uid('fx'), type: 'beatPulse', enabled: false, trigger: 'beat', strength: 0.03, durationMs: 120, frequency: 2 },
    { id: uid('fx'), type: 'barPulse', enabled: false, trigger: 'bar', strength: 0.06, durationMs: 260, frequency: 2 },
    { id: uid('fx'), type: 'shake', enabled: false, trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 },
    { id: uid('fx'), type: 'charBounce', enabled: false, trigger: 'char', strength: 0.25, durationMs: 180, frequency: 2 },
    { id: uid('fx'), type: 'sparks', enabled: false, trigger: 'char', strength: 1, durationMs: 900, count: 14, color: '#ffd27f', frequency: 1 },
    { id: uid('fx'), type: 'flash', enabled: false, trigger: 'bar', strength: 0.25, durationMs: 160, color: '#ffffff', frequency: 1 },
  ];
}

export function defaultExport(width = 1920, height = 1080): ExportConfig {
  return {
    width,
    height,
    fps: 60,
    format: 'mp4',
    videoBitrateMbps: 12,
    audioBitrateKbps: 192,
    videoCodec: 'h264',
    audioCodec: 'aac',
    useCanvasSize: true,
    quality: 'quality',
  };
}

export function defaultPlayback(canvasW = 1920, canvasH = 1080): PlaybackConfig {
  return {
    album: defaultAlbum(),
    beat: defaultBeatDisplay(),
    lrc: defaultLrcDisplay(),
    video: defaultVideo(),
    spectrum: defaultSpectrum(),
    effects: defaultEffects(),
    export: defaultExport(canvasW, canvasH),
    followPlayhead: true,
    followMainLine: true,
  };
}

/** 新建项目：默认给出 8 个 4 拍小节，方便直接开始编辑 */
export function createProject(name = '未命名项目'): Project {
  const canvas = { width: 1920, height: 1080, background: '#05070c' };
  const beatsPerNewBar = 4;
  const bars: Bar[] = [];
  for (let i = 0; i < 8; i++) bars.push(createBar(beatsPerNewBar));
  return {
    formatVersion: FORMAT_VERSION,
    meta: { name, artist: '', createdAt: Date.now(), updatedAt: Date.now(), appVersion: APP_VERSION },
    timeline: { bpm: 128, beatsPerNewBar, audioOffsetMs: 0, defaultSnap: 2, customSnap: 16 },
    canvas,
    assets: {},
    audioAssetId: null,
    peaksFile: null,
    bars,
    lines: [],
    playback: defaultPlayback(canvas.width, canvas.height),
  };
}

/** 按当前设置追加一个小节 */
export function createBarFromProject(project: Project): Bar {
  return createBar(project.timeline.beatsPerNewBar);
}
