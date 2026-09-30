/**
 * 音频 PCM 提取与时间轴对齐（离线编码用）
 *
 * 背景
 *  - 播放头时间（项目时间轴）与音频元素时间相差一个 offsetMs：
 *        **音频时间 = 播放头时间 + offsetMs / 1000**
 *    这是全项目统一的约定，代码里已经这样实现（可自行核对）：
 *      · src/playback/engine.ts:195  `const audioTime = positionSec + this.offsetMs / 1000;`
 *      · src/playback/duration.ts:13 `audioEnd = audioDuration - audioOffsetMs / 1000`
 *      · src/ui/components/Header.tsx:62 同上
 *    （两处注释把它口语化描述成「正值 = 音频整体延后 / 前奏留白」，与公式本身相反；
 *      以**公式与实现**为准，本文档和代码都跟随实现。）
 *  - 歌词时间轴可能比音频长（暂停与强制行进会把时间轴整体拉长），
 *    因此导出需要一段「与 durationSec 等长、并在 offsetMs 处对齐」的音频：越界部分补静音。
 */

/**
 * 把 AudioBuffer 按「项目时间轴」裁切/补静音，输出一段新的 AudioBuffer。
 *
 * 采样映射（与播放引擎一致）：`out(t) = source(t + offsetMs/1000)`，`t` 为项目时间轴秒数。
 *  - `offsetMs > 0`：输出第 0 秒对应音频的 `+offsetMs/1000` 处 → 音频被提前，开头被裁掉；
 *  - `offsetMs < 0`：输出第 0 秒对应音频的负时间 → 开头补静音，音频整体延后；
 *  - 超出音频范围的部分（开头或结尾）用静音填充。
 *
 * 若日后决定改用「正值 = 前奏留白」的相反约定（即 `out(t) = source(t - offsetMs/1000)`），
 * 只需把下面 `shift` 的符号取反，并且同步修改 src/playback/engine.ts 的 audioTime 公式。
 *
 * 输出的声道数与采样率跟随传入的 buffer；源声道少于输出声道时复用最后一个源声道。
 */
export function sliceAudioBuffer(
  ctx: BaseAudioContext,
  buffer: AudioBuffer,
  opts: { offsetMs: number; durationSec: number },
): AudioBuffer {
  const sampleRate = buffer.sampleRate > 0 ? buffer.sampleRate : 48000;
  const channels = Math.max(1, Math.min(32, buffer.numberOfChannels || 1));

  // durationSec 可能为 0 或负数（时间轴异常）：退化为 1 个采样点的静音，避免 createBuffer 抛错。
  const requestedLength = Math.round((Number.isFinite(opts.durationSec) ? opts.durationSec : 0) * sampleRate);
  const length = Math.max(1, requestedLength);

  const out = ctx.createBuffer(channels, length, sampleRate);

  const offsetSec = Number.isFinite(opts.offsetMs) ? opts.offsetMs / 1000 : 0;
  /** out[i] = source[i + shift] */
  const shift = Math.round(offsetSec * sampleRate);

  for (let ch = 0; ch < channels; ch++) {
    // 源声道少于输出声道时复用最后一个源声道（例如 mono 源 -> stereo 输出）
    const sourceChannel = Math.min(ch, buffer.numberOfChannels - 1);
    const source = buffer.getChannelData(sourceChannel);
    const destination = out.getChannelData(ch);

    // 二者重叠区间：i ∈ [-shift, source.length - shift) ∩ [0, length)
    const start = Math.max(0, -shift);
    const end = Math.min(length, source.length - shift);
    for (let i = start; i < end; i++) {
      destination[i] = source[i + shift];
    }
    // 其余位置保持 0（静音）
  }

  return out;
}
