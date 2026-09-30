import { describe, expect, it } from 'vitest';
import { sliceAudioBuffer } from '../media/audio';
import {
  clearProbeCache,
  isCodecAllowedInFormat,
  listPresets,
  listPresetsWithSupport,
  preferredOrder,
  probeCodecs,
  resolveCodecs,
  resolvePreset,
  toMediabunnyAudioCodec,
  toMediabunnyVideoCodec,
  WEBCODECS_UNSUPPORTED_MESSAGE,
} from './capabilities';

/**
 * 只测纯逻辑与「无 WebCodecs 环境下的优雅降级」。
 * node 环境没有 DOM / 没有 VideoEncoder / AudioEncoder，因此所有编码器都必须是 supported: false。
 */

describe('listPresets', () => {
  it('返回非空预设列表', () => {
    const presets = listPresets();
    expect(Array.isArray(presets)).toBe(true);
    expect(presets.length).toBeGreaterThan(0);
  });

  it('每个预设的宽高与帧率为正、容器合法、编码与码率非空', () => {
    for (const preset of listPresets()) {
      expect(preset.id.length, preset.id).toBeGreaterThan(0);
      expect(preset.label.length, preset.id).toBeGreaterThan(0);
      expect(preset.width, preset.id).toBeGreaterThan(0);
      expect(preset.height, preset.id).toBeGreaterThan(0);
      expect(preset.fps, preset.id).toBeGreaterThan(0);
      expect(['mp4', 'webm'], preset.id).toContain(preset.format);
      expect(preset.videoCodec.length, preset.id).toBeGreaterThan(0);
      expect(preset.audioCodec.length, preset.id).toBeGreaterThan(0);
      expect(preset.videoBitrateMbps, preset.id).toBeGreaterThan(0);
      expect(preset.audioBitrateKbps, preset.id).toBeGreaterThan(0);
    }
  });

  it('id 唯一', () => {
    const ids = listPresets().map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('包含 1080p60 / 1080p30 / 720p60 / 4K30 这些档位', () => {
    const combos = listPresets().map((p) => `${p.width}x${p.height}@${p.fps}`);
    expect(combos).toContain('1920x1080@60');
    expect(combos).toContain('1920x1080@30');
    expect(combos).toContain('1280x720@60');
    expect(combos).toContain('3840x2160@30');
  });

  it('是纯同步函数：不探测、不带 available 标记', () => {
    for (const preset of listPresets()) {
      expect(preset.available).toBeUndefined();
    }
  });

  it('格式与编码组合自洽（WebM 不允许 H.264/H.265）', () => {
    for (const preset of listPresets()) {
      expect(isCodecAllowedInFormat('video', preset.videoCodec, preset.format), preset.id).toBe(true);
      expect(isCodecAllowedInFormat('audio', preset.audioCodec, preset.format), preset.id).toBe(true);
    }
  });
});

describe('preferredOrder / 编码名映射', () => {
  it('请求的编码在该容器允许时排在最前', () => {
    expect(preferredOrder('vp9', ['h264', 'hevc', 'av1', 'vp9'])).toEqual(['vp9', 'h264', 'hevc', 'av1']);
  });

  it('请求的编码在该容器不允许时直接使用容器回退链', () => {
    expect(preferredOrder('h264', ['vp9', 'av1'])).toEqual(['vp9', 'av1']);
  });

  it('项目侧编码名能映射到 mediabunny 编码名', () => {
    expect(toMediabunnyVideoCodec('h264')).toBe('avc');
    expect(toMediabunnyVideoCodec('hevc')).toBe('hevc');
    expect(toMediabunnyVideoCodec('av1')).toBe('av1');
    expect(toMediabunnyVideoCodec('vp9')).toBe('vp9');
    expect(toMediabunnyVideoCodec('avc')).toBe('avc');
    expect(toMediabunnyVideoCodec('unknown')).toBeNull();
    expect(toMediabunnyAudioCodec('aac')).toBe('aac');
    expect(toMediabunnyAudioCodec('opus')).toBe('opus');
    expect(toMediabunnyAudioCodec('unknown')).toBeNull();
  });

  it('容器编码约束', () => {
    expect(isCodecAllowedInFormat('video', 'h264', 'webm')).toBe(false);
    expect(isCodecAllowedInFormat('video', 'vp9', 'webm')).toBe(true);
    expect(isCodecAllowedInFormat('audio', 'aac', 'mp4')).toBe(true);
    expect(isCodecAllowedInFormat('audio', 'aac', 'webm')).toBe(false);
    expect(isCodecAllowedInFormat('audio', 'opus', 'webm')).toBe(true);
  });
});

describe('probeCodecs（node 环境，无 WebCodecs）', () => {
  it('不抛异常、且全部标记为 supported: false', async () => {
    clearProbeCache();
    const codecs = await probeCodecs({ refresh: true });
    expect(codecs.length).toBeGreaterThan(0);
    for (const codec of codecs) {
      expect(codec.supported, codec.codec).toBe(false);
      expect(typeof codec.label).toBe('string');
      expect(['video', 'audio']).toContain(codec.kind);
    }
  });

  it('同时覆盖视频与音频编码器条目', async () => {
    const codecs = await probeCodecs();
    const ids = codecs.map((c) => `${c.kind}:${c.codec}`);
    expect(ids).toContain('video:h264');
    expect(ids).toContain('video:hevc');
    expect(ids).toContain('video:av1');
    expect(ids).toContain('video:vp9');
    expect(ids).toContain('audio:aac');
    expect(ids).toContain('audio:opus');
  });

  it('缺少 API 时给出中文说明而不是抛错', async () => {
    const codecs = await probeCodecs();
    for (const codec of codecs) {
      expect(typeof codec.notes, codec.codec).toBe('string');
      expect(codec.notes?.length ?? 0, codec.codec).toBeGreaterThan(0);
    }
  });

  it('结果被缓存（同一参数返回同一份数据）', async () => {
    const a = await probeCodecs();
    const b = await probeCodecs();
    expect(b).toBe(a);
  });
});

describe('resolvePreset / resolveCodecs（无编码器可用）', () => {
  it('resolvePreset 抛出带中文提示的错误', async () => {
    const preset = listPresets()[0];
    await expect(resolvePreset(preset)).rejects.toThrow(/当前浏览器不支持/);
    await expect(resolvePreset(preset)).rejects.toThrow('WebCodecs');
    await expect(resolvePreset(preset)).rejects.toThrow(new Error(WEBCODECS_UNSUPPORTED_MESSAGE));
  });

  it('resolveCodecs 抛出带中文提示的错误', async () => {
    await expect(
      resolveCodecs({
        format: 'mp4',
        videoCodec: 'h264',
        audioCodec: 'aac',
        width: 1920,
        height: 1080,
        fps: 60,
        videoBitrateMbps: 12,
        audioBitrateKbps: 192,
      }),
    ).rejects.toThrow(/WebCodecs 视频编码器/);
  });

  it('listPresetsWithSupport 在无编码器时把所有预设标记为不可用', async () => {
    const presets = await listPresetsWithSupport();
    expect(presets.length).toBe(listPresets().length);
    expect(presets.every((p) => p.available === false)).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* sliceAudioBuffer：时间轴对齐（与 src/playback/engine.ts 的约定一致）  */
/* ------------------------------------------------------------------ */

/** 无 DOM 的假 AudioBuffer：采样率固定为 1000，便于用整数验证移位 */
function fakeAudioBuffer(channels: number[][], sampleRate = 1000): AudioBuffer {
  const data = channels.map((values) => Float32Array.from(values));
  return {
    sampleRate,
    length: data[0]?.length ?? 0,
    numberOfChannels: data.length,
    duration: (data[0]?.length ?? 0) / sampleRate,
    getChannelData: (ch: number) => data[ch],
  } as unknown as AudioBuffer;
}

function fakeAudioContext(): BaseAudioContext {
  return {
    createBuffer: (channelCount: number, length: number, sampleRate: number) => {
      const data = Array.from({ length: channelCount }, () => new Float32Array(length));
      return {
        sampleRate,
        length,
        numberOfChannels: channelCount,
        duration: length / sampleRate,
        getChannelData: (ch: number) => data[ch],
      } as unknown as AudioBuffer;
    },
  } as unknown as BaseAudioContext;
}

describe('sliceAudioBuffer（时间轴对齐）', () => {
  const ctx = fakeAudioContext();
  const source = fakeAudioBuffer([[0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]);
  const read = (result: AudioBuffer): number[] => Array.from(result.getChannelData(0));

  it('时长按 durationSec 截断', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: 0, durationSec: 0.004 });
    expect(result.length).toBe(4);
    expect(read(result)).toEqual([0, 1, 2, 3]);
  });

  it('时间轴比音频长：结尾补静音', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: 0, durationSec: 0.014 });
    expect(read(result)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0, 0, 0, 0]);
  });

  it('offsetMs > 0：音频被提前，裁掉音频开头（音频时间 = 播放头时间 + offset）', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: 2, durationSec: 0.01 });
    expect(read(result)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 0, 0]);
  });

  it('offsetMs < 0：音频整体延后，开头补静音', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: -3, durationSec: 0.01 });
    expect(read(result)).toEqual([0, 0, 0, 0, 1, 2, 3, 4, 5, 6]);
  });

  it('偏移超出音频范围时全为静音', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: 9999, durationSec: 0.005 });
    expect(read(result)).toEqual([0, 0, 0, 0, 0]);
  });

  it('多声道各自独立移位', () => {
    const stereo = fakeAudioBuffer([
      [0, 1, 2, 3],
      [10, 11, 12, 13],
    ]);
    const result = sliceAudioBuffer(ctx, stereo, { offsetMs: 1, durationSec: 0.004 });
    expect(Array.from(result.getChannelData(0))).toEqual([1, 2, 3, 0]);
    expect(Array.from(result.getChannelData(1))).toEqual([11, 12, 13, 0]);
  });

  it('durationSec <= 0 时不抛错（退化为 1 个采样点）', () => {
    const result = sliceAudioBuffer(ctx, source, { offsetMs: 0, durationSec: 0 });
    expect(result.length).toBeGreaterThanOrEqual(1);
  });
});
