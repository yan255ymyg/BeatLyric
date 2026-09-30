import { describe, expect, it } from 'vitest';
import { computePeaks, decodePeaks, encodePeaks } from './decode';
import { OfflineSpectrum, fftMagnitudes, mapSpectrumToBands } from './spectrum';

/**
 * 测试环境是 node（没有 Web Audio / DOM），所以这里只覆盖纯数学部分：
 * FFT、频带映射、离线求值（用桩 AudioBuffer）、峰值分箱与峰值序列编解码。
 * 凡是需要 AudioContext 的代码（decodeAudioFile / RealtimeSpectrum）不在这里测试。
 */

/** 构造 AudioBuffer 的最小桩：只提供这些函数真正用到的成员 */
function stubBuffer(sampleRate: number, channels: Float32Array[]): AudioBuffer {
  const length = channels.length > 0 ? channels[0].length : 0;
  return {
    numberOfChannels: channels.length,
    length,
    sampleRate,
    duration: sampleRate > 0 ? length / sampleRate : 0,
    getChannelData: (channel: number): Float32Array => channels[channel],
  } as unknown as AudioBuffer;
}

/** 生成整数 bin 对齐的正弦波（便于 FFT 期望值精确计算） */
function sineOfBin(length: number, bin: number, amplitude = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * bin * i) / length);
  return out;
}

/** 生成按采样率定义的正弦波 */
function sine(length: number, freq: number, sampleRate: number, amplitude = 1): Float32Array {
  const out = new Float32Array(length);
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return out;
}

/** 线性调频信号：瞬时频率从 f0 线性升到 f1（相位取频率积分，保证瞬时频率正确） */
function chirp(length: number, f0: number, f1: number, sampleRate: number): Float32Array {
  const out = new Float32Array(length);
  const duration = length / sampleRate;
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    const phase = 2 * Math.PI * (f0 * t + ((f1 - f0) * t * t) / (2 * duration));
    out[i] = Math.sin(phase);
  }
  return out;
}

/** bin 索引越大幅度越大的线性谱，用于验证频带映射的单调性 */
function linearRamp(binCount: number): Float32Array {
  const out = new Float32Array(binCount);
  for (let k = 0; k < binCount; k++) out[k] = (k + 1) / binCount;
  return out;
}

function maxOf(values: Float32Array): number {
  let peak = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < values.length; i++) if (values[i] > peak) peak = values[i];
  return peak;
}

function argmaxOf(values: Float32Array): number {
  let best = 0;
  for (let i = 1; i < values.length; i++) if (values[i] > values[best]) best = i;
  return best;
}

function rounded(values: Float32Array, digits: number): number[] {
  return Array.from(values).map((v) => Number(v.toFixed(digits)));
}

describe('fftMagnitudes', () => {
  it('正弦波能量落在对应 bin 上（峰值位置与幅度都可预测）', () => {
    const n = 64;
    const k0 = 8;
    const mags = fftMagnitudes(sineOfBin(n, k0), n);
    expect(mags.length).toBe(n / 2);
    expect(argmaxOf(mags)).toBe(k0);
    // 1/N 归一化 + Hann 窗相干增益 0.5：振幅 1 的正弦约为 A/2 * 0.5 = 0.25
    expect(mags[k0]).toBeCloseTo(0.25, 2);
    expect(mags[k0]).toBeGreaterThan(mags[k0 - 1]);
    expect(mags[k0]).toBeGreaterThan(mags[k0 + 1]);
    // 幅度线性：振幅减半则谱幅度减半
    expect(fftMagnitudes(sineOfBin(n, k0, 0.5), n)[k0]).toBeCloseTo(0.125, 2);
  });

  it('常量信号的能量集中在 DC 附近（周期 Hann 窗仅泄漏到 bin 0/1）', () => {
    const n = 64;
    const mags = fftMagnitudes(new Float32Array(n).fill(1), n);
    expect(mags[0]).toBeCloseTo(0.5, 6); // 窗函数均值
    expect(mags[0]).toBeGreaterThan(mags[1]);
    expect(mags[1]).toBeCloseTo(0.25, 6);
    for (let k = 2; k < mags.length; k++) expect(mags[k]).toBeCloseTo(0, 6);
  });

  it('拒绝非 2 的幂窗口与样本不足的输入', () => {
    expect(() => fftMagnitudes(new Float32Array(10), 10)).toThrow(/2 的幂/);
    expect(() => fftMagnitudes(new Float32Array(4), 8)).toThrow(/至少/);
  });

  it('复用传入的输出缓冲区', () => {
    const out = new Float32Array(32);
    expect(fftMagnitudes(sineOfBin(64, 8), 64, out)).toBe(out);
  });
});

