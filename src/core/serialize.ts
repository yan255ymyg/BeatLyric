/**
 * 项目序列化 / 反序列化
 *
 * 项目文件：项目目录下的 `project.json`（UTF-8）。
 * 资源文件复制到项目目录的 `assets/` 子目录，文件名保持原始名（重名时按用户选择处理）。
 *
 * 反序列化的原则：**永远不信任磁盘内容**。所有字段都做类型校验与默认值回退，
 * 这样手工编辑过、或来自旧版本的项目文件不会让应用崩溃。
 */

import {
  ALL_EVENT_TYPES,
  APP_VERSION,
  DEFAULT_BAR_TRANSFORM,
  FORMAT_VERSION,
  type AssetIndex,
  type AssetRef,
  type Bar,
  type BeatEvent,
  type BeatEventType,
  type EffectConfig,
  type Gradient,
  type LyricLine,
  type PlaybackConfig,
  type Project,
  type RichLine,
  type SpanStyle,
  type TextAlign,
  type TextSpan,
} from '../model/model';
import {
  createBar,
  createLyricLine,
  createProject,
  createRichLine,
  defaultPlayback,
} from './factories';
import { bool, clamp, num, str, uid } from './util';

/* ------------------------------------------------------------------ */
/* 写入                                                                */
/* ------------------------------------------------------------------ */

export function serializeProject(project: Project): string {
  const clean: Project = { ...project, meta: { ...project.meta, appVersion: APP_VERSION } };
  return JSON.stringify(clean, null, 2);
}

/* ------------------------------------------------------------------ */
/* 读取辅助                                                            */
/* ------------------------------------------------------------------ */

type Raw = Record<string, unknown>;

function isObj(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function pick<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  return typeof v === 'string' && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
}

function color(v: unknown, fallback: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(s) ? s : fallback;
}

function readGradient(v: unknown): Gradient | undefined {
  if (!isObj(v)) return undefined;
  return { from: color(v.from, '#ffffff'), to: color(v.to, '#888888') };
}

function readStyle(v: unknown): SpanStyle | undefined {
  if (!isObj(v)) return undefined;
  const st: SpanStyle = {};
  if (typeof v.bold === 'boolean') st.bold = v.bold;
  if (typeof v.italic === 'boolean') st.italic = v.italic;
  // 颜色栈：1 个 = 纯色，多个 = 渐变
  if (Array.isArray(v.colors)) {
    const colors = v.colors
      .filter((c): c is string => typeof c === 'string')
      .map((c) => color(c, '#ffffff'))
      .slice(0, 16);
    if (colors.length) st.colors = colors;
  } else if (typeof v.color === 'string') {
    // 兼容旧版本：单一 color 字段
    st.colors = [color(v.color, '#ffffff')];
  } else {
    // 兼容旧版本：gradient {from,to}
    const g = readGradient(v.gradient);
    if (g) st.colors = [g.from, g.to];
  }
  if (typeof v.ruby === 'string' && v.ruby) st.ruby = v.ruby;
  if (typeof v.fontSize === 'number' && Number.isFinite(v.fontSize)) st.fontSize = clamp(v.fontSize, 10, 1000);
  if (typeof v.dy === 'number' && Number.isFinite(v.dy)) st.dy = clamp(v.dy, -200, 200);
  return Object.keys(st).length ? st : undefined;
}

function readSpans(v: unknown): TextSpan[] {
  const spans = arr(v)
    .filter(isObj)
    .map((s) => {
      const span: TextSpan = { text: typeof s.text === 'string' ? s.text : '' };
      const st = readStyle(s.style);
      if (st) span.style = st;
      return span;
    });
  return spans.length ? spans : [{ text: '' }];
}

function readRichLine(v: unknown): RichLine {
  if (!isObj(v)) return createRichLine();
  const line: RichLine = { id: str(v.id, uid('rl')), spans: readSpans(v.spans) };
  if (typeof v.align === 'string') line.align = pick<TextAlign>(v.align, ['left', 'center', 'right'], 'left');
  return line;
}

