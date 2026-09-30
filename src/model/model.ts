/**
 * 逐拍歌词工作台 —— 核心数据模型
 *
 * 命名约定
 *  - 时间位置一律使用「拍」为单位（beat number），不使用毫秒；毫秒仅在音频偏移等边界出现。
 *  - 拍号约定：一小节内第 1 拍开始时 beat = startBeat + 1（即 startBeat 是第 1 拍之前的「第 0 秒」）。
 *    因此一小节的合法事件位置区间是 [startBeat + 1, startBeat + beatCount + 1)。
 *  - 小节自身不存 startBeat，由前面所有小节的 beatCount 累加得出（见 timeline.ts）。
 */

export const PROJECT_FILE = 'project.json';
export const ASSET_DIR = 'assets';
export const PROJECT_EXT = '.blsp';

/* ------------------------------------------------------------------ */
/* 媒体资源                                                             */
/* ------------------------------------------------------------------ */

export type AssetKind = 'audio' | 'image' | 'video';

export interface AssetRef {
  id: string;
  kind: AssetKind;
  /** 相对项目目录的文件名（含子目录），例如 "assets/song.mp3" */
  file: string;
  /** 原始导入文件名，仅用于显示 */
  originalName: string;
  mime: string;
  size: number;
  /** 内容 SHA-256，用于去重 */
  sha256: string;
  duration?: number;
  width?: number;
  height?: number;
  addedAt: number;
}

export type AssetIndex = Record<string, AssetRef>;

/* ------------------------------------------------------------------ */
/* 富文本                                                               */
/* ------------------------------------------------------------------ */

export type TextAlign = 'left' | 'center' | 'right';

/** 上下渐变色，按文本行独立应用（每一行从上色渐变到下色） */
export interface Gradient {
  from: string;
  to: string;
}

export interface SpanStyle {
  bold?: boolean;
  italic?: boolean;
  /**
   * 颜色栈，自上而下作用于该段文本所在的行盒。
   *  - 1 个颜色 = 纯色
   *  - 多个颜色 = 由上至下的渐变（按顺序均匀分布色标）
   * 空数组或未设置 = 用整体默认颜色。
   */
  colors?: string[];
  /** ruby 注音（字顶注音） */
  ruby?: string;
  fontSize?: number;
  /** 相对基线偏移，正数向上，单位 px（画布坐标） */
  dy?: number;
}

/** 一段连续文本及其局部样式 */
export interface TextSpan {
  text: string;
  style?: SpanStyle;
}

export type LineAlign = TextAlign;

export interface RichLine {
  id: string;
  spans: TextSpan[];
  align?: LineAlign;
}

export type LineRole = 'original' | 'translation' | 'roman' | 'note';

/** 逐行歌词的一个「块」（用户口中的「行」），内部可含多个子行 */
export interface LyricLine {
  id: string;
  label?: string;
  /** 该块整体水平对齐，默认左对齐 */
  align?: LineAlign;
  subLines: RichLine[];
}

/* ------------------------------------------------------------------ */
/* 逐行歌词显示设置                                                     */
/* ------------------------------------------------------------------ */

export interface LrcDisplayConfig {
  /** 主歌词相对画布的位置，归一化 0..1（x = 中心，y = 中心） */
  pos: { x: number; y: number };
  fontSize: number;
  /** ruby 注音字号相对原词字号的比例 */
  rubyScale: number;
  rubyGap: number;
  bold: boolean;
  color: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: boolean;
  lineSpacing: number;
  /** 主歌词行的突出样式 */
  mainScale: number;
  mainBold: boolean;
  mainColor: string;
  /** 主歌词行上方、下方各展示多少个普通块 */
  aboveCount: number;
  belowCount: number;
  /** 未突出显示行的透明度 */
  inactiveOpacity: number;
  /** 临时行透明度 */
  tempOpacity: number;
  /** 主歌词行整体的透明度 */
  mainOpacity: number;
  /** 临时行相对主歌词行的额外间距（倍） */
  tempGapScale: number;
  /** 每行之间的对齐方式 */
  align: LineAlign;
}

/* ------------------------------------------------------------------ */
/* 逐拍歌词事件                                                         */
/* ------------------------------------------------------------------ */