describe('mapSpectrumToBands', () => {
  const binCount = 512;
  const sampleRate = 44100;
  const fftSize = 1024;
  const magnitudes = linearRamp(binCount);

  it('输出长度 = columns，非法列数返回空数组', () => {
    expect(mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, 64).length).toBe(64);
    expect(mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, 1).length).toBe(1);
    expect(mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, 0).length).toBe(0);
    expect(mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, -8).length).toBe(0);
  });

  it('单调递增的谱在各频带上非递减，且整体在 0..1', () => {
    const bands = mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, 64);
    for (let k = 1; k < bands.length; k++) expect(bands[k]).toBeGreaterThanOrEqual(bands[k - 1]);
    expect(bands[63]).toBeGreaterThan(bands[0]);
    for (let k = 0; k < bands.length; k++) {
      expect(bands[k]).toBeGreaterThanOrEqual(0);
      expect(bands[k]).toBeLessThanOrEqual(1);
    }
  });

  it('单一频率尖峰只点亮高频区的一个频带', () => {
    const spike = new Float32Array(binCount);
    spike[300] = 1; // 300 * (44100/1024) ≈ 12.9kHz
    const bands = mapSpectrumToBands(spike, sampleRate, fftSize, 40, 16000, 64);
    const lit: number[] = [];
    for (let k = 0; k < bands.length; k++) if (bands[k] > 0) lit.push(k);
    expect(lit.length).toBeGreaterThanOrEqual(1);
    expect(lit.length).toBeLessThanOrEqual(2); // 频带边界可能让相邻一列共享同一个 bin
    for (const k of lit) expect(k).toBeGreaterThan(bands.length / 2);
    expect(maxOf(bands)).toBeCloseTo(1, 5);
  });

  it('复用传入的输出缓冲区', () => {
    const out = new Float32Array(64);
    expect(mapSpectrumToBands(magnitudes, sampleRate, fftSize, 40, 16000, 64, out)).toBe(out);
  });
});

describe('computePeaks', () => {
  it('按 bins 等分并取每段绝对值最大值', () => {
    const data = new Float32Array(8000);
    data.fill(0.2, 0, 4000);
    data.fill(0.8, 4000, 8000);
    const peaks = computePeaks(stubBuffer(44100, [data]), 4);
    expect(peaks.length).toBe(4);
    expect(rounded(peaks, 3)).toEqual([0.2, 0.2, 0.8, 0.8]);
  });

  it('取绝对值并夹取到 1', () => {
    const data = new Float32Array([-0.5, -0.5, 1.5, 1.5]);
    const peaks = computePeaks(stubBuffer(44100, [data]), 2);
    expect(peaks[0]).toBeCloseTo(0.5, 6);
    expect(peaks[1]).toBeCloseTo(1, 6);
  });

  it('多声道求平均混合成单声道', () => {
    const left = new Float32Array(64).fill(0.4);
    const right = new Float32Array(64).fill(0.8);
    const peaks = computePeaks(stubBuffer(44100, [left, right]), 2);
    expect(peaks[0]).toBeCloseTo(0.6, 6);
    expect(peaks[1]).toBeCloseTo(0.6, 6);
  });

  it('bins <= 0 返回空数组；空音频与非整除分箱不越界', () => {
    const buf = stubBuffer(44100, [new Float32Array(128)]);
    expect(computePeaks(buf, 0).length).toBe(0);
    expect(computePeaks(buf, -3).length).toBe(0);
    const empty = computePeaks(stubBuffer(44100, [new Float32Array(0)]), 8);
    expect(rounded(empty, 3)).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    const short = computePeaks(stubBuffer(44100, [new Float32Array([0, 0, 1])]), 10);
    expect(short.length).toBe(10);
    expect(short[9]).toBeCloseTo(1, 6);
    expect(maxOf(short)).toBeLessThanOrEqual(1);
  });
});

describe('encodePeaks / decodePeaks', () => {
  it('往返一致（8bit 量化误差远小于 1/255）', () => {
    const peaks = new Float32Array([0, 0.25, 0.5, 0.999, 1]);
    const text = encodePeaks(peaks);
    expect(text.length).toBe(8); // 5 字节 -> 8 个 base64 字符
    const round = decodePeaks(text);
    expect(round.length).toBe(peaks.length);
    for (let i = 0; i < peaks.length; i++) expect(round[i]).toBeCloseTo(peaks[i], 2);
  });

  it('空输入往返安全', () => {
    expect(encodePeaks(new Float32Array(0))).toBe('');
    expect(decodePeaks('').length).toBe(0);
  });

  it('容忍空白，并拒绝非法字符', () => {
    const text = encodePeaks(new Float32Array([0.5, 0.25]));
    expect(Array.from(decodePeaks(`  ${text}\n`))).toEqual(Array.from(decodePeaks(text)));
    expect(() => decodePeaks('!!!!')).toThrow(/base64/);
  });
});