function readLyricLine(v: unknown): LyricLine {
  if (!isObj(v)) return createLyricLine();
  const subs = arr(v.subLines).map(readRichLine);
  const line: LyricLine = {
    id: str(v.id, uid('line')),
    subLines: subs.length ? subs : [createRichLine()],
  };
  if (typeof v.label === 'string' && v.label) line.label = v.label;
  if (typeof v.align === 'string') line.align = pick<TextAlign>(v.align, ['left', 'center', 'right'], 'left');
  return line;
}

function readEvent(v: unknown): BeatEvent | null {
  if (!isObj(v)) return null;
  const type = pick<BeatEventType>(v.type, ALL_EVENT_TYPES, 'char');
  const beat = num(v.beat, 0);
  const id = str(v.id, uid('ev'));
  const snap = num(v.snap, 2);
  const d: Raw = isObj(v.data) ? v.data : {};
  switch (type) {
    case 'char': {
      const lines = arr(d.lines).map(readRichLine);
      const iconColors = Array.isArray(d.colors)
        ? (d.colors as unknown[]).filter((c): c is string => typeof c === 'string').map((c) => color(c, '#4ea1ff')).slice(0, 8)
        : typeof d.color === 'string'
          ? [color(d.color, '#4ea1ff')]
          : (() => {
              const g = readGradient(d.gradient);
              return g ? [g.from, g.to] : [];
            })();
      return {
        id,
        type,
        beat,
        snap,
        data: {
          width: clamp(num(d.width, 18), 2, 400),
          heightScale: clamp(num(d.heightScale, 1.6), 1, 8),
          radius: clamp(num(d.radius, 3), 0, 200),
          colors: iconColors.length ? iconColors : undefined,
          lines: lines.length ? lines : [{ id: uid('rl'), spans: [{ text: '' }] }],
        },
      };
    }
    case 'bpm':
      return { id, type, beat, snap, data: { bpm: clamp(num(d.bpm, 120), 1, 1000) } };
    case 'pause':
      return { id, type, beat, snap, data: { ms: clamp(num(d.ms, 100), 0, 60000) } };
    case 'force':
      return {
        id,
        type,
        beat,
        snap,
        data: { lengthBeats: clamp(num(d.lengthBeats, 1), 0.0001, 512), ms: clamp(num(d.ms, 500), 1, 600000) },
      };
    case 'lrcPrev':
    case 'lrcNext':
      return {
        id,
        type,
        beat,
        snap,
        data: { offset: clamp(Math.round(num(d.offset, 1)), 0, 9999), mode: d.mode === 'abs' ? 'abs' : 'rel' },
      };
    case 'lrcTempStart':
    case 'lrcTempEnd':
      return {
        id,
        type,
        beat,
        snap,
        data: {
          index: Math.round(num(d.index, 0)),
          indexMode: d.indexMode === 'fromEnd' ? 'fromEnd' : 'zeroBased',
        },
      };
    default:
      return null;
  }
}

function readBar(v: unknown, defaultBeatCount: number): Bar {
  if (!isObj(v)) return createBar(defaultBeatCount);
  const tr: Raw = isObj(v.transform) ? v.transform : {};
  const scaleX = clamp(num(tr.scaleX, DEFAULT_BAR_TRANSFORM.scaleX), 0.05, 1);
  const maxOffset = Math.max(0, 1 - scaleX);
  const events = arr(v.events)
    .map(readEvent)
    .filter((e): e is BeatEvent => e !== null);
  const bar: Bar = {
    id: str(v.id, uid('bar')),
    // 旧版本用 replaceBeats 标记「本小节覆盖全局拍数」；现在拍数一律逐小节保存，
    // 只需读 beatCount（缺失时用新建默认值）即可，replaceBeats 被忽略。
    beatCount: clamp(Math.round(num(v.beatCount, defaultBeatCount)), 1, 256),
    transform: { scaleX, offsetX: clamp(num(tr.offsetX, 0), 0, maxOffset) },
    events,
  };
  if (typeof v.note === 'string' && v.note) bar.note = v.note;
  return bar;
}