export type BeatEventType =
  | 'char'
  | 'bpm'
  | 'pause'
  | 'force'
  | 'lrcPrev'
  | 'lrcNext'
  | 'lrcTempStart'
  | 'lrcTempEnd';

/** 歌词字：一个音节/一个发音单元 */
export interface CharEventData {
  /** 事件图标宽度（px，画布坐标），用户可调 */
  width: number;
  /** 图标高度相对时间轴高度的倍数 */
  heightScale: number;
  /** 图标圆角半径 */
  radius: number;
  /**
   * 图标填充颜色栈：1 个 = 纯色，多个 = 自上而下渐变。
   * 注意这是**图标本身**的颜色，与文本颜色是分开的两件事。
   */
  colors?: string[];
  /** 显示在图标正下方的文本（即发音），支持多行（多子行）与局部样式 */
  lines: RichLine[];
}

export interface BpmEventData {
  bpm: number;
}

export interface PauseEventData {
  ms: number;
}

export interface ForceEventData {
  /** 覆盖的长度，单位拍 */
  lengthBeats: number;
  /** 播放头匀速走完这段覆盖所需的毫秒数 */
  ms: number;
}

/** 逐行歌词「上一句 / 下一句」：相对当前主行偏移多少个块 */
export interface LrcJumpEventData {
  offset: number;
  /** 目标块索引策略：绝对索引（abs）或相对偏移（rel），默认 rel */
  mode?: 'rel' | 'abs';
}

export interface LrcTempEventData {
  /** 目标块索引，indexMode = 'fromEnd' 时负数表示从末尾开始 */
  index: number;
  indexMode?: 'zeroBased' | 'fromEnd';
}

export interface BeatEventBase {
  id: string;
  /** 事件锚点，单位拍（小节内绝对拍号） */
  beat: number;
  /** 吸附网格分母，仅用于编辑器显示 */
  snap?: number;
}

export type BeatEvent =
  | (BeatEventBase & { type: 'char'; data: CharEventData })
  | (BeatEventBase & { type: 'bpm'; data: BpmEventData })
  | (BeatEventBase & { type: 'pause'; data: PauseEventData })
  | (BeatEventBase & { type: 'force'; data: ForceEventData })
  | (BeatEventBase & { type: 'lrcPrev'; data: LrcJumpEventData })
  | (BeatEventBase & { type: 'lrcNext'; data: LrcJumpEventData })
  | (BeatEventBase & { type: 'lrcTempStart'; data: LrcTempEventData })
  | (BeatEventBase & { type: 'lrcTempEnd'; data: LrcTempEventData });

export type BeatEventDataOf<T extends BeatEventType> = Extract<BeatEvent, { type: T }>['data'];

/** 会随时间占据一段区间的事件类型 */
export const SPAN_EVENT_TYPES: BeatEventType[] = ['force'];

export function isSpanEvent(e: BeatEvent): e is Extract<BeatEvent, { type: 'force' }> {
  return e.type === 'force';
}

/* ------------------------------------------------------------------ */
/* 小节                                                                 */
/* ------------------------------------------------------------------ */

export interface BarTransform {
  /** 竖直方向缩放（0.1 ~ 1]，1 = 占满整行宽度 */
  scaleX: number;
  /** 时间轴左边界位置，占小节宽度的比例（0 ~ 1-scaleX） */
  offsetX: number;
}

export const DEFAULT_BAR_TRANSFORM: BarTransform = { scaleX: 1, offsetX: 0 };

export interface Bar {
  id: string;
  beatCount: number;
  transform: BarTransform;
  events: BeatEvent[];
  note?: string;
}

/* ------------------------------------------------------------------ */
/* 逐拍歌词显示设置                                                     */
/* ------------------------------------------------------------------ */

export type BeatAnchor = 'bottom' | 'top' | 'center';

export interface BeatEventVisibility {
  icon: boolean;
  text: boolean;
}

