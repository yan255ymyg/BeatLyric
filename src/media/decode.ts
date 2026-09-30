/**
 * 音频解码与波形峰值计算。
 *
 * 设计意图：
 * - 解码只依赖 Web Audio 的 BaseAudioContext，因此测试或离线渲染可以注入 OfflineAudioContext；
 * - 播放需要一个长期存活的 AudioContext（时钟、节点都挂在它上面），所以这里把默认 context 缓存在
 *   模块级复用，并且永不 close()；
 * - 峰值缓存用于时间轴波形显示，用 8bit 量化 + base64 落盘，体积约为原始 Float32 的四分之一。
 */

/** AudioContext 构造器类型（需要兼容 webkit 前缀的实现） */
type AudioContextCtor = new (options?: AudioContextOptions) => AudioContext;

/** 模块级复用的播放 context：整个会话只创建一个，避免多个时钟互相漂移 */
let sharedAudioContext: AudioContext | null = null;

/** 取出错误对象里可读的文本（不同环境抛出的东西不一定是 Error） */
function errorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  return '未知错误';
}

/**
 * 获取模块级复用的 AudioContext（首次调用时创建，之后一直复用，不会被关闭）。
 * @returns 承载播放链路的 AudioContext
 * @throws 运行环境不支持 Web Audio API 时抛出可读错误
 */
export function getSharedAudioContext(): AudioContext {
  if (sharedAudioContext) return sharedAudioContext;
  const scope = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  const Ctor = scope.AudioContext ?? scope.webkitAudioContext;
  if (!Ctor) throw new Error('当前环境不支持 Web Audio API：找不到 AudioContext');
  sharedAudioContext = new Ctor();
  return sharedAudioContext;
}

/**
 * 解码音频文件为 AudioBuffer；失败时抛出可读错误。
 * @param data 音频文件的原始字节
 * @param ctx 可选的解码 context；不传则使用模块级共享 AudioContext
 * @returns 解码得到的 AudioBuffer
 * @throws 解码失败（格式不支持 / 数据损坏）时抛出带原因的 Error
 */
export async function decodeAudioFile(data: ArrayBuffer, ctx?: BaseAudioContext): Promise<AudioBuffer> {
  const audioCtx = ctx ?? getSharedAudioContext();
  // decodeAudioData 会「接管」传入的 ArrayBuffer（部分实现直接 detach），
  // 而调用方通常还要把同一份数据写盘或重试，所以先复制一份再交给解码器。
  const copy = data.slice(0);
  try {
    return await audioCtx.decodeAudioData(copy);
  } catch (err) {
    throw new Error(`音频解码失败：${errorMessage(err)}`);
  }
}

/**
 * 从 AudioBuffer 计算波形峰值（用于时间轴上的波形显示）。
 *
 * 把各声道按样本求平均混合成单声道，再等分成 bins 段，每段取绝对值最大值。
 * 归一化采用「钳制到 [0,1]」而不是「按最大值缩放」：波形需要保留不同段落之间的真实响度对比。
 * @param buffer 待分析的音频
 * @param bins 分箱数量（波形的水平采样点数）
 * @returns 长度 <= bins 的峰值数组，元素落在 0..1；bins <= 0 时返回空数组
 */
export function computePeaks(buffer: AudioBuffer, bins: number): Float32Array {
  const count = Number.isFinite(bins) ? Math.floor(bins) : 0;
  if (count <= 0) return new Float32Array(0);
  const out = new Float32Array(count);
  const total = Math.max(0, Math.floor(buffer.length));
  const channels = Math.floor(buffer.numberOfChannels);
  if (total <= 0 || channels <= 0) return out;

  const channelData: Float32Array[] = [];
  for (let c = 0; c < channels; c++) channelData.push(buffer.getChannelData(c));

  const inv = 1 / channels;
  for (let i = 0; i < count; i++) {
    // 用乘法代替累加步长，避免浮点误差在长音频上累积导致最后一段错位
    const start = Math.floor((i * total) / count);
    const end = Math.floor(((i + 1) * total) / count);
    let peak = 0;
    for (let s = start; s < end; s++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += channelData[c][s];
      const v = Math.abs(sum * inv);
      if (v > peak) peak = v;
    }
    out[i] = peak > 1 ? 1 : peak;
  }
  return out;
}

const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** base64 字符 -> 6bit 值；-1 表示非法字符。运行时自建，不依赖 btoa/atob */
const BASE64_LOOKUP: Int16Array = (() => {
  const table = new Int16Array(128).fill(-1);
  for (let i = 0; i < BASE64_CHARS.length; i++) table[BASE64_CHARS.charCodeAt(i)] = i;
  return table;
})();

/** 字节数组 -> base64 字符串（自带实现，浏览器与 node 行为完全一致） */
function bytesToBase64(bytes: Uint8Array): string {
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < bytes.length;
    const hasB2 = i + 2 < bytes.length;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    text += BASE64_CHARS[b0 >> 2];
    text += BASE64_CHARS[((b0 & 0x03) << 4) | (b1 >> 4)];
    text += hasB1 ? BASE64_CHARS[((b1 & 0x0f) << 2) | (b2 >> 6)] : '=';
    text += hasB2 ? BASE64_CHARS[b2 & 0x3f] : '=';
  }
  return text;
}

/**
 * base64 字符串 -> 字节数组；容忍换行与空格，遇到非法字符抛出可读错误。
 * @throws 缓存内容不是合法 base64 时抛出 Error
 */
function base64ToBytes(text: string): Uint8Array {
  const body = text.replace(/\s+/g, '').replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((body.length * 6) / 8));
  let acc = 0;
  let bits = 0;
  let written = 0;
  for (let i = 0; i < body.length; i++) {
    const code = body.charCodeAt(i);
    const value = code < 128 ? BASE64_LOOKUP[code] : -1;
    if (value < 0) throw new Error(`峰值缓存损坏：第 ${i} 个字符不是合法 base64 字符`);
    acc = (acc << 6) | value;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[written++] = (acc >> bits) & 0xff;
    }
  }
  return written === out.length ? out : out.subarray(0, written);
}

/**
 * 把 Float32Array 峰值序列编码为紧凑的 base64 字符串（写入项目目录的 peaks 缓存文件用）。
 *
 * 每个峰值量化为 1 字节（0..255），往返误差 <= 1/510 ≈ 0.002，肉眼不可见但体积只有原来的 1/4。
 * @param peaks computePeaks 的结果（元素应在 0..1）
 * @returns 纯 base64 文本（无换行，长度隐含在内容里）
 */
export function encodePeaks(peaks: Float32Array): string {
  const bytes = new Uint8Array(peaks.length);
  for (let i = 0; i < peaks.length; i++) {
    const v = peaks[i];
    const q = Number.isFinite(v) ? v : 0;
    bytes[i] = Math.round((q < 0 ? 0 : q > 1 ? 1 : q) * 255);
  }
  return bytesToBase64(bytes);
}

/**
 * 解码 base64 峰值字符串（encodePeaks 的逆操作）。
 * @param text base64 文本，允许包含空白
 * @returns 长度 = 字节数的峰值数组，元素落在 0..1；空串返回空数组
 * @throws 文本不是合法 base64 时抛出可读错误
 */
export function decodePeaks(text: string): Float32Array {
  const bytes = base64ToBytes(text);
  const out = new Float32Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) out[i] = bytes[i] / 255;
  return out;
}