function readAssets(v: unknown): AssetIndex {
  const out: AssetIndex = {};
  if (!isObj(v)) return out;
  for (const [key, raw] of Object.entries(v)) {
    if (!isObj(raw)) continue;
    const kind = pick(raw.kind, ['audio', 'image', 'video'] as const, 'image');
    const file = str(raw.file, '');
    if (!file) continue;
    const ref: AssetRef = {
      id: str(raw.id, key),
      kind,
      file,
      originalName: str(raw.originalName, file.split('/').pop() ?? file),
      mime: str(raw.mime, 'application/octet-stream'),
      size: Math.max(0, num(raw.size, 0)),
      sha256: str(raw.sha256, ''),
      addedAt: num(raw.addedAt, Date.now()),
    };
    if (typeof raw.duration === 'number' && Number.isFinite(raw.duration)) ref.duration = raw.duration;
    if (typeof raw.width === 'number' && Number.isFinite(raw.width)) ref.width = raw.width;
    if (typeof raw.height === 'number' && Number.isFinite(raw.height)) ref.height = raw.height;
    out[ref.id] = ref;
  }
  return out;
}

function readPlayback(v: unknown, canvasW: number, canvasH: number): PlaybackConfig {
  const base = defaultPlayback(canvasW, canvasH);
  if (!isObj(v)) return base;

  const readPos = (raw: unknown, fb: { x: number; y: number }) => {
    if (!isObj(raw)) return { ...fb };
    return { x: clamp(num(raw.x, fb.x), -1, 2), y: clamp(num(raw.y, fb.y), -1, 2) };
  };

  const out: PlaybackConfig = JSON.parse(JSON.stringify(base)) as PlaybackConfig;

  if (isObj(v.album)) {
    const a = v.album;
    out.album = {
      enabled: bool(a.enabled, out.album.enabled),
      assetId: typeof a.assetId === 'string' ? a.assetId : null,
      pos: readPos(a.pos, out.album.pos),
      size: clamp(num(a.size, out.album.size), 0.01, 3),
      discStyle: bool(a.discStyle, out.album.discStyle),
      discColor: color(a.discColor, out.album.discColor),
      rotate: bool(a.rotate, out.album.rotate),
      rotateSpeed: clamp(num(a.rotateSpeed, out.album.rotateSpeed), -720, 720),
      spinAnimation: bool(a.spinAnimation, out.album.spinAnimation),
      opacity: clamp(num(a.opacity, out.album.opacity), 0, 1),
      cornerRadius: clamp(num(a.cornerRadius, out.album.cornerRadius), 0, 500),
      shadow: bool(a.shadow, out.album.shadow),
    };
  }

  if (isObj(v.beat)) {
    const b = v.beat;
    const fb = out.beat;
    const ev: Record<string, { icon: boolean; text: boolean }> = {};
    const rawEv = isObj(b.eventVisibility) ? b.eventVisibility : {};
    ALL_EVENT_TYPES.forEach((t) => {
      const r = isObj(rawEv[t]) ? (rawEv[t] as Raw) : {};
      ev[t] = {
        icon: bool(r.icon, fb.eventVisibility[t].icon),
        text: bool(r.text, fb.eventVisibility[t].text),
      };
    });
    out.beat = {
      ...fb,
      pos: readPos(b.pos, fb.pos),
      anchor: pick(b.anchor, ['bottom', 'top', 'center'] as const, fb.anchor),
      // 兼容旧版本：只有单个 scale 时同时作为横纵缩放
      scaleX: clamp(num(b.scaleX ?? b.scale, fb.scaleX), 0.05, 8),
      scaleY: clamp(num(b.scaleY ?? b.scale, fb.scaleY), 0.05, 8),
      visibleBarCount: clamp(Math.round(num(b.visibleBarCount, fb.visibleBarCount)), 1, 16),
      currentOpacity: clamp(num(b.currentOpacity, fb.currentOpacity), 0, 1),
      nextOpacity: clamp(num(b.nextOpacity, fb.nextOpacity), 0, 1),
      fadingOpacity: clamp(num(b.fadingOpacity, fb.fadingOpacity), 0, 1),
      barHeight: clamp(num(b.barHeight, fb.barHeight), 2, 200),
      barFill: readGradient(b.barFill) ?? fb.barFill,
      barStroke: color(b.barStroke, fb.barStroke),
      barStrokeWidth: clamp(num(b.barStrokeWidth, fb.barStrokeWidth), 0, 20),
      beatMarkWidth: clamp(num(b.beatMarkWidth, fb.beatMarkWidth), 1, 40),
      beatMarkFill: readGradient(b.beatMarkFill) ?? fb.beatMarkFill,
      beatMarkStroke: color(b.beatMarkStroke, fb.beatMarkStroke),
      beatMarkStrokeWidth: clamp(num(b.beatMarkStrokeWidth, fb.beatMarkStrokeWidth), 0, 10),
      showBeatNumbers: bool(b.showBeatNumbers, fb.showBeatNumbers),
      beatNumberColor: color(b.beatNumberColor, fb.beatNumberColor),
      beatNumberFontSize: clamp(num(b.beatNumberFontSize, fb.beatNumberFontSize), 4, 200),
      beatNumberBold: bool(b.beatNumberBold, fb.beatNumberBold),
      textFontSize: clamp(num(b.textFontSize, fb.textFontSize), 4, 400),
      textColor: color(b.textColor, fb.textColor),
      textOutlineColor: color(b.textOutlineColor, fb.textOutlineColor),
      textOutlineWidth: clamp(num(b.textOutlineWidth, fb.textOutlineWidth), 0, 40),
      textGap: clamp(num(b.textGap, fb.textGap), -200, 400),
      rowGap: clamp(num(b.rowGap, fb.rowGap), 0, 600),
      showBarLabel: bool(b.showBarLabel, fb.showBarLabel),
      labelColor: color(b.labelColor, fb.labelColor),
      labelFontSize: clamp(num(b.labelFontSize, fb.labelFontSize), 4, 200),
      showPlayhead: bool(b.showPlayhead, fb.showPlayhead),
      playheadColor: color(b.playheadColor, fb.playheadColor),
      pulseMs: clamp(num(b.pulseMs, fb.pulseMs), 0, 5000),
      pulseScale: clamp(num(b.pulseScale, fb.pulseScale), 1, 8),
      eventVisibility: ev as PlaybackConfig['beat']['eventVisibility'],
      eventLabelFontSize: clamp(num(b.eventLabelFontSize, fb.eventLabelFontSize), 4, 200),
      eventLabelColor: color(b.eventLabelColor, fb.eventLabelColor),
      transitionBeats: clamp(num(b.transitionBeats, fb.transitionBeats), 0, 8),
      rubyScale: clamp(num(b.rubyScale, fb.rubyScale), 0.1, 2),
      rubyGap: clamp(num(b.rubyGap, fb.rubyGap), -20, 60),
    };
  }

  if (isObj(v.lrc)) {
    const l = v.lrc;
    const fb = out.lrc;
    out.lrc = {
      ...fb,
      pos: readPos(l.pos, fb.pos),
      fontSize: clamp(num(l.fontSize, fb.fontSize), 4, 400),
      rubyScale: clamp(num(l.rubyScale, fb.rubyScale), 0.1, 2),
      rubyGap: clamp(num(l.rubyGap, fb.rubyGap), -20, 60),
      bold: bool(l.bold, fb.bold),
      color: color(l.color, fb.color),
      outlineColor: color(l.outlineColor, fb.outlineColor),
      outlineWidth: clamp(num(l.outlineWidth, fb.outlineWidth), 0, 40),
      shadow: bool(l.shadow, fb.shadow),
      lineSpacing: clamp(num(l.lineSpacing, fb.lineSpacing), 0.5, 6),
      mainScale: clamp(num(l.mainScale, fb.mainScale), 0.2, 4),
      mainBold: bool(l.mainBold, fb.mainBold),
      mainColor: color(l.mainColor, fb.mainColor),
      aboveCount: clamp(Math.round(num(l.aboveCount, fb.aboveCount)), 0, 20),
      belowCount: clamp(Math.round(num(l.belowCount, fb.belowCount)), 0, 20),
      inactiveOpacity: clamp(num(l.inactiveOpacity, fb.inactiveOpacity), 0, 1),
      tempOpacity: clamp(num(l.tempOpacity, fb.tempOpacity), 0, 1),
      mainOpacity: clamp(num(l.mainOpacity, fb.mainOpacity), 0, 1),
      tempGapScale: clamp(num(l.tempGapScale, fb.tempGapScale), 0, 8),
      align: pick(l.align, ['left', 'center', 'right'] as const, fb.align),
    };
  }

  if (isObj(v.video)) {
    const vv = v.video;
    const fb = out.video;
    out.video = {
      enabled: bool(vv.enabled, fb.enabled),
      assetId: typeof vv.assetId === 'string' ? vv.assetId : null,
      offsetMs: clamp(num(vv.offsetMs, fb.offsetMs), -3600000, 3600000),
      fit: pick(vv.fit, ['cover', 'contain', 'fill'] as const, fb.fit),
      zoom: clamp(num(vv.zoom, fb.zoom), 0.1, 8),
      opacity: clamp(num(vv.opacity, fb.opacity), 0, 1),
      loop: bool(vv.loop, fb.loop),
    };
  }

  if (isObj(v.spectrum)) {
    const s = v.spectrum;
    const fb = out.spectrum;
    out.spectrum = {
      ...fb,
      enabled: bool(s.enabled, fb.enabled),
      style: pick(s.style, ['bars', 'mirror', 'wave', 'dots'] as const, fb.style),
      direction: pick(s.direction, ['up', 'down', 'left', 'right'] as const, fb.direction),
      columns: clamp(Math.round(num(s.columns, fb.columns)), 4, 512),
      pos: readPos(s.pos, fb.pos),
      width: clamp(num(s.width, fb.width), 0.01, 4),
      height: clamp(num(s.height, fb.height), 0.01, 4),
      barGap: clamp(num(s.barGap, fb.barGap), 0, 0.9),
      color: color(s.color, fb.color),
      colorTo: color(s.colorTo, fb.colorTo),
      gradient: bool(s.gradient, fb.gradient),
      opacity: clamp(num(s.opacity, fb.opacity), 0, 1),
      minFreq: clamp(num(s.minFreq, fb.minFreq), 10, 20000),
      maxFreq: clamp(num(s.maxFreq, fb.maxFreq), 20, 24000),
      smoothing: clamp(num(s.smoothing, fb.smoothing), 0, 0.99),
      gain: clamp(num(s.gain, fb.gain), 0, 20),
      outline: bool(s.outline, fb.outline),
    };
  }

  if (Array.isArray(v.effects)) {
    const parsed: EffectConfig[] = arr(v.effects)
      .filter(isObj)
      .map((e) => ({
        id: str(e.id, uid('fx')),
        type: pick(
          e.type,
          ['shake', 'beatPulse', 'barPulse', 'charBounce', 'sparks', 'flash'] as const,
          'beatPulse',
        ),
        enabled: bool(e.enabled, false),
        trigger: pick(e.trigger, ['beat', 'bar', 'char'] as const, 'beat'),
        strength: clamp(num(e.strength, 0.05), 0, 100),
        durationMs: clamp(num(e.durationMs, 150), 1, 20000),
        frequency: clamp(num(e.frequency, 2), 0.01, 240),
        color: typeof e.color === 'string' ? color(e.color, '#ffffff') : undefined,
        count: typeof e.count === 'number' ? clamp(Math.round(e.count), 1, 2000) : undefined,
        downbeatOnly: typeof e.downbeatOnly === 'boolean' ? e.downbeatOnly : undefined,
      }));
    if (parsed.length) out.effects = parsed;
  }

  if (isObj(v.export)) {
    const e = v.export;
    const fb = out.export;
    out.export = {
      ...fb,
      width: clamp(Math.round(num(e.width, fb.width)), 16, 7680),
      height: clamp(Math.round(num(e.height, fb.height)), 16, 4320),
      fps: clamp(num(e.fps, fb.fps), 1, 240),
      format: pick(e.format, ['mp4', 'webm'] as const, fb.format),
      videoBitrateMbps: clamp(num(e.videoBitrateMbps, fb.videoBitrateMbps), 0.1, 500),
      audioBitrateKbps: clamp(num(e.audioBitrateKbps, fb.audioBitrateKbps), 8, 1024),
      videoCodec: str(e.videoCodec, fb.videoCodec),
      audioCodec: str(e.audioCodec, fb.audioCodec),
      useCanvasSize: bool(e.useCanvasSize, fb.useCanvasSize),
      quality: pick(e.quality, ['speed', 'balanced', 'quality'] as const, fb.quality),
    };
  }

  out.followPlayhead = bool(v.followPlayhead, base.followPlayhead);
  out.followMainLine = bool(v.followMainLine, base.followMainLine);
  return out;
}

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export interface LoadResult {
  project: Project;
  /** 读取过程中的告警（例如缺少资源文件），供 UI 提示用户 */
  warnings: string[];
}

