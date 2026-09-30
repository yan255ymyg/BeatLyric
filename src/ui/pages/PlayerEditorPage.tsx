/**
 * 播放编辑页
 *
 * 左：设置面板（画布 / 专辑图 / 逐拍歌词 / 逐行歌词 / 视频背景 / 特效 / 频谱 / 导出）
 * 中：实时预览舞台 + 播放控制
 * 右：快速定位与状态
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useStore, getTimeline, type PlayerToolbarTab } from '../../state/store';
import { usePlayerRenderer } from '../usePlayerRenderer';
import { getPlayback } from '../../playback/controller';
import { formatTimecode } from '../../playback/duration';
import { CanvasPanel } from '../components/player/CanvasPanel';
import { AlbumPanel } from '../components/player/AlbumPanel';
import { BeatDisplayPanel } from '../components/player/BeatDisplayPanel';
import { LrcDisplayPanel } from '../components/player/LrcDisplayPanel';
import { VideoPanel } from '../components/player/VideoPanel';
import { EffectsPanel } from '../components/player/EffectsPanel';
import { SpectrumPanel } from '../components/player/SpectrumPanel';
import { ExportPanel } from '../components/player/ExportPanel';
import { Splitter } from '../components/Splitter';
import { Section, Slider, Field, Checkbox } from '../components/common';
import { computeLrcLayout } from '../../core/lrc';

const TABS: { id: PlayerToolbarTab; label: string }[] = [
  { id: 'canvas', label: '画布' },
  { id: 'album', label: '专辑图' },
  { id: 'beat', label: '逐拍歌词' },
  { id: 'line', label: '逐行歌词' },
  { id: 'background', label: '视频背景' },
  { id: 'effects', label: '特效' },
  { id: 'spectrum', label: '频谱' },
  { id: 'export', label: '导出' },
];

export function PlayerEditorPage() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const project = useStore((s) => s.project);
  const tab = useStore((s) => s.playerToolbarTab);
  const renderer = usePlayerRenderer(canvasRef, { active: true });
  const [fitScale, setFitScale] = useState(1);
  const [autoFit, setAutoFit] = useState(true);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const [leftW, setLeftW] = useState(290);
  const [rightW, setRightW] = useState(320);
  const [bottomH, setBottomH] = useState(168);

  /* 预览舞台按容器尺寸自适应缩放（画布本身保持项目逻辑尺寸） */
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || !autoFit) return;
    const compute = () => {
      const availW = el.clientWidth - 24;
      const availH = el.clientHeight - 24;
      const s = Math.min(availW / project.canvas.width, availH / project.canvas.height);
      setFitScale(Math.max(0.05, Math.min(s, 1)));
    };
    compute();
    const ro = new ResizeObserver(compute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [project.canvas.width, project.canvas.height, autoFit]);

  /* 设置变化后立刻重绘 */
  useEffect(() => {
    renderer.redraw();
  }, [project, renderer]);

  return (
    <div
      className="workspace player"
      ref={rootRef}
      style={{ gridTemplateColumns: `${leftW}px 6px minmax(240px, 1fr) 6px ${rightW}px` }}
    >
      <div className="panel">
        <div className="tabs" style={{ paddingBottom: 0 }}>
          {TABS.map((t) => (
            <button
              key={t.id}
              className={clsx('tab', tab === t.id && 'active')}
              onClick={() => useStore.getState().setPlayerToolbarTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>
        <div className="panel-body">
          {tab === 'canvas' && <CanvasPanel />}
          {tab === 'album' && <AlbumPanel onChanged={renderer.redraw} />}
          {tab === 'beat' && <BeatDisplayPanel />}
          {tab === 'line' && <LrcDisplayPanel />}
          {tab === 'background' && <VideoPanel onChanged={renderer.redraw} />}
          {tab === 'effects' && <EffectsPanel />}
          {tab === 'spectrum' && <SpectrumPanel onChanged={renderer.redraw} />}
          {tab === 'export' && <ExportPanel />}
        </div>
      </div>

      <Splitter
        onResize={(d) => setLeftW((v) => Math.max(200, Math.min(620, v + d)))}
        onReset={() => setLeftW(290)}
        title="拖动调整左侧设置栏宽度（双击复位）"
      />

      <div className="panel" style={{ background: '#07090d' }}>
        <div className="stage">
          <div className="stage-canvas-wrap" ref={wrapRef}>
            <canvas
              ref={canvasRef}
              style={{
                width: project.canvas.width * fitScale,
                height: project.canvas.height * fitScale,
                imageRendering: 'auto',
              }}
            />
          </div>
          <Splitter
            direction="horizontal"
            onResize={(d) => setBottomH((v) => Math.max(96, Math.min(360, v - d)))}
            onReset={() => setBottomH(168)}
            title="拖动调整状态面板高度（双击复位）"
          />
          <div className="stage-bottom" style={{ height: bottomH }}>
            <PreviewStatus />
          </div>
        </div>
      </div>

      <Splitter
        onResize={(d) => setRightW((v) => Math.max(180, Math.min(680, v - d)))}
        onReset={() => setRightW(320)}
        title="拖动调整右侧面板宽度（双击复位）"
      />

      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">快捷操作</span>
        </div>
        <StageSidePanel
          fitScale={fitScale}
          autoFit={autoFit}
          onZoom={setFitScale}
          onAutoFit={setAutoFit}
          onRedraw={renderer.redraw}
        />
      </div>
    </div>
  );
}

/** 右侧面板：播放控制 + 缩放 + 重绘 */
function StageSidePanel({
  fitScale,
  autoFit,
  onZoom,
  onAutoFit,
  onRedraw,
}: {
  fitScale: number;
  autoFit: boolean;
  onZoom: (v: number) => void;
  onAutoFit: (v: boolean) => void;
  onRedraw: () => void;
}) {
  const playing = useStore((s) => s.playing);
  const project = useStore((s) => s.project);
  const total = useMemo(() => {
    const p = useStore.getState().project;
    return Math.max(getTimeline(p).endSec, 0.001);
  }, []);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    const off = getPlayback().onFrame((p) => setPos(p));
    return off;
  }, []);

  return (
    <div className="panel-body pad">
      <Section title="播放">
        <div className="row" style={{ gap: 6, marginBottom: 8 }}>
          <button className="btn icon" onClick={() => getPlayback().seek(0)} title="回到开头">
            ⏮
          </button>
          <button className="btn icon" onClick={() => getPlayback().seek(pos - 1)} title="后退 1s">
            ⏪
          </button>
          <button className="btn primary icon" onClick={() => getPlayback().toggle()} title="播放 / 暂停（空格）">
            {playing ? '⏸' : '▶'}
          </button>
          <button className="btn icon" onClick={() => getPlayback().seek(pos + 1)} title="前进 1s">
            ⏩
          </button>
          <span className="timecode" style={{ minWidth: 78 }}>
            {formatTimecode(pos)}
          </span>
        </div>
        <div className="seekbar" style={{ maxWidth: 'none', width: '100%' }}>
          <input
            type="range"
            min={0}
            max={Math.max(total, 0.001)}
            step={0.001}
            value={Math.min(pos, total)}
            onChange={(e) => getPlayback().seek(Number(e.target.value))}
          />
        </div>
        <div className="hint" style={{ fontFamily: 'var(--mono)' }}>
          总长 {formatTimecode(total)}
        </div>
      </Section>

      <Section title="预览缩放">
        <Field label="缩放">
          <Slider value={fitScale} min={0.05} max={1.5} step={0.01} onChange={onZoom} inputWidth={58} />
        </Field>
        <Checkbox checked={autoFit} label="自动适应窗口" onChange={onAutoFit} />
        <div className="row" style={{ gap: 6, marginTop: 6 }}>
          <button className="btn tiny" onClick={onRedraw} title="强制重绘">
            ↻ 重绘
          </button>
          <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
            {project.canvas.width}×{project.canvas.height}
          </span>
        </div>
      </Section>

      <Section title="提示">
        <div className="hint" style={{ lineHeight: 1.8 }}>
          拖动分隔条可调整三栏宽度与下方状态区高度，双击分隔条复位。
          <br />
          预览画面与导出使用同一套渲染代码。
        </div>
      </Section>
    </div>
  );
}

function PreviewStatus() {
  const project = useStore((s) => s.project);
  const [state, setState] = useState(() => getPlayback().lrc);
  const [pos, setPos] = useState(0);

  useEffect(() => {
    const off = getPlayback().onFrame((p) => {
      setPos(p);
      setState(getPlayback().lrc);
    });
    return off;
  }, []);

  const layout = useMemo(
    () => computeLrcLayout(project.lines, state, project.playback.lrc),
    [project.lines, state, project.playback.lrc],
  );
  const total = getTimeline(project).endSec;

  return (
    <div className="panel-body pad">
      <div className="section">
        <div className="section-title">
          <span>进度</span>
          <span className="line" />
        </div>
        <div className="hint" style={{ fontFamily: 'var(--mono)', lineHeight: 1.9 }}>
          播放头：{formatTimecode(pos)}
          <br />
          时间轴总长：{formatTimecode(total)}
          <br />
          音频偏移：{project.timeline.audioOffsetMs} ms
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <span>逐行歌词状态</span>
          <span className="line" />
        </div>
        <div className="hint" style={{ lineHeight: 1.9 }}>
          主歌词块：第 {state.mainLine + 1} 块
          <br />
          临时行：{state.tempLines.length ? state.tempLines.map((i) => i + 1).join('、') : '（无）'}
          <br />
          当前显示 {layout.placed.length} 块（上 {project.playback.lrc.aboveCount} / 下 {project.playback.lrc.belowCount}）
        </div>
      </div>

      <div className="section">
        <div className="section-title">
          <span>当前小节</span>
          <span className="line" />
        </div>
        <CurrentBarInfo pos={pos} />
      </div>
    </div>
  );
}

function CurrentBarInfo({ pos }: { pos: number }) {
  const project = useStore((s) => s.project);
  const tl = getTimeline(project);
  const info = useMemo(() => {
    for (const span of tl.spans) {
      const start = tl.segs.length ? span.startBeat : 0;
      void start;
    }
    // 直接用拍定位
    let beat = 0;
    for (let i = 0; i < tl.segs.length; i++) {
      if (tl.segs[i].sec <= pos + 1e-9) beat = tl.segs[i].beat + (pos - tl.segs[i].sec) / tl.segs[i].spb;
      else break;
    }
    let span = tl.spans[0];
    for (const s of tl.spans) {
      if (beat >= s.startBeat) span = s;
      else break;
    }
    return { span, beat };
  }, [tl, pos]);

  if (!info.span) return <div className="hint">暂无小节</div>;
  const rel = info.beat - info.span.startBeat;
  return (
    <div className="hint" style={{ fontFamily: 'var(--mono)', lineHeight: 1.9 }}>
      小节 #{info.span.index + 1}（{info.span.beatCount} 拍）
      <br />
      小节内位置：第 {(rel + 1).toFixed(2)} 拍
      <br />
      全局拍号：{info.beat.toFixed(2)}
    </div>
  );
}
