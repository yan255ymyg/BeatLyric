/**
 * 逐拍歌词的全局设置条
 *
 * 包含：
 *  - 音频（音乐）设置：一个明确的「导入音乐」入口 + 波形预览 + 拖动对齐
 *  - 初始 BPM、新增小节时的每小节节拍数、音频偏移、默认吸附
 *  - 小节批量操作、素材库
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, getTimeline } from '../../state/store';
import { fetchAudioForProject } from '../audioBridge';
import { ensurePeaks, peekSharedPeaks } from '../waveformBridge';
import { Field, NumberInput, Section } from './common';
import { assetsOfKind, importFiles, kindLabel, pickFiles } from '../importer';
import { formatBytes, formatTime } from '../../core/util';
import { getPlayback } from '../../playback/controller';
import type { AssetRef } from '../../model/model';

export function TimelineToolbar() {
  const project = useStore((s) => s.project);
  const [open, setOpen] = useState(false);
  const [waveTick, setWaveTick] = useState(0);
  const [dragging, setDragging] = useState(false);

  const audioAsset = project.audioAssetId ? project.assets[project.audioAssetId] : null;
  const peaks = peekSharedPeaks(project);
  const tl = useMemo(() => getTimeline(project), [project]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const buf = await fetchAudioForProject(project);
      if (buf) await ensurePeaks();
      if (!cancelled) setWaveTick((v) => v + 1);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.audioAssetId, project.assets]);

  const setTimeline = (recipe: (d: (typeof project)['timeline']) => void) =>
    useStore.getState().commit('修改时间轴设置', (d) => recipe(d.timeline));

  const bpm = project.timeline.bpm;
  const beats = project.bars.reduce((acc, b) => acc + b.beatCount, 0);

  const importAudio = async () => {
    const files = await pickFiles('audio/*', false);
    if (files.length) await importFiles(files, 'audio');
  };

  return (
    <>
      {/* ---- 音频（音乐）条：始终可见，导入入口明确 ---- */}
      <div
        style={{ padding: '8px 10px', borderBottom: '1px solid var(--line-soft)', background: 'var(--bg-1)' }}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={async (e) => {
          e.preventDefault();
          setDragging(false);
          const files = [...(e.dataTransfer?.files ?? [])].filter(
            (f) => f.type.startsWith('audio/') || /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i.test(f.name),
          );
          if (!files.length) {
            useStore.getState().pushToast('warn', '拖入的文件不是音频');
            return;
          }
          await importFiles(files, 'audio');
        }}
      >
        {!audioAsset ? (
          <div className={`music-empty${dragging ? ' drop-hint' : ''}`}>
            <div className="big">♪</div>
            <div style={{ marginBottom: 8 }}>还没有导入音乐</div>
            <div className="row" style={{ gap: 6, justifyContent: 'center' }}>
              <button className="btn primary" onClick={importAudio}>
                导入音乐文件…
              </button>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              也可以把音频文件直接拖到这里。导入后会被复制到项目的 <code>assets/</code> 目录。
            </div>
          </div>
        ) : (
          <MusicBar asset={audioAsset} peaks={peaks} waveTick={waveTick} tlEndSec={tl.endSec} />
        )}
      </div>

      <div className="beat-toolbar" style={{ gap: 8 }}>
        <button className={open ? 'btn active' : 'btn'} onClick={() => setOpen((v) => !v)}>
          ⚙ 全局设置
        </button>

        <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
          {bpm} BPM · 新增小节 {project.timeline.beatsPerNewBar} 拍 · {project.bars.length} 小节 / {beats} 拍
        </span>

        <span style={{ flex: 1 }} />

        <button className="btn" onClick={importAudio} title="导入或替换音乐">
          ♪ 导入音乐
        </button>
        <button
          className="btn"
          onClick={async () => {
            const files = await pickFiles('image/*', true);
            if (files.length) await importFiles(files, 'image');
          }}
        >
          ▣ 导入图片
        </button>
        <button
          className="btn"
          onClick={async () => {
            const files = await pickFiles('video/*', true);
            if (files.length) await importFiles(files, 'video');
          }}
        >
          ▷ 导入视频
        </button>
      </div>

      {open && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid var(--line)', background: 'var(--bg-2)' }}>
          <div className="row wrap" style={{ gap: 18, alignItems: 'flex-start' }}>
            <div style={{ minWidth: 200 }}>
              <Field label="初始 BPM">
                <NumberInput value={bpm} min={1} max={1000} step={1} onChange={(v) => setTimeline((t) => void (t.bpm = v))} />
              </Field>
              <Field label="新增小节拍数">
                <div className="row" style={{ width: '100%', gap: 4 }}>
                  <button
                    className="btn tiny"
                    onClick={() => setTimeline((t) => void (t.beatsPerNewBar = Math.max(1, t.beatsPerNewBar - 1)))}
                  >
                    −
                  </button>
                  <NumberInput
                    value={project.timeline.beatsPerNewBar}
                    min={1}
                    max={64}
                    onChange={(v) => setTimeline((t) => void (t.beatsPerNewBar = Math.round(v)))}
                  />
                  <button
                    className="btn tiny"
                    onClick={() => setTimeline((t) => void (t.beatsPerNewBar = Math.min(64, t.beatsPerNewBar + 1)))}
                  >
                    ＋
                  </button>
                </div>
              </Field>
              <div className="hint">
                这里只是「新建小节时」使用的拍数；已有小节各自保存自己的拍数，改这里不会影响它们。
              </div>
              <Field label="音频偏移">
                <NumberInput
                  value={project.timeline.audioOffsetMs}
                  min={-600000}
                  max={600000}
                  step={10}
                  suffix="ms"
                  onChange={(v) => {
                    setTimeline((t) => void (t.audioOffsetMs = v));
                    getPlayback().engine.setOffsetMs(v);
                  }}
                />
              </Field>
              <div className="hint">正值表示音频整体延后（前面留白），负值表示音频整体提前（跳过开头）。</div>
            </div>

            <div style={{ minWidth: 230 }}>
              <Field label="默认吸附">
                <div className="row" style={{ width: '100%', gap: 6 }}>
                  <select
                    className="input"
                    style={{ flex: 1 }}
                    value={project.timeline.defaultSnap > 0 ? `p${project.timeline.defaultSnap}` : 'custom'}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (v === 'custom') {
                        setTimeline((t) => void (t.defaultSnap = 0));
                        useStore.getState().setSnap(0);
                      } else {
                        const d = Number(v.slice(1));
                        setTimeline((t) => void (t.defaultSnap = d));
                        useStore.getState().setSnap(d);
                      }
                    }}
                  >
                    {[1, 2, 3, 4, 6, 8].map((d) => (
                      <option key={d} value={`p${d}`}>
                        1/{d} 拍
                      </option>
                    ))}
                    <option value="custom">自定义 1/N</option>
                  </select>
                  {project.timeline.defaultSnap === 0 && (
                    <>
                      <NumberInput
                        value={project.timeline.customSnap}
                        min={2}
                        max={256}
                        width={72}
                        onChange={(v) =>
                          useStore.getState().commit('修改自定义吸附', (d) => {
                            d.timeline.customSnap = Math.max(2, Math.min(256, Math.round(v)));
                          })
                        }
                      />
                      <span className="hint" style={{ flexShrink: 0 }}>
                        /拍
                      </span>
                    </>
                  )}
                </div>
              </Field>
              <Section title="小节批量操作">
                <div className="row wrap" style={{ gap: 5 }}>
                  <button className="btn tiny" onClick={() => useStore.getState().addBar()}>
                    ＋ 末尾加小节
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      useStore.getState().commit('追加 4 小节', (d) => {
                        for (let i = 0; i < 4; i++) {
                          d.bars.push({
                            id: `bar_${Math.random().toString(36).slice(2, 9)}`,
                            beatCount: d.timeline.beatsPerNewBar,
                            transform: { scaleX: 1, offsetX: 0 },
                            events: [],
                          });
                        }
                      })
                    }
                  >
                    ＋ 4 小节
                  </button>
                  <button
                    className="btn tiny"
                    onClick={() =>
                      useStore.getState().commit('复制最后一个小节', (d) => {
                        const last = d.bars[d.bars.length - 1];
                        if (!last) return;
                        const copy = JSON.parse(JSON.stringify(last)) as typeof last;
                        copy.id = `bar_${Math.random().toString(36).slice(2, 9)}`;
                        copy.events.forEach((e) => {
                          e.id = `ev_${Math.random().toString(36).slice(2, 9)}`;
                        });
                        d.bars.push(copy);
                      })
                    }
                  >
                    复制末小节
                  </button>
                  <button
                    className="btn tiny"
                    title="把所有小节的时间轴变换复位（不改拍数）"
                    onClick={() =>
                      useStore.getState().commit('复位所有小节变换', (d) => {
                        d.bars.forEach((b) => {
                          b.transform = { scaleX: 1, offsetX: 0 };
                        });
                      })
                    }
                  >
                    复位所有变换
                  </button>
                </div>
              </Section>
            </div>

            <div style={{ flex: 1, minWidth: 220 }}>
              <Section title="素材库">
                <div className="row wrap" style={{ gap: 5 }}>
                  {Object.values(project.assets).length === 0 && <span className="hint">还没有导入任何素材</span>}
                  {Object.values(project.assets).map((a) => (
                    <span key={a.id} className="badge" title={a.file}>
                      {a.kind === 'audio' ? '♪' : a.kind === 'video' ? '▷' : '▣'} {a.originalName}
                    </span>
                  ))}
                </div>
              </Section>
              <div className="hint">
                项目目录：<code>{useStore.getState().directory.name}</code>
                <br />
                导入的素材会复制到 <code>assets/</code>，同名不同内容会先询问是否覆盖。
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 音乐条：波形 + 偏移 + 快速对齐                                      */
/* ------------------------------------------------------------------ */