export interface BeatDisplayConfig {
  pos: { x: number; y: number };
  anchor: BeatAnchor;
  /** 横向缩放 */
  scaleX: number;
  /** 纵向缩放 */
  scaleY: number;
  /** 至少 1 小节 */
  visibleBarCount: number;
  /** 当前小节透明度 */
  currentOpacity: number;
  /** 后续小节透明度 */
  nextOpacity: number;
  /** 已播放完、正在渐隐的小节透明度 */
  fadingOpacity: number;
  /** 主轴高度，px */
  barHeight: number;
  /** 主轴填充渐变 */
  barFill: Gradient;
  barStroke: string;
  barStrokeWidth: number;
  /** 每拍刻度的宽度（px，横向缩放仍会乘上去） */
  beatMarkWidth: number;
  /** 每拍刻度的填充渐变 */
  beatMarkFill: Gradient;
  beatMarkStroke: string;
  beatMarkStrokeWidth: number;
  /** 是否在刻度正下方显示节拍序号 */
  showBeatNumbers: boolean;
  beatNumberColor: string;
  beatNumberFontSize: number;
  beatNumberBold: boolean;
  /** 歌词字默认文本样式 */
  textFontSize: number;
  textColor: string;
  textOutlineColor: string;
  textOutlineWidth: number;
  /** 歌词字文本与主轴的垂直间距 */
  textGap: number;
  /** 小节之间纵向间距，px */
  rowGap: number;
  /** 每小节左侧的行号/节拍数标注 */
  showBarLabel: boolean;
  labelColor: string;
  labelFontSize: number;
  /** 播放头 */
  showPlayhead: boolean;
  playheadColor: string;
  /** 扫过事件的放大渐隐动画时长（ms）与放大倍数 */
  pulseMs: number;
  pulseScale: number;
  /** 逐事件类型的图标 / 文本可见性 */
  eventVisibility: Record<BeatEventType, BeatEventVisibility>;
  /** 事件文本字号 */
  eventLabelFontSize: number;
  eventLabelColor: string;
  /** 小节过渡动画时长（拍） */
  transitionBeats: number;
  /** 歌词字 ruby 注音的字号比例与间距 */
  rubyScale: number;
  rubyGap: number;
}

/* ------------------------------------------------------------------ */
/* 播放页面设置                                                         */
/* ------------------------------------------------------------------ */

export interface AlbumConfig {
  enabled: boolean;
  assetId: string | null;
  /** 圆心位置，归一化 */
  pos: { x: number; y: number };
  /** 直径，归一化到画布宽度 */
  size: number;
  discStyle: boolean;
  discColor: string;
  rotate: boolean;
  /** 每秒旋转角度 */
  rotateSpeed: number;
  spinAnimation: boolean;
  opacity: number;
  cornerRadius: number;
  shadow: boolean;
}

export interface VideoBackgroundConfig {
  enabled: boolean;
  assetId: string | null;
  /** 视频相对音频的时间偏移（ms） */
  offsetMs: number;
  fit: 'cover' | 'contain' | 'fill';
  /** 归一化裁剪，0 = 不裁剪 */
  zoom: number;
  opacity: number;
  /** 循环播放 */
  loop: boolean;
}

export type SpectrumStyle = 'bars' | 'mirror' | 'wave' | 'dots';

export interface SpectrumConfig {
  enabled: boolean;
  style: SpectrumStyle;
  /** 方向 */
  direction: 'up' | 'down' | 'left' | 'right';
  /** 列数 */
  columns: number;
  /** 归一化位置与尺寸 */
  pos: { x: number; y: number };
  width: number;
  height: number;
  barGap: number;
  color: string;
  colorTo: string;
  gradient: boolean;
  opacity: number;
  /** 最小/最大频率，Hz */
  minFreq: number;
  maxFreq: number;
  /** 平滑/衰减 */
  smoothing: number;
  /** 振幅增益 */
  gain: number;
  outline: boolean;
}

export type EffectType = 'shake' | 'beatPulse' | 'barPulse' | 'charBounce' | 'sparks' | 'flash';

export interface EffectConfig {
  id: string;
  type: EffectType;
  enabled: boolean;
  /** 触发源：整拍 / 整小节 / 歌词字 */
  trigger: 'beat' | 'bar' | 'char';
  /** 强度（含义随类型变化） */
  strength: number;
  /** 持续时间 ms */
  durationMs: number;
  /** 频率（抖动/闪烁） */
  frequency: number;
  color?: string;
  /** 火星数量 */
  count?: number;
  /** 是否只对「重拍」触发（每小节第 1 拍） */
  downbeatOnly?: boolean;
}

