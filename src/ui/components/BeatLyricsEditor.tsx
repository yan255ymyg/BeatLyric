/**
 * 逐拍歌词编辑器
 *
 * 时间轴形态（对应需求与参考截图）
 * ──────────────────────────────
 * 一行 = 一个小节：一条横向主轴，上面在每个**拍位置**画一个细高的竖直刻度；
 * 节拍序号画在刻度正下方，歌词字文本也挂在刻度位置的正下方。
 * 同一小节内所有刻度的间距相等（除非设置了该小节的时间轴变换）。
 *
 * 交互一览
 * ────────
 *  - 双击轨道：用当前工具在该位置插入事件（按吸附取整）
 *  - 左键点击事件：选中它；**在同一个指针位置反复点击**会在重叠的事件之间循环
 *    （每次点击把当前最上层的那个压到最下层，并选中下一个），
 *    重叠判定基于「指针处的实际事件数量」，而不是只看拍号。
 *  - Ctrl+点击事件：加入 / 移出多选
 *  - 拖动事件图标：移动位置（跨小节也可以）
 *  - **按住右键在轨道内滑动**：扫过的事件被标记为待删除（红色虚线框），
 *    松开右键时统一删除，可撤销
 *  - Ctrl+C / Ctrl+V：复制 / 粘贴到选中的小节
 *  - Delete / Backspace：删除选中的事件（在输入框内不会触发）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { Bar, BeatEvent, BeatEventType } from '../../model/model';
import { EVENT_META } from '../../model/model';
import { computeBarLayout, forceSpanBeats, beatToSeconds } from '../../core/timeline';
import { clamp } from '../../core/util';
import { useStore, useTimeline, computeForceConflicts, getTimeline } from '../../state/store';
import { getPlayback } from '../../playback/controller';
import { EventGlyph } from './EventGlyph';
import { BarInspector } from './BarInspector';
import { resolveClick, sendToBack } from '../../core/eventHit';

/** 事件图标的最小点击宽度（保证「方块变大、好点」） */
const MIN_EVENT_W = 16;
const MIN_EVENT_H = 26;