export function deserializeProject(text: string): LoadResult {
  const warnings: string[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('project.json 不是合法的 JSON，无法读取。');
  }
  if (!isObj(raw)) throw new Error('project.json 的顶层结构不是对象。');

  const fmt = num(raw.formatVersion, 1);
  if (fmt > FORMAT_VERSION) {
    warnings.push(`项目文件版本（${fmt}）高于当前应用（${FORMAT_VERSION}），可能有内容无法识别。`);
  }

  const base = createProject();
  const tl: Raw = isObj(raw.timeline) ? raw.timeline : {};
  // 兼容旧版本字段名 beatsPerBar；缺失时按已有小节的拍数众数推断，最后才用默认值
  const beatsPerNewBar = clamp(
    Math.round(num(tl.beatsPerNewBar ?? tl.beatsPerBar, base.timeline.beatsPerNewBar)),
    1,
    256,
  );

  const meta: Raw = isObj(raw.meta) ? raw.meta : {};
  const canvas: Raw = isObj(raw.canvas) ? raw.canvas : {};
  const width = clamp(Math.round(num(canvas.width, base.canvas.width)), 16, 7680);
  const height = clamp(Math.round(num(canvas.height, base.canvas.height)), 16, 4320);

  const bars = arr(raw.bars).map((b) => readBar(b, beatsPerNewBar));
  const lines = arr(raw.lines).map(readLyricLine);
  const assets = readAssets(raw.assets);

  const project: Project = {
    formatVersion: FORMAT_VERSION,
    meta: {
      name: str(meta.name, base.meta.name),
      artist: str(meta.artist, ''),
      createdAt: num(meta.createdAt, Date.now()),
      updatedAt: num(meta.updatedAt, Date.now()),
      appVersion: str(meta.appVersion, APP_VERSION),
    },
    timeline: {
      bpm: clamp(num(tl.bpm, base.timeline.bpm), 1, 1000),
      beatsPerNewBar,
      audioOffsetMs: clamp(num(tl.audioOffsetMs, base.timeline.audioOffsetMs), -3600000, 3600000),
      defaultSnap: clamp(Math.round(num(tl.defaultSnap, base.timeline.defaultSnap)), 0, 8),
      customSnap: clamp(Math.round(num(tl.customSnap, base.timeline.customSnap)), 2, 256),
    },
    canvas: {
      width,
      height,
      background: color(canvas.background, base.canvas.background),
      gradient: readGradient(canvas.gradient),
    },
    assets,
    audioAssetId: typeof raw.audioAssetId === 'string' && raw.audioAssetId ? raw.audioAssetId : null,
    peaksFile: typeof raw.peaksFile === 'string' && raw.peaksFile ? raw.peaksFile : null,
    bars: bars.length ? bars : base.bars,
    lines,
    playback: readPlayback(raw.playback, width, height),
  };

  if (project.audioAssetId && !assets[project.audioAssetId]) {
    warnings.push('项目记录的音频资源在资源表中不存在，已清除音频设置。');
    project.audioAssetId = null;
  }
  return { project, warnings };
}

/** 校验项目目录中是否存在必要的资源文件；返回缺失项描述 */
export function findMissingAssets(project: Project, existingFiles: Set<string>): string[] {
  const missing: string[] = [];
  for (const ref of Object.values(project.assets)) {
    if (!existingFiles.has(ref.file)) missing.push(`${ref.originalName}（${ref.file}）`);
  }
  return missing;
}