describe('OfflineSpectrum', () => {
  const sampleRate = 44100;
  const seconds = 1;
  const opts = { minFreq: 40, maxFreq: 16000, columns: 64 };
  const sineBuffer = (): AudioBuffer => stubBuffer(sampleRate, [sine(sampleRate * seconds, 440, sampleRate)]);

  it('缓存帧数与帧步长（默认 fftSize=1024 -> hop=512）', () => {
    const spec = new OfflineSpectrum(sineBuffer(), opts);
    expect(spec.frameCount).toBe(Math.floor((sampleRate * seconds - 1024) / 512) + 1);
    expect(spec.frameStep).toBeCloseTo(512 / sampleRate, 9);
  });

  it('timeAt 长度、值域、越界夹取与确定性', () => {
    const spec = new OfflineSpectrum(sineBuffer(), opts);
    const mid = spec.timeAt(0.5).slice();
    expect(mid.length).toBe(opts.columns);
    for (let k = 0; k < mid.length; k++) {
      expect(mid[k]).toBeGreaterThanOrEqual(0);
      expect(mid[k]).toBeLessThanOrEqual(1);
    }
    // 负时间夹取到首帧；超出末尾夹取到末帧
    expect(Array.from(spec.timeAt(-5).slice())).toEqual(Array.from(spec.timeAt(0).slice()));
    expect(Array.from(spec.timeAt(1e6).slice())).toEqual(Array.from(spec.timeAt(seconds).slice()));
    // 同一时刻重复求值必须完全一致（导出逐帧渲染的前提）
    expect(Array.from(spec.timeAt(0.5).slice())).toEqual(Array.from(mid));
    // 传入 out 时写入并返回该缓冲区
    const out = new Float32Array(opts.columns);
    expect(spec.timeAt(0.5, out)).toBe(out);
    expect(Array.from(out)).toEqual(Array.from(mid));
  });

  it('440Hz 正弦的能量集中在包含 440Hz 的频带', () => {
    const spec = new OfflineSpectrum(sineBuffer(), opts);
    const bands = spec.timeAt(0.5).slice();
    const expected = Math.round(((opts.columns - 1) * Math.log(440 / opts.minFreq)) / Math.log(opts.maxFreq / opts.minFreq));
    const peak = argmaxOf(bands);
    expect(peak).toBeGreaterThanOrEqual(expected - 3);
    expect(peak).toBeLessThanOrEqual(expected + 3);
    expect(maxOf(bands)).toBeGreaterThan(0.2);
    expect(bands[0]).toBeLessThan(0.05);
    expect(bands[opts.columns - 1]).toBeLessThan(0.05);
  });

  it('线性调频信号：高频成分随时间向后移动', () => {
    const buf = stubBuffer(sampleRate, [chirp(sampleRate, 200, 8000, sampleRate)]);
    const spec = new OfflineSpectrum(buf, opts);
    const early = argmaxOf(spec.timeAt(0.05).slice());
    const late = argmaxOf(spec.timeAt(0.95).slice());
    expect(late).toBeGreaterThan(early + 10);
  });

  it('gain 参与缓存并夹取到 0..1', () => {
    const plain = new OfflineSpectrum(sineBuffer(), opts);
    const boosted = new OfflineSpectrum(sineBuffer(), { ...opts, gain: 2 });
    expect(maxOf(boosted.timeAt(0.5).slice())).toBeGreaterThan(maxOf(plain.timeAt(0.5).slice()));
    expect(maxOf(boosted.timeAt(0.5).slice())).toBeLessThanOrEqual(1);
  });

  it('极短音频（不足一个窗口）也能求值', () => {
    const spec = new OfflineSpectrum(stubBuffer(sampleRate, [sine(100, 440, sampleRate)]), opts);
    expect(spec.frameCount).toBe(1);
    const bands = spec.timeAt(0).slice();
    expect(bands.length).toBe(opts.columns);
    for (let k = 0; k < bands.length; k++) {
      expect(bands[k]).toBeGreaterThanOrEqual(0);
      expect(bands[k]).toBeLessThanOrEqual(1);
    }
  });
});
