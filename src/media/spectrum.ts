/**
 * 频谱计算：实时（AnalyserNode）与离线（自实现 radix-2 FFT）。
 *
 * 设计意图：
 * - 导出视频必须逐帧「确定性」渲染，而 AnalyserNode 只能取“当前”频谱，无法对任意时刻求值，
 *   所以 OfflineSpectrum 在构造时对整段音频做一次 STFT，把每帧的频带能量缓存起来，
 *   渲染时只做线性插值，代价是 O(1)；
 * - 实时预览与离线渲染共用 mapSpectrumToBands，保证两条路径的频谱形状一致。
 */

/** 一列频谱数据 */
export interface SpectrumFrame {
  /** 每一列的幅度，0..1，长度 = columns */
  values: Float32Array;
}

/** 频谱计算的公共参数 */
export interface OfflineSpectrumOptions {
  /** 频率下限/上限（Hz） */
  minFreq: number;
  maxFreq: number;
  /** 列数 */
  columns: number;
  /** 采样窗口长度，默认 1024 */
  fftSize?: number;
  /** 幅度增益，默认 1 */
  gain?: number;
}

/** FFT 允许的最小尺寸（AnalyserNode 同样要求 2 的幂且不小于 32） */
const MIN_FFT_SIZE = 32;
/** FFT 允许的最大尺寸 */
const MAX_FFT_SIZE = 32768;
/** 离线 STFT 默认窗口长度 */
const DEFAULT_OFFLINE_FFT_SIZE = 1024;
/** 实时分析默认窗口长度 */
const REALTIME_FFT_SIZE = 2048;
/** AnalyserNode 输出的 dB 下限（低于此值视为静音） */
const DB_FLOOR = 100;
/** 感知缩放指数：< 1 会抬高高频段的可见度，接近人耳对小信号的敏感度 */
const PERCEPTUAL_EXPONENT = 0.6;