export function BeatLyricsEditor() {
  const project = useStore((s) => s.project);
  const snap = useStore((s) => s.snap);
  const tl = useTimeline();
  const selectedBarId = useStore((s) => s.selectedBarId);
  const selectedEventIds = useStore((s) => s.selectedEventIds);
  const conflicts = useMemo(() => computeForceConflicts(project), [project]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [tool, setTool] = useState<BeatEventType>('char');
  const [previewPosition, setPreviewPosition] = useState(useStore.getState().positionSec);
  const [dragState, setDragState] = useState<{ barId: string } | null>(null);
  const [dragOverBar, setDragOverBar] = useState<{ barId: string; side: 'before' | 'after' } | null>(null);
  const [insertBarAt, setInsertBarAt] = useState<number | null>(null);

  const followPlayhead = useStore((s) => s.previewFollow);
  const selectedSet = useMemo(() => new Set(selectedEventIds), [selectedEventIds]);

  useEffect(() => {
    const off = getPlayback().onFrame((p) => setPreviewPosition(p));
    return off;
  }, []);

  /* 跟随滚动 */
  useEffect(() => {
    if (!followPlayhead || !scrollRef.current) return;
    const cur = tl.spans.find((s) => {
      const start = beatToSeconds(tl, s.startBeat);
      const end = beatToSeconds(tl, s.startBeat + s.beatCount);
      return previewPosition >= start && previewPosition < end;
    });
    if (!cur) return;
    const el = scrollRef.current.querySelector<HTMLElement>(`[data-bar-id="${cur.id}"]`);
    if (!el) return;
    const container = scrollRef.current;
    const top = el.offsetTop - container.clientHeight * 0.35;
    if (Math.abs(container.scrollTop - top) > 60) container.scrollTo({ top, behavior: 'smooth' });
  }, [previewPosition, followPlayhead, tl]);

  const insertEvent = useCallback(
    (bar: Bar, span: { startBeat: number; beatCount: number }, beatsInBar: number[]) => {
      const useBeats = beatsInBar.length ? beatsInBar : [0];
      const first = useBeats[0];
      const globalBeat = span.startBeat + clamp(first, 0, span.beatCount - 1e-6);
      useStore.getState().addEvent(bar.id, tool, globalBeat);
    },
    [tool],
  );

  const handleDrop = (targetIndex: number) => {
    if (!dragState) return;
    const from = project.bars.findIndex((b) => b.id === dragState.barId);
    if (from < 0) return;
    const side = dragOverBar?.side ?? 'before';
    let to = targetIndex + (side === 'after' ? 1 : 0);
    if (to > from) to -= 1;
    if (to !== from) useStore.getState().moveBar(from, to - from);
    setDragState(null);
    setDragOverBar(null);
  };

  return (
    <div className="beat-editor">
      <div className="beat-toolbar">
        <span className="hint" style={{ marginRight: 2 }}>
          插入工具
        </span>
        <div className="row wrap" style={{ gap: 3 }}>
          {(Object.keys(EVENT_META) as BeatEventType[]).map((t) => (
            <button
              key={t}
              className={clsx('btn tiny', tool === t && 'active')}
              title={EVENT_META[t].hint}
              onClick={() => setTool(t)}
            >
              <EventGlyph type={t} size={12} />
              {EVENT_META[t].label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1 }} />

        <span className="hint">吸附</span>
        <SnapPicker />

        <label className="row" style={{ gap: 5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={followPlayhead}
            onChange={(e) => useStore.getState().setPreviewFollow(e.target.checked)}
          />
          <span className="hint">跟随滚动</span>
        </label>
      </div>

      <div className="bar-scroll" ref={scrollRef}>
        {project.bars.length === 0 && (
          <div className="empty">
            还没有小节。
            <br />
            点下面的「＋ 末尾新增小节」开始，或在「全局设置」里调整默认拍数。
          </div>
        )}
        {project.bars.map((bar, index) => (
          <BarRow
            key={bar.id}
            bar={bar}
            index={index}
            selected={bar.id === selectedBarId}
            selectedSet={selectedSet}
            conflicts={conflicts}
            snap={snap}
            position={previewPosition}
            tl={tl}
            dragging={dragState?.barId === bar.id}
            dropSide={dragOverBar?.barId === bar.id ? dragOverBar.side : null}
            onDragStart={() => setDragState({ barId: bar.id })}
            onDragOverSide={(side) => setDragOverBar({ barId: bar.id, side })}
            onDropHere={() => handleDrop(index)}
            onInsert={(beats) => insertEvent(bar, tl.spans[index], beats)}
          />
        ))}

        {insertBarAt !== null && (
          <div className="row" style={{ justifyContent: 'center', margin: '6px 0' }}>
            <button
              className="btn tiny primary"
              onClick={() => {
                useStore.getState().addBar(insertBarAt);
                setInsertBarAt(null);
              }}
            >
              在此插入小节
            </button>
            <button className="btn tiny ghost" onClick={() => setInsertBarAt(null)}>
              取消
            </button>
          </div>
        )}

        <div className="row" style={{ gap: 6, marginTop: 10, justifyContent: 'center', flexWrap: 'wrap' }}>
          <button className="btn" onClick={() => useStore.getState().addBar()}>
            ＋ 末尾新增小节
          </button>
          <button className="btn ghost" onClick={() => setInsertBarAt(project.bars.length)}>
            指定位置插入…
          </button>
          <button
            className="btn ghost"
            disabled={!selectedEventIds.length}
            onClick={() => useStore.getState().copySelectedEvents()}
            title="复制选中的事件 (Ctrl+C)"
          >
            复制选中 {selectedEventIds.length ? `(${selectedEventIds.length})` : ''}
          </button>
          <button
            className="btn ghost"
            disabled={!useStore.getState().clipboard.length}
            onClick={() => useStore.getState().pasteEvents(selectedBarId)}
            title="粘贴到选中的小节 (Ctrl+V)"
          >
            粘贴
          </button>
          <button
            className="btn ghost danger"
            disabled={!selectedEventIds.length}
            onClick={() => useStore.getState().deleteSelectedEvents()}
          >
            删除选中
          </button>
        </div>
        <div className="hint" style={{ textAlign: 'center', marginTop: 8 }}>
          双击轨道插入；点击事件选中，同一处反复点击可在重叠事件间循环；
          Ctrl+点击多选；按住右键滑动批量删除；Ctrl+C / Ctrl+V 复制粘贴。
        </div>
      </div>

      <BarInspector />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 吸附选择器（含自定义 1/N）                                          */
/* ------------------------------------------------------------------ */

function SnapPicker() {
  const snap = useStore((s) => s.snap);
  const custom = useStore((s) => s.project.timeline.customSnap);
  const presets = [1, 2, 3, 4, 6, 8];

  return (
    <div className="row" style={{ gap: 4 }}>
      <div className="snap-group">
        {presets.map((d) => (
          <button key={d} className={clsx(snap === d && 'active')} onClick={() => useStore.getState().setSnap(d)}>
            1/{d}
          </button>
        ))}
        <button className={clsx(snap === 0 && 'active')} title="自定义吸附分母" onClick={() => useStore.getState().setSnap(0)}>
          1/N
        </button>
      </div>
      {snap === 0 && (
        <div className="row" style={{ gap: 3 }}>
          <span className="hint">1/</span>
          <input
            className="input num"
            style={{ width: 54 }}
            value={custom}
            onChange={(e) => {
              const v = Number(e.target.value);
              if (Number.isFinite(v)) {
                useStore.getState().commit('修改自定义吸附', (d) => {
                  d.timeline.customSnap = Math.max(2, Math.min(256, Math.round(v)));
                });
              }
            }}
          />
          <span className="hint">拍</span>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 单行小节                                                            */
/* ------------------------------------------------------------------ */

interface BarRowProps {
  bar: Bar;
  index: number;
  selected: boolean;
  selectedSet: Set<string>;
  conflicts: Set<string>;
  snap: number;
  position: number;
  tl: ReturnType<typeof getTimeline>;
  dragging: boolean;
  dropSide: 'before' | 'after' | null;
  onDragStart: () => void;
  onDragOverSide: (side: 'before' | 'after') => void;
  onDropHere: () => void;
  onInsert: (beats: number[]) => void;
}

function BarRow({
  bar,
  index,
  selected,
  selectedSet,
  conflicts,
  snap,
  position,
  tl,
  dragging,
  dropSide,
  onDragStart,
  onDragOverSide,
  onDropHere,
  onInsert,
}: BarRowProps) {
  const trackRef = useRef<HTMLDivElement>(null);
  const span = tl.spans[index];
  const [dragPreview, setDragPreview] = useState<{ eventId: string; beatInBar: number } | null>(null);
  /** 记录指针上一次按下时点击过的事件，用于「同处反复点击循环重叠事件」 */
  const lastHitRef = useRef<{ x: number; y: number; cycle: number } | null>(null);

  const layout = useMemo(() => computeBarLayout(span, bar, 0), [span, bar]);
  const startSec = beatToSeconds(tl, span.startBeat);
  const endSec = beatToSeconds(tl, span.startBeat + span.beatCount);
  const inBar = position >= startSec && position < endSec;
  const playheadFrac = inBar ? clamp((position - startSec) / Math.max(1e-6, endSec - startSec), 0, 1) : 0;

  /** 该小节的生效吸附分母 */
  const divisor = snap > 0 ? snap : useStore((s) => s.project.timeline.customSnap);
  const snapBeat = (v: number) => (divisor > 0 ? Math.round(v * divisor) / divisor : v);

  const beatToFrac = useCallback(
    (beat: number) => layout.frameFrac.left + ((beat - span.startBeat) / span.beatCount) * layout.frameFrac.width,
    [layout, span],
  );

  const pointToBeatInBar = useCallback(
    (clientX: number): number => {
      const el = trackRef.current;
      if (!el) return 0;
      const r = el.getBoundingClientRect();
      const frac = (clientX - r.left) / Math.max(1, r.width);
      const frameFrac = (frac - layout.frameFrac.left) / Math.max(1e-6, layout.frameFrac.width);
      return clamp(frameFrac * span.beatCount, 0, span.beatCount);
    },
    [layout, span.beatCount],
  );

  /**
   * 指针处命中的事件列表（按「上层优先」排序）。
   * 重叠判定用**实际命中**而不是拍号：只要指针落在图标矩形内就算命中。
   */
  const hitEventsAt = useCallback(
    (clientX: number, clientY: number): { ev: BeatEvent; x: number; y: number; w: number; h: number }[] => {
      const track = trackRef.current;
      if (!track) return [];
      const r = track.getBoundingClientRect();
      const px = clientX - r.left;
      const py = clientY - r.top;
      const axisY = TRACK_AXIS_Y;
      const out: { ev: BeatEvent; x: number; y: number; w: number; h: number }[] = [];
      for (const ev of bar.events) {
        if (!Number.isFinite(ev.beat) || ev.beat < span.startBeat - 1e-9 || ev.beat >= span.startBeat + span.beatCount - 1e-9) continue;
        const w = Math.max(MIN_EVENT_W, eventDisplayWidth(ev));
        const h = Math.max(MIN_EVENT_H, eventDisplayHeight(ev));
        const x = beatToFrac(ev.beat) * r.width;
        if (Math.abs(px - x) <= w / 2 + 3 && Math.abs(py - axisY) <= h / 2 + 3) out.push({ ev, x, y: axisY, w, h });
      }
      // DOM 顺序即为层叠顺序：后面的在上面。这里返回「从上到下」。
      return out.reverse();
    },
    [bar.events, beatToFrac, span],
  );

  const startEventDrag = (ev: BeatEvent, e: React.PointerEvent) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    e.preventDefault();
    const additive = e.ctrlKey || e.metaKey;
    useStore.getState().selectEvent(ev.id, additive);
    if (additive) return;
    let moved = false;
    const onMove = (me: PointerEvent) => {
      moved = true;
      const beatInBar = pointToBeatInBar(me.clientX);
      setDragPreview({ eventId: ev.id, beatInBar: snapBeat(clamp(beatInBar, 0, span.beatCount - 1e-6)) });
    };
    const onUp = (me: PointerEvent) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      if (moved) {
        const beatInBar = snapBeat(clamp(pointToBeatInBar(me.clientX), 0, span.beatCount - 1e-6));
        useStore.getState().moveEvent(ev.id, bar.id, span.startBeat + beatInBar);
      }
      setDragPreview(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  /* ---- 右键滑动批量删除 ---- */
  const [pending, setPending] = useState<Set<string>>(new Set());

  const onContextPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 2) return;
    e.preventDefault();
    e.stopPropagation();
    const marked = new Set<string>();
    const addAt = (cx: number, cy: number) => {
      for (const hit of hitEventsAt(cx, cy)) marked.add(hit.ev.id);
    };
    addAt(e.clientX, e.clientY);
    setPending(new Set(marked));
    const onMove = (me: PointerEvent) => {
      addAt(me.clientX, me.clientY);
      setPending(new Set(marked));
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      setPending(new Set());
      if (marked.size) useStore.getState().removeEvents([...marked]);
    };
    // 挂在 document 上：这样即使指针滑出轨道也能继续扫过更多小节
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  };

  return (
    <div
      className={clsx('bar-row', selected && 'selected', dragging && 'dragging', dropSide === 'before' && 'drop-before', dropSide === 'after' && 'drop-after')}
      data-bar-id={bar.id}
      onDragOver={(e) => {
        if (!dragging && !e.dataTransfer.types.includes('text/plain')) return;
        e.preventDefault();
        const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
        onDragOverSide(e.clientY - r.top < r.height / 2 ? 'before' : 'after');
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropHere();
      }}
    >
      <div className="bar-head">
        <span
          className="drag"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', bar.id);
            onDragStart();
          }}
          title="拖动调整小节顺序"
        >
          ⠿
        </span>
        <span className="no">#{index + 1}</span>
        <span className="meta">
          第 {span.startBeat} – {span.startBeat + span.beatCount} 拍
        </span>
        <span className="meta">{span.beatCount} 拍/小节</span>
        <span className="meta">
          {startSec.toFixed(2)}s – {endSec.toFixed(2)}s
        </span>
        {bar.transform.scaleX < 1 && (
          <span className="badge">
            变换 {(bar.transform.scaleX * 100).toFixed(0)}% / {(bar.transform.offsetX * 100).toFixed(0)}%
          </span>
        )}
        {bar.events.some((e) => conflicts.has(e.id)) && (
          <span className="badge warn" title="强制行进事件的覆盖区间内不能有其它事件">
            存在冲突
          </span>
        )}
        <span className="grow" />
        <button
          className="btn tiny ghost"
          title="在此小节之前插入"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().addBar(index);
          }}
        >
          ＋前
        </button>
        <button
          className="btn tiny ghost"
          title="在此小节之后插入"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().addBar(index + 1);
          }}
        >
          ＋后
        </button>
        <button
          className="btn tiny danger"
          title="删除此小节"
          onClick={(e) => {
            e.stopPropagation();
            useStore.getState().removeBar(bar.id);
          }}
        >
          ✕
        </button>
      </div>

      <div
        className="bar-track"
        ref={trackRef}
        onDoubleClick={(e) => {
          if ((e.target as HTMLElement).closest('.ev')) return;
          const beats: number[] = [];
          const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
          beats.push(snapBeat(pointToBeatInBar(e.clientX)));
          void rect;
          onInsert(beats);
        }}
        onPointerDown={(e) => {
          // 点击轨道背景：选中小节（不改变事件选中状态）
          if (e.button === 0) {
            const hits = hitEventsAt(e.clientX, e.clientY);
            if (!hits.length) {
              useStore.getState().selectBar(bar.id);
              useStore.getState().clearEventSelection();
              lastHitRef.current = null;
            }
          }
          onContextPointerDown(e);
        }}
        title="双击插入事件 · 点击背景选中小节 · 按住右键滑动批量删除"
      >
        {/* 主轴 */}
        <div className="axis-line" />
        {/* 拍刻度 */}
        {layout.beats.map((b) => {
          const cx = (b.cellLeft + b.cellWidth / 2) * 100;
          return (
            <div key={b.index} className="beat-tick" style={{ left: `${cx}%` }}>
              <span className="num">{b.index + 1}</span>
            </div>
          );
        })}

        {/* 强制行进覆盖区 */}
        {bar.events
          .filter((e) => e.type === 'force')
          .map((e) => {
            const { from, to } = forceSpanBeats(span, e);
            const x0 = beatToFrac(span.startBeat + from) * 100;
            const x1 = beatToFrac(span.startBeat + to) * 100;
            return (
              <div
                key={`band-${e.id}`}
                className={clsx('force-band', conflicts.has(e.id) && 'conflict', pending.has(e.id) && 'pending')}
                style={{ left: `${x0}%`, width: `${Math.max(0.4, x1 - x0)}%` }}
              />
            );
          })}

        {/* 事件 */}
        {bar.events.map((ev) => {
          const beat = dragPreview && dragPreview.eventId === ev.id ? span.startBeat + dragPreview.beatInBar : ev.beat;
          if (beat < span.startBeat - 1e-9 || beat >= span.startBeat + span.beatCount - 1e-9) return null;
          const frac = beatToFrac(beat);
          const isChar = ev.type === 'char';
          const isSelected = selectedSet.has(ev.id);
          const isPending = pending.has(ev.id);
          const label = isChar ? '' : eventLabel(ev);
          const colors = iconColors(ev);
          return (
            <div key={ev.id} className="ev-wrap">
              <div
                className={clsx('ev', iconClass(ev.type), isSelected && 'selected', conflicts.has(ev.id) && 'conflict', isPending && 'pending')}
                style={{
                  left: `${frac * 100}%`,
                  top: TRACK_AXIS_Y,
                  width: Math.max(MIN_EVENT_W, eventDisplayWidth(ev)),
                  height: Math.max(MIN_EVENT_H, eventDisplayHeight(ev)),
                  background: colors.length > 1 ? `linear-gradient(180deg, ${colors.join(',')})` : colors[0],
                }}
                onPointerDown={(e) => {
                  // 同一位置反复点击 → 在重叠事件之间循环（逻辑在 core/eventHit.ts，有单元测试）
                  const hits = hitEventsAt(e.clientX, e.clientY);
                  const rects = hits.map((h) => ({ id: h.ev.id, x: h.x, y: h.y, width: h.w, height: h.h }));
                  const decision = resolveClick(
                    rects,
                    lastHitRef.current,
                    e.clientX,
                    e.clientY,
                    e.ctrlKey || e.metaKey,
                    selectedSet.has(ev.id) ? ev.id : (selectedSet.values().next().value ?? null),
                  );
                  if (!decision) return;
                  lastHitRef.current = { x: e.clientX, y: e.clientY, cycle: decision.cycle };
                  if (decision.sendToBackId) {
                    // 把上一次选中的那个送到最下层，再选中下一个
                    const backId = decision.sendToBackId;
                    useStore.getState().commit('调整事件层叠顺序', (d) => {
                      const target = d.bars.find((b) => b.id === bar.id);
                      if (!target) return;
                      target.events = sendToBack(target.events, backId);
                    });
                    useStore.getState().selectEvent(decision.selectedId);
                    return;
                  }
                  startEventDrag(ev, e);
                }}
                title={`${EVENT_META[ev.type].label}｜第 ${(ev.beat - span.startBeat + 1).toFixed(2)} 拍｜拖动移动，右键滑动批量删除`}
              >
                <EventGlyph type={ev.type} size={13} color="#08111c" />
              </div>
              {label && (
                <div className="ev-label" style={{ left: `${frac * 100}%`, top: TRACK_AXIS_Y - 34 }}>
                  {label}
                </div>
              )}
              {isChar && <CharTextPreview ev={ev} leftPct={frac * 100} />}
            </div>
          );
        })}

        {/* 播放头 */}
        {inBar && <div className="playhead" style={{ left: `${playheadFrac * 100}%` }} />}
      </div>
    </div>
  );
}

/** 轨道里主轴所在的纵向位置（px，相对轨道顶部） */
const TRACK_AXIS_Y = 22;

function CharTextPreview({ ev, leftPct }: { ev: BeatEvent; leftPct: number }) {
  if (ev.type !== 'char') return null;
  const lines = (ev.data as { lines: { spans: { text: string; style?: { colors?: string[]; bold?: boolean } }[] }[] }).lines;
  return (
    <div className="ev-text" style={{ left: `${leftPct}%`, top: TRACK_AXIS_Y + 18 }}>
      {lines.map((l, i) => (
        <div key={i}>
          {l.spans.map((s, k) => {
            const cols = s.style?.colors;
            const style: React.CSSProperties = {
              fontWeight: s.style?.bold ? 700 : 400,
            };
            if (cols && cols.length > 1) {
              style.backgroundImage = `linear-gradient(180deg, ${cols.join(',')})`;
              style.WebkitBackgroundClip = 'text';
              style.backgroundClip = 'text';
              style.color = 'transparent';
            } else if (cols && cols.length === 1) {
              style.color = cols[0];
            }
            return (
              <span key={k} style={style}>
                {s.text || ' '}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 事件显示尺寸与颜色                                                  */
/* ------------------------------------------------------------------ */

function eventDisplayWidth(ev: BeatEvent): number {
  if (ev.type === 'char') return (ev.data as { width: number }).width;
  if (ev.type === 'force') return 26;
  return 20;
}

function eventDisplayHeight(ev: BeatEvent): number {
  if (ev.type === 'char') return 30 * (ev.data as { heightScale: number }).heightScale;
  if (ev.type === 'force') return 32;
  return 28;
}

function iconColors(ev: BeatEvent): string[] {
  if (ev.type === 'char') {
    const c = (ev.data as { colors?: string[] }).colors;
    return c && c.length ? c : ['#4ea1ff'];
  }
  switch (ev.type) {
    case 'bpm':
      return ['#ffb020', '#ff8a3d'];
    case 'pause':
      return ['#ffe066', '#ffc93c'];
    case 'force':
      return ['#b388ff', '#8b5cf6'];
    case 'lrcPrev':
    case 'lrcNext':
      return ['#5ee6b0', '#2fbf85'];
    default:
      return ['#ff8fa3', '#f2557a'];
  }
}

function iconClass(type: BeatEventType): string {
  if (type === 'char') return 'c-char';
  if (type === 'force') return 'c-force';
  if (type === 'bpm') return 'c-bpm';
  if (type === 'pause') return 'c-pause';
  if (type.startsWith('lrcTemp')) return 'c-temp';
  return 'c-lrc';
}

function eventLabel(ev: BeatEvent): string {
  switch (ev.type) {
    case 'bpm':
      return `bpm=${(ev.data as { bpm: number }).bpm}`;
    case 'pause':
      return `${(ev.data as { ms: number }).ms}ms`;
    case 'force':
      return `${(ev.data as { ms: number }).ms}ms`;
    case 'lrcPrev':
    case 'lrcNext':
      return `LRC→${(ev.data as { offset: number }).offset}`;
    case 'lrcTempStart':
      return `LRC+${(ev.data as { index: number }).index}`;
    case 'lrcTempEnd':
      return `LRC-${(ev.data as { index: number }).index}`;
    default:
      return '';
  }
}
