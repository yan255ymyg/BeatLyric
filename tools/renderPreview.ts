/**
 * 渲染验证脚本（开发工具，不参与打包）
 *
 * 用 @napi-rs/canvas 在 Node 里真实执行 `renderFrame()`，把若干时刻的画面导出成 PNG，
 * 用于在没有浏览器的情况下肉眼检查构图是否正确。
 *
 * 运行：npx tsx tools/renderPreview.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import { createBar, createEvent, createLyricLine, createProject, defaultLrcDisplay, spanOf } from '../src/core/factories';
import { buildTimeline } from '../src/core/timeline';
import { renderFrame, makeEffectsPlan, type RenderResources } from '../src/render/frameRenderer';
import { LrcCursor } from '../src/core/lrc';
import { getDiscTexture, getCircleMask } from '../src/media/albumArt';
import { OfflineSpectrum } from '../src/media/spectrum';
import type { Project } from '../src/model/model';

/* ---- 最小 DOM 垫片：renderFrame / canvasKit 需要 document.createElement('canvas') ---- */
const anyGlobal = globalThis as unknown as Record<string, unknown>;
let fontName = 'sans-serif';
try {
  const candidates = GlobalFonts.families.map((f) => f.family);
  fontName = candidates.join(',') || 'sans-serif';
  console.log('可用字体族：', candidates.slice(0, 12).join(' | '));
} catch {
  /* 忽略 */
}
anyGlobal.document = {
  createElement(tag: string) {
    if (tag !== 'canvas') throw new Error('仅支持 canvas');
    return createCanvas(8, 8);
  },
};
(globalThis as unknown as { window: unknown }).window = { devicePixelRatio: 1 };

/* ---- 构造一个演示项目 ---- */
function demoProject(): Project {
  const p = createProject('演示项目');
  p.timeline.bpm = 128;
  p.timeline.beatsPerNewBar = 4;
  p.canvas = { width: 1920, height: 1080, background: '#05070c' };
  p.bars = [createBar(4), createBar(4), createBar(4)];

  // 第 1 小节：4 个发音
  const chars = ['ノ', 'ー', 'no', 'oo'];
  chars.forEach((t, i) => {
    const ev = createEvent('char', i);
    (ev.data as { lines: { spans: { text: string; style?: Record<string, unknown> }[] }[] }).lines = [
      {
        spans: [
          {
            text: t,
            style:
              i === 0
                ? { bold: true, colors: ['#ffd93d', '#36d399'], ruby: 'no' }
                : { colors: ['#dbe6f5'] },
          },
        ],
      },
    ];
    p.bars[0].events.push(ev);
  });
  // 第 2 小节：歌词字 + 一个暂停 + 一个 bpm 事件
  p.bars[1].events.push(createEvent('char', 4), createEvent('pause', 5), createEvent('char', 6), createEvent('bpm', 7));
  // 第 3 小节：强制行进覆盖前两拍
  const force = createEvent('force', 8);
  (force.data as { lengthBeats: number; ms: number }).lengthBeats = 2;
  (force.data as { lengthBeats: number; ms: number }).ms = 400;
  p.bars[2].events.push(force, createEvent('char', 10));

  // 逐行歌词
  p.lines = ['第一句歌词', '第二句歌词', '第三句歌词', '第四句歌词', '第五句歌词', '第六句歌词'].map((t, i) => {
    const line = createLyricLine();
    line.subLines = [
      {
        id: `s${i}a`,
        spans: [spanOf(t, i === 2 ? { colors: ['#ffd93d', '#36d399'], bold: true } : { colors: ['#dbe6f5'] })],
      },
      { id: `s${i}b`, spans: [spanOf(`translation ${i + 1}`, { colors: ['#8fa3c0'], fontSize: 60 })] },
    ];
    return line;
  });
  // 带注音的一行
  p.lines[3].subLines = [
    {
      id: 'ruby1',
      spans: [
        { text: '桜', style: { ruby: 'さくら', colors: ['#ffd7e0'], bold: true } },
        { text: 'が咲く', style: { colors: ['#dbe6f5'] } },
      ],
    },
  ];

  // 播放设置
  p.playback.lrc = { ...defaultLrcDisplay(), pos: { x: 0.66, y: 0.45 } };
  p.playback.beat.visibleBarCount = 3;
  p.playback.beat.pos = { x: 0.5, y: 0.84 };
  p.playback.spectrum.enabled = true;
  p.playback.spectrum.pos = { x: 0.5, y: 0.5 };
  p.playback.spectrum.width = 0.9;
  p.playback.spectrum.height = 0.5;
  p.playback.spectrum.columns = 64;
  p.playback.spectrum.opacity = 0.5;
  p.playback.album = { ...p.playback.album, enabled: false, assetId: null };
  p.playback.video = { ...p.playback.video, enabled: false, assetId: null };

  // 特效
  p.playback.effects = [
    { id: 'fx1', type: 'beatPulse', enabled: true, trigger: 'beat', strength: 0.05, durationMs: 140, frequency: 2 },
    { id: 'fx2', type: 'sparks', enabled: true, trigger: 'char', strength: 1, durationMs: 900, frequency: 1, count: 18, color: '#ffd27f' },
  ];
  return p;
}