function MusicBar({
  asset,
  peaks,
  waveTick,
  tlEndSec,
}: {
  asset: AssetRef;
  peaks: Float32Array | null;
  waveTick: number;
  tlEndSec: number;
}) {
  const project = useStore((s) => s.project);
  const stripRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [duration, setDuration] = useState(asset.duration ?? 0);
  const [cursorSec, setCursorSec] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const buf = await fetchAudioForProject(project);
      if (!cancelled && buf) setDuration(buf.duration);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asset.id]);

  /* 波形绘制 */
  useEffect(() => {
    const canvas = canvasRef.current;
    const strip = stripRef.current;
    if (!canvas || !strip) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, strip.clientWidth);
    const h = Math.max(1, strip.clientHeight);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const spanSec = Math.max(duration, tlEndSec, 0.1);
    const offsetSec = project.timeline.audioOffsetMs / 1000;
    const audioLeft = (offsetSec / spanSec) * w;
    const audioW = (duration / spanSec) * w;

    ctx.fillStyle = 'rgba(78,161,255,0.10)';
    ctx.fillRect(audioLeft, 0, audioW, h);

    const tlW = (tlEndSec / spanSec) * w;
    ctx.fillStyle = 'rgba(255,217,61,0.07)';
    ctx.fillRect(0, 0, tlW, h);

    if (peaks && peaks.length && audioW > 1) {
      const mid = h / 2;
      const step = peaks.length / audioW;
      ctx.fillStyle = '#4ea1ff';
      const bars = Math.floor(audioW);
      for (let x = 0; x < bars; x++) {
        const from = Math.floor(x * step);
        const to = Math.max(from + 1, Math.floor((x + 1) * step));
        let max = 0;
        for (let i = from; i < to && i < peaks.length; i++) max = Math.max(max, peaks[i]);
        const bh = Math.max(1, max * (h - 8));
        ctx.fillRect(audioLeft + x, mid - bh / 2, 1, bh);
      }
    }

    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    for (let s = 0; s <= spanSec; s += 1) {
      const x = (s / spanSec) * w;
      ctx.beginPath();
      ctx.moveTo(x, h - 5);
      ctx.lineTo(x, h);
      ctx.stroke();
    }

    const px = (cursorSec / spanSec) * w;
    ctx.strokeStyle = '#ff5d73';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(px, 0);
    ctx.lineTo(px, h);
    ctx.stroke();
  }, [peaks, waveTick, duration, tlEndSec, project.timeline.audioOffsetMs, cursorSec]);

  /* 播放头跟随 */
  useEffect(() => {
    const off = getPlayback().onFrame(() => setCursorSec(getPlayback().positionSec));
    return off;
  }, []);

  const seekFromEvent = (clientX: number) => {
    const strip = stripRef.current;
    if (!strip) return;
    const rect = strip.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (clientX - rect.left) / Math.max(1, rect.width)));
    const spanSec = Math.max(duration, tlEndSec, 0.1);
    getPlayback().seek(frac * spanSec);
  };

  const setOffset = (ms: number) => {
    useStore.getState().commit('调整音频偏移', (d) => {
      d.timeline.audioOffsetMs = Math.round(ms);
    });
    getPlayback().engine.setOffsetMs(Math.round(ms));
  };

  const audioEnd = duration - project.timeline.audioOffsetMs / 1000;

  return (
    <div>
      <div className="row" style={{ gap: 8, marginBottom: 6 }}>
        <span style={{ fontWeight: 600 }}>♪ {asset.originalName}</span>
        <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
          {formatBytes(asset.size)} · {formatTime(duration)}
        </span>
        <span style={{ flex: 1 }} />
        <select
          className="input"
          style={{ width: 150 }}
          value={project.audioAssetId ?? ''}
          onChange={(e) => {
            const id = e.target.value || null;
            useStore.getState().commit('切换音频', (d) => void (d.audioAssetId = id));
          }}
        >
          <option value="">（不使用音乐）</option>
          {assetsOfKind(project, 'audio').map((a) => (
            <option key={a.id} value={a.id}>
              {a.originalName}
            </option>
          ))}
        </select>
        <button
          className="btn"
          onClick={async () => {
            const files = await pickFiles('audio/*', false);
            if (files.length) await importFiles(files, 'audio');
          }}
        >
          替换音乐
        </button>
      </div>

      <div
        className="wave-strip"
        ref={stripRef}
        title="点击定位播放头；蓝色区域是音乐，黄色区域是歌词时间轴"
        onPointerDown={(e) => {
          (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFromEvent(e.clientX);
        }}
        onPointerMove={(e) => {
          if (e.buttons === 1) seekFromEvent(e.clientX);
        }}
      >
        <canvas ref={canvasRef} />
      </div>

      <div className="row wrap" style={{ gap: 8, marginTop: 6, alignItems: 'center' }}>
        <span className="hint">音频偏移</span>
        <div style={{ width: 112 }}>
          <NumberInput
            value={project.timeline.audioOffsetMs}
            min={-600000}
            max={600000}
            step={10}
            suffix="ms"
            onChange={(v) => setOffset(v)}
          />
        </div>
        <button className="btn tiny" title="让音乐的第 0 秒对齐歌词时间轴的 0 秒" onClick={() => setOffset(0)}>
          对齐开头
        </button>
        <button
          className="btn tiny"
          title="音乐开头正好等于当前播放头位置"
          onClick={() => setOffset(-getPlayback().positionSec * 1000)}
        >
          音乐开场对准播放头
        </button>
        <button
          className="btn tiny"
          title="歌词时间轴结束正好等于音乐结束"
          onClick={() => setOffset((duration - tlEndSec) * 1000)}
        >
          音乐收尾对准时间轴
        </button>
        <span style={{ flex: 1 }} />
        <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
          时间轴 {formatTime(tlEndSec)} · 音乐 {formatTime(duration)} · 音乐结束于 {formatTime(audioEnd)}
        </span>
      </div>
      {Math.abs(duration - tlEndSec) > 0.05 && (
        <div className="hint warn" style={{ marginTop: 4 }}>
          歌词时间轴与音乐时长相差 {formatTime(Math.abs(duration - tlEndSec))}。
          较短的一方会先结束：音乐先结束则歌词继续走完；歌词先结束则播放头停在末尾等待音乐。
        </div>
      )}
    </div>
  );
}

export { kindLabel };