/** 复用的空样本数组（buffer 无声道或长度为 0 时使用） */
const EMPTY_SAMPLES = new Float32Array(0);

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampNumber(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** 把任意输入规整为 2 的幂，并夹取到 [MIN_FFT_SIZE, MAX_FFT_SIZE]（向下取整到 2 的幂） */
function normalizeFftSize(value: number | undefined, fallback: number): number {
  const raw = Math.floor(value ?? fallback);
  const base = Number.isFinite(raw) && raw >= MIN_FFT_SIZE ? Math.min(raw, MAX_FFT_SIZE) : fallback;
  let size = MIN_FFT_SIZE;
  while (size * 2 <= base) size *= 2;
  return size;
}

/** 校验 radix-2 FFT 的长度约束 */
function ensurePowerOfTwo(length: number, where: string): void {
  if (!Number.isInteger(length) || length <= 0 || (length & (length - 1)) !== 0) {
    throw new Error(`${where} 的窗口长度必须是 2 的幂，当前为 ${length}`);
  }
}

/** 位反转（用于 FFT 的输入置换） */
function reverseBits(value: number, bits: number): number {
  let out = 0;
  let v = value;
  for (let i = 0; i < bits; i++) {
    out = (out << 1) | (v & 1);
    v >>= 1;
  }
  return out;
}

/**
 * 单一尺寸的 FFT 工作区：旋转因子表、Hann 窗、位反转表、re/im 缓冲区全部复用，
 * 这样对整段音频做 STFT 时不会每帧产生垃圾。
 */
class Radix2Fft {
  readonly size: number;
  private readonly half: number;
  private readonly cosTable: Float64Array;
  private readonly sinTable: Float64Array;
  private readonly window: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly rev: Uint32Array;

  constructor(size: number) {
    this.size = size;
    this.half = size >> 1;
    this.cosTable = new Float64Array(this.half);
    this.sinTable = new Float64Array(this.half);
    for (let k = 0; k < this.half; k++) {
      const angle = (2 * Math.PI * k) / size;
      this.cosTable[k] = Math.cos(angle);
      this.sinTable[k] = Math.sin(angle);
    }
    // 周期 Hann 窗：hop = size/2 时满足 COLA，相邻帧交叉叠加后幅度是平坦的
    this.window = new Float64Array(size);
    for (let i = 0; i < size; i++) this.window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    this.re = new Float64Array(size);
    this.im = new Float64Array(size);
    this.rev = new Uint32Array(size);
    const bits = Math.round(Math.log2(size));
    for (let i = 0; i < size; i++) this.rev[i] = reverseBits(i, bits);
  }

  /**
   * 计算 samples[offset .. offset+size) 的幅度谱（越界样本按 0 补齐，便于处理尾部不足一帧的情况）。
   * @param out 输出缓冲区，长度必须 >= size/2
   */
  magnitudes(samples: Float32Array, offset: number, out: Float32Array): void {
    const n = this.size;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < n; i++) {
      const s = offset + i;
      re[i] = s >= 0 && s < samples.length ? samples[s] * this.window[i] : 0;
      im[i] = 0;
    }
    // 位反转置换（只做 i < j 的交换，避免换回原位）
    for (let i = 0; i < n; i++) {
      const j = this.rev[i];
      if (j > i) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    // 迭代蝶形
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const step = n / len;
      for (let base = 0; base < n; base += len) {
        for (let j = 0; j < half; j++) {
          const tw = j * step;
          const wr = this.cosTable[tw];
          const wi = -this.sinTable[tw];
          const a = base + j;
          const b = a + half;
          const br = re[b];
          const bi = im[b];
          const tr = br * wr - bi * wi;
          const ti = br * wi + bi * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    // 1/N 归一化：幅度只与信号振幅有关，与窗口长度无关
    const norm = 1 / n;
    for (let k = 0; k < this.half; k++) out[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * norm;
  }
}

/** 按尺寸缓存 FFT 工作区；只服务少数几种尺寸，超过上限就整体丢弃，防止内存无限增长 */
const fftCache = new Map<number, Radix2Fft>();

function getFft(size: number): Radix2Fft {
  const cached = fftCache.get(size);
  if (cached) return cached;
  const fft = new Radix2Fft(size);
  if (fftCache.size >= 4) fftCache.clear();
  fftCache.set(size, fft);
  return fft;
}

/**
 * 纯函数：就地计算实数 FFT（radix-2，要求 length 是 2 的幂），输入时域，输出幅度谱长度 = length/2。
 *
 * 内部使用 Hann 窗抑制频谱泄漏，输出为 sqrt(re²+im²) 并做 1/N 归一化
 * （因此一路振幅 A 的正弦波在对应 bin 上的幅度约为 A/4）。
 * @param samples 时域样本，至少需要 length 个
 * @param length 窗口长度，必须是 2 的幂
 * @param out 可选输出缓冲区（长度 >= length/2），用于复用内存
 * @returns 长度 = length/2 的幅度谱
 * @throws length 不合法或 samples 长度不足时抛出可读错误
 */
export function fftMagnitudes(samples: Float32Array, length: number, out?: Float32Array): Float32Array {
  ensurePowerOfTwo(length, 'fftMagnitudes');
  if (samples.length < length) {
    throw new Error(`fftMagnitudes 需要至少 ${length} 个样本，实际只有 ${samples.length}`);
  }
  const half = length >> 1;
  const dst = out && out.length >= half ? out : new Float32Array(half);
  getFft(length).magnitudes(samples, 0, dst);
  return dst.length === half ? dst : dst.subarray(0, half);
}

/**
 * 纯函数：把 FFT 幅度谱（长度 = fftSize/2）映射为 columns 个对数频带，0..1。
 *
 * 第 k 列代表频率 freq_k = minFreq * (maxFreq/minFreq)^(k/(columns-1))；每一列的覆盖范围取相邻
 * 代表频率的几何中点，保证各列对应的频率区间互不重叠；每列取覆盖 bin 的最大值，
 * 再做 pow(v, 0.6) 的感知压缩并夹取到 0..1。
 * @param magnitudes 幅度谱（bin 间线性间隔，索引 0 为 DC）
 * @param sampleRate 采样率（Hz）
 * @param fftSize 产生该幅度谱的窗口长度
 * @param minFreq 频率下限（Hz）
 * @param maxFreq 频率上限（Hz）
 * @param columns 频带列数
 * @param out 可选输出缓冲区（长度 >= columns），用于复用内存
 * @returns 长度 = columns 的频带幅度数组；columns <= 0 时返回空数组
 */
export function mapSpectrumToBands(
  magnitudes: Float32Array,
  sampleRate: number,
  fftSize: number,
  minFreq: number,
  maxFreq: number,
  columns: number,
  out?: Float32Array,
): Float32Array {
  const cols = Math.floor(columns);
  if (!Number.isFinite(cols) || cols <= 0) return new Float32Array(0);
  const dst = out && out.length >= cols ? out : new Float32Array(cols);
  const binCount = magnitudes.length;
  const binHz = fftSize > 0 && sampleRate > 0 ? sampleRate / fftSize : 0;
  const nyquist = sampleRate > 0 ? sampleRate / 2 : 0;
  if (binCount <= 0 || binHz <= 0 || nyquist <= 0) {
    dst.fill(0, 0, cols);
    return dst.length === cols ? dst : dst.subarray(0, cols);
  }
  // 下限至少 1Hz（log 不能取 0），上限不超过 Nyquist
  const loFreq = clampNumber(minFreq, Math.min(1, nyquist), nyquist);
  const hiFreq = clampNumber(maxFreq, loFreq, nyquist);
  const ratio = hiFreq / loFreq;
  const freqAt = (k: number): number =>
    cols === 1 || ratio === 1 ? loFreq : loFreq * Math.pow(ratio, k / (cols - 1));

  for (let k = 0; k < cols; k++) {
    const center = freqAt(k);
    const bandLo = k === 0 ? loFreq : Math.sqrt(freqAt(k - 1) * center);
    const bandHi = k === cols - 1 ? hiFreq : Math.sqrt(center * freqAt(k + 1));
    // 以「bin 中心频率落在哪个频带」为归属规则，避免相邻频带重复计入同一个 bin；
    // 第 0 列从 DC 开始（低频段 bin 数少于列数时，窄频带会退化为共用同一个 bin）。
    const rawLo = k === 0 ? 0 : Math.ceil(bandLo / binHz);
    const rawHi = Math.ceil(bandHi / binHz) - 1;
    const loBin = Math.min(binCount - 1, Math.max(0, rawLo));
    const hiBin = Math.min(binCount - 1, Math.max(loBin, rawHi));
    let peak = 0;
    for (let b = loBin; b <= hiBin; b++) {
      const m = magnitudes[b];
      if (m > peak) peak = m; // NaN 不满足 > 比较，天然被忽略
    }
    dst[k] = clamp01(Math.pow(peak, PERCEPTUAL_EXPONENT));
  }
  return dst.length === cols ? dst : dst.subarray(0, cols);
}

/**
 * 离线频谱：可在任意时刻 t(秒) 求值，供逐帧导出的确定性渲染使用。
 * 内部对音频做一次 STFT，把每一帧的频带能量缓存下来，timeAt 时做线性插值。
 */
export class OfflineSpectrum {
  private readonly columns: number;
  private readonly frameCountValue: number;
  private readonly frameStepSec: number;
  private readonly minFreq: number;
  private readonly maxFreq: number;
  private readonly gain: number;
  /** 所有帧的频带能量，按行主序存放（frame * columns + column） */
  private readonly frames: Float32Array;
  /** 未传 out 时复用的返回缓冲区 */
  private readonly scratch: Float32Array;

  /**
   * @param buffer 已解码的音频（只分析第一声道）
   * @param opts 频率范围、列数、窗口长度与增益
   */
  constructor(buffer: AudioBuffer, opts: OfflineSpectrumOptions) {
    const columns = Math.max(1, Math.floor(opts.columns) || 1);
    const fftSize = normalizeFftSize(opts.fftSize, DEFAULT_OFFLINE_FFT_SIZE);
    const sampleRate = buffer.sampleRate > 0 ? buffer.sampleRate : 44100;
    const nyquist = sampleRate / 2;
    const gainRaw = opts.gain ?? 1;

    this.columns = columns;
    this.minFreq = clampNumber(opts.minFreq, 1, nyquist);
    this.maxFreq = clampNumber(opts.maxFreq, this.minFreq, nyquist);
    this.gain = Number.isFinite(gainRaw) ? gainRaw : 1;

    const hop = fftSize >> 1;
    const length = Math.max(0, Math.floor(buffer.length));
    // 至少保留一帧：极短音频（短于一个窗口）也要能求值
    const frameCount = length <= 0 ? 1 : Math.max(1, Math.floor((length - fftSize) / hop) + 1);
    this.frameCountValue = frameCount;
    this.frameStepSec = hop / sampleRate;
    this.frames = new Float32Array(frameCount * columns);
    this.scratch = new Float32Array(columns);

    // ---- 一次性 STFT：把整段音频的频带能量算完，之后 timeAt 只是插值 ----
    const fft = getFft(fftSize);
    const mags = new Float32Array(fftSize >> 1);
    const bands = new Float32Array(columns);
    const hasSamples = length > 0 && buffer.numberOfChannels > 0;
    const samples = hasSamples ? buffer.getChannelData(0) : EMPTY_SAMPLES;
    const gain = this.gain;
    for (let f = 0; f < frameCount; f++) {
      fft.magnitudes(samples, f * hop, mags);
      mapSpectrumToBands(mags, sampleRate, fftSize, this.minFreq, this.maxFreq, columns, bands);
      const base = f * columns;
      for (let c = 0; c < columns; c++) this.frames[base + c] = clamp01(bands[c] * gain);
    }
  }

  /** 总列数（已缓存的时间帧数量） */
  get frameCount(): number {
    return this.frameCountValue;
  }

  /** 相邻帧的时间间隔（秒） */
  get frameStep(): number {
    return this.frameStepSec;
  }

  /**
   * 在 t 秒处求频谱列（对相邻帧做线性插值），越界时夹取到首帧/末帧。
   * @param t 时间（秒）
   * @param out 可选的输出缓冲区（长度需 >= columns），用于避免每帧分配
   * @returns 长度 = columns 的幅度数组（0..1）；out 长度不足时返回内部复用缓冲区
   */
  timeAt(t: number, out?: Float32Array): Float32Array {
    const columns = this.columns;
    const dst = out && out.length >= columns ? out : this.scratch;
    const last = this.frameCountValue - 1;
    const step = this.frameStepSec;
    let pos = step > 0 ? t / step : 0;
    if (!Number.isFinite(pos)) pos = 0;
    if (pos < 0) pos = 0;
    if (pos > last) pos = last;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, last);
    const frac = pos - i0;
    const baseA = i0 * columns;
    const baseB = i1 * columns;
    for (let c = 0; c < columns; c++) {
      const a = this.frames[baseA + c];
      dst[c] = a + (this.frames[baseB + c] - a) * frac;
    }
    return dst;
  }
}

/**
 * 实时播放用的频谱分析器：包装 AnalyserNode，输出与离线一致的频带列。
 */
export class RealtimeSpectrum {
  /** 接入播放链路；返回要连接到 destination 的节点 */
  readonly input: AudioNode;

  private readonly analyser: AnalyserNode;
  private readonly columns: number;
  private readonly fftSize: number;
  private readonly sampleRate: number;
  private readonly minFreq: number;
  private readonly maxFreq: number;
  private readonly gain: number;
  /** getFloatFrequencyData 的落点（长度 = frequencyBinCount）；lib.dom 要求 ArrayBuffer 后端 */
  private readonly db: Float32Array<ArrayBuffer>;
  /** dB 归一化后的「幅度」缓冲，喂给 mapSpectrumToBands */
  private readonly linear: Float32Array;
  /** 未传 out 时复用的返回缓冲区 */
  private readonly scratch: Float32Array;
  private disposed = false;

  /**
   * @param ctx 播放所在的 context（必须与播放链路同一个，否则时钟不一致）
   * @param opts 频率范围、列数、窗口长度与增益
   */
  constructor(ctx: BaseAudioContext, opts: OfflineSpectrumOptions) {
    const columns = Math.max(1, Math.floor(opts.columns) || 1);
    const fftSize = normalizeFftSize(opts.fftSize, REALTIME_FFT_SIZE);
    const sampleRate = ctx.sampleRate > 0 ? ctx.sampleRate : 44100;
    const nyquist = sampleRate / 2;
    const gainRaw = opts.gain ?? 1;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = fftSize;
    // 默认的 0.8 平滑可以抑制逐帧跳变，视觉上更接近离线结果的稳定感
    analyser.smoothingTimeConstant = 0.8;

    this.analyser = analyser;
    this.input = analyser;
    this.columns = columns;
    this.fftSize = fftSize;
    this.sampleRate = sampleRate;
    this.minFreq = clampNumber(opts.minFreq, 1, nyquist);
    this.maxFreq = clampNumber(opts.maxFreq, this.minFreq, nyquist);
    this.gain = Number.isFinite(gainRaw) ? gainRaw : 1;
    this.db = new Float32Array(analyser.frequencyBinCount);
    this.linear = new Float32Array(analyser.frequencyBinCount);
    this.scratch = new Float32Array(columns);
  }

  /**
   * 取当前时刻的频谱列。
   * @param out 可选的输出缓冲区（长度需 >= columns）
   * @returns 长度 = columns 的幅度数组（0..1）；已 dispose 或 out 长度不足时返回内部缓冲区
   */
  sample(out?: Float32Array): Float32Array {
    const dst = out && out.length >= this.columns ? out : this.scratch;
    if (this.disposed) {
      dst.fill(0, 0, this.columns);
      return dst;
    }
    this.analyser.getFloatFrequencyData(this.db);
    const db = this.db;
    const linear = this.linear;
    for (let i = 0; i < linear.length; i++) {
      // AnalyserNode 给出 dB（约 -100..0），线性映射到 0..1 作为频带映射的输入幅度
      linear[i] = clamp01((db[i] + DB_FLOOR) / DB_FLOOR);
    }
    mapSpectrumToBands(linear, this.sampleRate, this.fftSize, this.minFreq, this.maxFreq, this.columns, dst);
    if (this.gain !== 1) {
      for (let i = 0; i < this.columns; i++) dst[i] = clamp01(dst[i] * this.gain);
    }
    return dst;
  }

  /** 释放资源：断开分析节点，之后再调用 sample 返回全 0 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.input.disconnect();
  }
}