/* ---- 合成一个假的 AudioBuffer（宽带多音信号），让所有频谱列都有内容 ---- */
function fakeAudioBuffer(sampleRate = 44100, seconds = 8): AudioBuffer {
  const length = sampleRate * seconds;
  const data = new Float32Array(length);
  // 在每个八度放一个正弦，并整体做幅度包络，模拟宽带音乐信号
  const tones = [60, 120, 240, 480, 960, 1920, 3840, 7680];
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    let v = 0;
    tones.forEach((f, k) => {
      v += (0.72 / (k + 1.4)) * Math.sin(2 * Math.PI * f * t);
    });
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 1.7 * t);
    data[i] = Math.max(-1, Math.min(1, v * env));
  }
  return {
    length,
    sampleRate,
    numberOfChannels: 1,
    duration: seconds,
    getChannelData: () => data,
    copyFromChannel: () => undefined,
    copyToChannel: () => undefined,
  } as unknown as AudioBuffer;
}

const outDir = new URL('../out/', import.meta.url).pathname.replace(/^\//, '');
mkdirSync(outDir, { recursive: true });

const project = demoProject();
const timeline = buildTimeline(project);
console.log('时间轴：总拍数', timeline.totalBeats, '总秒数', timeline.endSec.toFixed(3));

const audio = fakeAudioBuffer();
const spectrum = new OfflineSpectrum(audio, {
  minFreq: project.playback.spectrum.minFreq,
  maxFreq: project.playback.spectrum.maxFreq,
  columns: project.playback.spectrum.columns,
  gain: project.playback.spectrum.gain,
});

const effects = makeEffectsPlan(project, timeline);

const times = [0.0, 0.45, 0.9, 1.35, 1.8, 2.6, 3.2, 4.0, 4.8];
for (const t of times) {
  const canvas = createCanvas(project.canvas.width, project.canvas.height);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const cursor = new LrcCursor(project, timeline);
  // 让逐行歌词前进到合适的位置：用内联事件模拟
  const state = cursor.seek(t);

  const resources: RenderResources = {
    video: null,
    album: null,
    discTexture: getDiscTexture(512, '#0d0f14'),
    circleMask: getCircleMask(512),
    spectrum: {
      columns: project.playback.spectrum.columns,
      sample: (out?: Float32Array) => spectrum.timeAt(t, out),
    },
    effects,
  };

  renderFrame(ctx, project, timeline, t, resources, {
    width: project.canvas.width,
    height: project.canvas.height,
    layoutScale: 1,
    lrcState: state,
  });

  if (t === 4.0) {
    // 单独用一块干净画布画逐拍歌词，便于用像素采样核对行的落点
    const { layoutBeatLyrics, drawBeatLyrics } = await import('../src/render/beatLyrics');
    const probeCanvas = createCanvas(project.canvas.width, project.canvas.height);
    const pctx = probeCanvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    pctx.setTransform(1, 0, 0, 1, 0, 0);
    pctx.fillStyle = '#05070c';
    pctx.fillRect(0, 0, project.canvas.width, project.canvas.height);
    const layout = layoutBeatLyrics(
      timeline,
      { time: t, width: project.canvas.width, height: project.canvas.height, layoutScale: 1 },
      project.playback.beat,
      (n) => String(n),
    );
    drawBeatLyrics(pctx, layout, { cfg: project.playback.beat, canvasScale: 1 });
    writeFileSync(`${outDir}debug-beat-only.png`, probeCanvas.toBuffer('image/png'));
    console.log('--- 版式 @t=4.0 ---');
    for (const bar of layout.bars) {
      console.log(
        `小节#${bar.barIndex + 1} y=${bar.y.toFixed(1)} top=${(bar.y - bar.rowHeight / 2).toFixed(1)} rowH=${bar.rowHeight.toFixed(1)} axisH=${bar.axisHeight.toFixed(1)} 事件=${bar.events.length}`,
      );
      bar.events.forEach((e) => {
        console.log(
          `   事件 ${e.event.type} x=${e.x.toFixed(1)} axisY=${e.axisY.toFixed(1)} h=${e.height.toFixed(1)} textY=${e.textY.toFixed(1)}`,
        );
      });
    }
  }
  // 顺带检查第一行（t=0.9 时最下面那行）的歌词字文本落点
  if (Math.abs(t - 0.9) < 1e-6) {
    const { layoutBeatLyrics } = await import('../src/render/beatLyrics');
    const layout = layoutBeatLyrics(
      timeline,
      { time: t, width: project.canvas.width, height: project.canvas.height, layoutScale: 1 },
      project.playback.beat,
      (n) => String(n),
    );
    console.log('--- 版式 @t=0.9（检查文本落点）---');
    for (const bar of layout.bars) {
      console.log(`小节#${bar.barIndex + 1} 轴心y=${bar.y.toFixed(1)} 刻度x=${bar.ticks.map((k) => k.x.toFixed(0)).join(',')}`);
      bar.events.forEach((e) => {
        console.log(`   ${e.event.type} x=${e.x.toFixed(1)} textY=${e.textY.toFixed(1)}`);
      });
    }
  }

  const file = `${outDir}frame-${t.toFixed(2)}.png`;
  writeFileSync(file, canvas.toBuffer('image/png'));
  console.log('写出', file);
}

/* ---- 顺带验证字体：中日文是否真的有字形（而不是豆腐块） ---- */
const probe = createCanvas(300, 80);
const pctx = probe.getContext('2d');
pctx.font = '40px sans-serif';
const wJa = pctx.measureText('桜').width;
const wLat = pctx.measureText('Ag').width;
console.log('字体探测：中日文字宽', wJa.toFixed(1), '拉丁字宽', wLat.toFixed(1), wJa > 5 ? '(有字形)' : '(可能缺字形)');
console.log('渲染验证完成。');