export interface ExportConfig {
  width: number;
  height: number;
  fps: number;
  format: 'mp4' | 'webm';
  videoBitrateMbps: number;
  audioBitrateKbps: number;
  /** 'h264' | 'hevc' | 'av1' | 'vp9' */
  videoCodec: string;
  /** 'aac' | 'opus' */
  audioCodec: string;
  /** 使用项目画布尺寸而非自定义 */
  useCanvasSize: boolean;
  /** 渲染质量：'speed' | 'balanced' | 'quality' */
  quality: 'speed' | 'balanced' | 'quality';
}

export interface PlaybackConfig {
  album: AlbumConfig;
  beat: BeatDisplayConfig;
  lrc: LrcDisplayConfig;
  video: VideoBackgroundConfig;
  spectrum: SpectrumConfig;
  effects: EffectConfig[];
  export: ExportConfig;
  /** 编辑器预览时的跟随设置 */
  followPlayhead: boolean;
  followMainLine: boolean;
}

/* ------------------------------------------------------------------ */
/* 项目                                                                 */
/* ------------------------------------------------------------------ */

export interface TimelineConfig {
  bpm: number;
  /**
   * **新增小节时**的每小节节拍数。
   * 注意：它只是一条「新建时的默认值」，不约束已有小节 ——
   * 每个小节的拍数在 `Bar.beatCount` 里各自保存，改动此处不会影响现有小节。
   */
  beatsPerNewBar: number;
  /** 音频偏移（ms）：正值表示音频整体延后，播放头时间 = 音频时间 - offset */
  audioOffsetMs: number;
  /** 默认吸附分母 */
  defaultSnap: number;
  /** 自定义吸附分母（当默认值不够用时使用），例如 16 表示 1/16 拍 */
  customSnap: number;
}

export interface ProjectMeta {
  name: string;
  artist: string;
  createdAt: number;
  updatedAt: number;
  appVersion: string;
}

export interface Project {
  formatVersion: number;
  meta: ProjectMeta;
  timeline: TimelineConfig;
  canvas: { width: number; height: number; background: string; gradient?: Gradient };
  assets: AssetIndex;
  /** 音频资源 */
  audioAssetId: string | null;
  /** 波形缓存（相对项目目录的文件名） */
  peaksFile: string | null;
  /** 逐拍歌词 */
  bars: Bar[];
  /** 逐行歌词块 */
  lines: LyricLine[];
  playback: PlaybackConfig;
}

export const FORMAT_VERSION = 1;
export const APP_VERSION = '0.1.0';

/* ------------------------------------------------------------------ */
/* 事件元信息                                                           */
/* ------------------------------------------------------------------ */

export interface EventTypeMeta {
  type: BeatEventType;
  label: string;
  /** 是否是「点事件」（不占据区间） */
  span: boolean;
  color: string;
  hint: string;
}

export const EVENT_META: Record<BeatEventType, EventTypeMeta> = {
  char: { type: 'char', label: '歌词字', span: false, color: '#4ea1ff', hint: '一个发音单元，图标下方显示文本' },
  bpm: { type: 'bpm', label: '设置 BPM', span: false, color: '#ff9f43', hint: '从此处起播放头使用新的 BPM' },
  pause: { type: 'pause', label: '暂停', span: false, color: '#ffd93d', hint: '播放头原地停留指定毫秒' },
  force: { type: 'force', label: '强制行进', span: true, color: '#a06bff', hint: '用指定毫秒匀速走完覆盖的节拍' },
  lrcPrev: { type: 'lrcPrev', label: '逐行上一句', span: false, color: '#36d399', hint: '主歌词回退若干块' },
  lrcNext: { type: 'lrcNext', label: '逐行下一句', span: false, color: '#36d399', hint: '主歌词前进若干块' },
  lrcTempStart: { type: 'lrcTempStart', label: '临时行开始', span: false, color: '#f87272', hint: '把某块加入临时行列表' },
  lrcTempEnd: { type: 'lrcTempEnd', label: '临时行结束', span: false, color: '#f87272', hint: '把某块移出临时行列表' },
};

export const ALL_EVENT_TYPES: BeatEventType[] = [
  'char',
  'bpm',
  'pause',
  'force',
  'lrcPrev',
  'lrcNext',
  'lrcTempStart',
  'lrcTempEnd',
];

export const SNAP_DIVISIONS = [1, 2, 3, 4, 6, 8] as const;
