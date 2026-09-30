/**
 * 属性检查器
 *
 * 职责划分（对应需求：小节与事件的选中状态分开）
 *  - 只选中**小节**：显示小节自身的属性（拍数、时间轴变换）。
 *  - 只选中**事件**：显示该事件的属性（位置、吸附、类型、各类型参数）。
 *  - 两者都选中：两个分组同时显示。
 *  - 什么都没选：提示如何选中。
 *
 * 「时间轴变换」的语义
 * ──────────────────
 * 把某小节的拍数从 8 改成 4 后，每拍刻度之间的间距会变成 2 倍。
 * 此时设置缩放 50% + 位置 25%，就能让整条时间轴居中，
 * 且相邻刻度的间距与其它小节一致。无论怎么设置都不会超出横向范围。
 */

import type { Bar, BeatEvent, BeatEventType } from '../../model/model';
import { EVENT_META, SNAP_DIVISIONS } from '../../model/model';
import { useStore } from '../../state/store';
import { Field, NumberInput, Section, Slider, Toggle, Empty } from './common';
import { RichLineEditor } from './RichLineEditor';
import { ColorStackEditor } from './ColorStackEditor';

/* ------------------------------------------------------------------ */
/* 入口                                                                */
/* ------------------------------------------------------------------ */

export function BarInspector() {
  const project = useStore((s) => s.project);
  const selectedBarId = useStore((s) => s.selectedBarId);
  const selectedEventIds = useStore((s) => s.selectedEventIds);

  const barIndex = project.bars.findIndex((b) => b.id === selectedBarId);
  const bar: Bar | null = barIndex >= 0 ? project.bars[barIndex] : null;

  // 事件所属小节：事件可能不属于「当前选中的小节」，因此单独查
  const selectedEventId = selectedEventIds[0] ?? null;
  let eventBar: { bar: Bar; barIndex: number } | null = null;
  if (selectedEventId) {
    for (let i = 0; i < project.bars.length; i++) {
      if (project.bars[i].events.some((e) => e.id === selectedEventId)) {
        eventBar = { bar: project.bars[i], barIndex: i };
        break;
      }
    }
  }
  const event = eventBar?.bar.events.find((e) => e.id === selectedEventId) ?? null;

  if (!bar && !event) {
    return (
      <div className="panel-foot">
        <Empty>
          点击小节背景选中小节，点击事件图标选中事件。
          <br />
          <span className="hint">
            按住右键在小节内滑动 = 批量删除扫过的事件；Ctrl+点击 = 多选；Ctrl+C / Ctrl+V = 复制粘贴。
          </span>
        </Empty>
      </div>
    );
  }

  const startBeatOf = (barIdx: number) => {
    let acc = 0;
    for (let i = 0; i < barIdx; i++) acc += project.bars[i].beatCount;
    return acc;
  };

  return (
    <div className="panel-foot" style={{ maxHeight: '52%', overflow: 'auto' }}>
      {event && eventBar && (
        <Section title={`事件：${EVENT_META[event.type].label}（第 ${eventBar.barIndex + 1} 小节）`}>
          {selectedEventIds.length > 1 && (
            <div className="hint" style={{ marginBottom: 6 }}>
              已选中 {selectedEventIds.length} 个事件（只编辑第一个）。
            </div>
          )}
          <EventInspector
            barId={eventBar.bar.id}
            event={event}
            startBeat={startBeatOf(eventBar.barIndex)}
            beatCount={eventBar.bar.beatCount}
          />
        </Section>
      )}

      {bar && (
        <Section title={`小节 #${barIndex + 1}`}>
          <BarProperties bar={bar} barIndex={barIndex} />
        </Section>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 小节属性                                                            */
/* ------------------------------------------------------------------ */

function BarProperties({ bar, barIndex }: { bar: Bar; barIndex: number }) {
  const project = useStore((s) => s.project);
  const startBeat = (() => {
    let acc = 0;
    for (let i = 0; i < barIndex; i++) acc += project.bars[i].beatCount;
    return acc;
  })();

  const sameAsDefault = bar.beatCount === project.timeline.beatsPerNewBar;

  return (
    <>
      <Field label="节拍数">
        <div className="row" style={{ width: '100%', gap: 4 }}>
          <button className="btn tiny" onClick={() => useStore.getState().setBarBeatCount(bar.id, bar.beatCount - 1)}>
            −
          </button>
          <NumberInput value={bar.beatCount} min={1} max={256} onChange={(v) => useStore.getState().setBarBeatCount(bar.id, v)} />
          <button className="btn tiny" onClick={() => useStore.getState().setBarBeatCount(bar.id, bar.beatCount + 1)}>
            ＋
          </button>
          <button
            className="btn tiny"
            disabled={sameAsDefault}
            title={`设为新增小节的默认拍数（${project.timeline.beatsPerNewBar}）`}
            onClick={() => useStore.getState().setBarBeatCount(bar.id, project.timeline.beatsPerNewBar)}
          >
            默认值
          </button>
        </div>
      </Field>
      <div className="hint">
        拍号范围：第 {startBeat} – {startBeat + bar.beatCount} 拍。每个小节的拍数各自保存，
        改动「新增小节时每小节节拍数」不会影响已有小节。
      </div>

      <div className="section-title" style={{ marginTop: 10 }}>
        <span>时间轴变换</span>
        <span className="line" />
      </div>
      <Field label="宽度缩放">
        <Slider
          value={bar.transform.scaleX}
          min={0.05}
          max={1}
          step={0.01}
          onChange={(v) =>
            useStore.getState().setBarTransform(bar.id, { scaleX: v, offsetX: Math.min(bar.transform.offsetX, 1 - v) })
          }
          format={(v) => `${(v * 100).toFixed(0)}%`}
        />
      </Field>
      <Field label="横向位置">
        <Slider
          value={bar.transform.offsetX}
          min={0}
          max={Math.max(0.01, 1 - bar.transform.scaleX)}
          step={0.005}
          onChange={(v) => useStore.getState().setBarTransform(bar.id, { offsetX: v })}
          format={(v) => `${(v * 100).toFixed(1)}%`}
        />
      </Field>
      <div className="row" style={{ gap: 5, marginTop: 2 }}>
        <button
          className="btn tiny"
          title="按当前小节拍数自动计算：让刻度间距与默认拍数一致并居中"
          onClick={() => {
            const target = project.timeline.beatsPerNewBar / Math.max(1, bar.beatCount);
            const scaleX = Math.min(1, Math.max(0.05, target));
            useStore.getState().setBarTransform(bar.id, { scaleX, offsetX: (1 - scaleX) / 2 });
          }}
        >
          自动对齐 + 居中
        </button>
        <button
          className="btn tiny"
          disabled={bar.transform.scaleX === 1 && bar.transform.offsetX === 0}
          onClick={() => useStore.getState().setBarTransform(bar.id, { scaleX: 1, offsetX: 0 })}
        >
          复位
        </button>
      </div>
      <div className="hint">
        例：本小节 4 拍、默认 8 拍时点「自动对齐 + 居中」会把缩放设为 50%、位置 25%，
        刻度间距与其它小节一致且整条居中。
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* 事件属性                                                            */
/* ------------------------------------------------------------------ */

function EventInspector({
  barId,
  event,
  startBeat,
  beatCount,
}: {
  barId: string;
  event: BeatEvent;
  startBeat: number;
  beatCount: number;
}) {
  const project = useStore((s) => s.project);
  const update = (recipe: (ev: BeatEvent) => void) => useStore.getState().updateEvent(barId, event.id, recipe);

  const beatInBar = event.beat - startBeat; // 0 基
  const isCustom = !event.snap || event.snap <= 0;
  const divisor = isCustom ? project.timeline.customSnap : event.snap;

  return (
    <>
      <div className="row" style={{ gap: 6 }}>
        <div style={{ flex: 1 }}>
          <Field label="小节内拍">
            <NumberInput
              value={round3(beatInBar + 1)}
              min={1}
              max={beatCount}
              step={0.25}
              onChange={(v) => update((ev) => void (ev.beat = startBeat + clampBeat(v - 1, beatCount)))}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="范围">
            <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
              第 {startBeat} – {startBeat + beatCount} 拍
            </span>
          </Field>
        </div>
      </div>

      <Field label="吸附">
        <div className="row" style={{ width: '100%', gap: 6 }}>
          <select
            className="input"
            style={{ flex: 1 }}
            value={isCustom ? 'custom' : `p${divisor}`}
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'custom') update((ev) => void (ev.snap = 0));
              else update((ev) => void (ev.snap = Number(v.slice(1))));
            }}
          >
            {SNAP_DIVISIONS.map((d) => (
              <option key={d} value={`p${d}`}>
                1/{d} 拍
              </option>
            ))}
            <option value="custom">自定义 1/N</option>
          </select>
          {isCustom && (
            <>
              <NumberInput
                value={project.timeline.customSnap}
                min={2}
                max={256}
                step={1}
                width={76}
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

      <Field label="类型">
        <select
          className="input"
          value={event.type}
          onChange={(e) => {
            const next = e.target.value as BeatEventType;
            useStore.getState().removeEvent(barId, event.id);
            useStore.getState().addEvent(barId, next, event.beat);
          }}
        >
          {(Object.keys(EVENT_META) as BeatEventType[]).map((t) => (
            <option key={t} value={t}>
              {EVENT_META[t].label}
            </option>
          ))}
        </select>
      </Field>

      {event.type === 'char' && <CharEventEditor barId={barId} event={event} />}

      {event.type === 'bpm' && (
        <Field label="新 BPM">
          <NumberInput
            value={(event.data as { bpm: number }).bpm}
            min={1}
            max={1000}
            step={1}
            onChange={(v) => update((ev) => void ((ev.data as { bpm: number }).bpm = v))}
          />
        </Field>
      )}

      {event.type === 'pause' && (
        <Field label="暂停">
          <NumberInput
            value={(event.data as { ms: number }).ms}
            min={0}
            max={60000}
            step={10}
            suffix="ms"
            onChange={(v) => update((ev) => void ((ev.data as { ms: number }).ms = v))}
          />
        </Field>
      )}

      {event.type === 'force' && (
        <>
          <Field label="覆盖长度">
            <NumberInput
              value={(event.data as { lengthBeats: number }).lengthBeats}
              min={0.01}
              max={beatCount - (event.beat - startBeat)}
              step={0.25}
              suffix="拍"
              onChange={(v) =>
                update((ev) => {
                  const max = beatCount - (ev.beat - startBeat);
                  (ev.data as { lengthBeats: number }).lengthBeats = Math.min(v, Math.max(0.01, max));
                })
              }
            />
          </Field>
          <Field label="匀速耗时">
            <NumberInput
              value={(event.data as { ms: number }).ms}
              min={1}
              max={600000}
              step={10}
              suffix="ms"
              onChange={(v) => update((ev) => void ((ev.data as { ms: number }).ms = v))}
            />
          </Field>
          <div className="hint">播放头会在覆盖区间内按这个毫秒数匀速走完，且不能跨小节。</div>
        </>
      )}

      {(event.type === 'lrcPrev' || event.type === 'lrcNext') && (
        <>
          <Field label="偏移块数">
            <NumberInput
              value={(event.data as { offset: number }).offset}
              min={0}
              max={999}
              onChange={(v) => update((ev) => void ((ev.data as { offset: number }).offset = Math.round(v)))}
            />
          </Field>
          <div className="hint">相对当前主歌词块前进 / 后退若干块；越界会自动夹取到首 / 末块。</div>
        </>
      )}

      {(event.type === 'lrcTempStart' || event.type === 'lrcTempEnd') && <TempInspector barId={barId} event={event} />}

      <div className="row" style={{ marginTop: 8, gap: 6 }}>
        <button className="btn tiny" style={{ flex: 1 }} onClick={() => useStore.getState().copySelectedEvents()}>
          复制
        </button>
        <button className="btn tiny danger" style={{ flex: 1 }} onClick={() => useStore.getState().removeEvent(barId, event.id)}>
          删除
        </button>
      </div>
    </>
  );
}

function TempInspector({ barId, event }: { barId: string; event: BeatEvent }) {
  const lines = useStore((s) => s.project.lines);
  const update = (recipe: (ev: BeatEvent) => void) => useStore.getState().updateEvent(barId, event.id, recipe);
  const data = event.data as { index: number; indexMode?: 'zeroBased' | 'fromEnd' };

  return (
    <>
      <Field label="索引方式">
        <Toggle
          value={data.indexMode === 'fromEnd' ? 'fromEnd' : 'zeroBased'}
          options={[
            { value: 'zeroBased', label: '从 0 起' },
            { value: 'fromEnd', label: '从末尾' },
          ]}
          onChange={(v) =>
            update((ev) => void ((ev.data as { indexMode: 'zeroBased' | 'fromEnd' }).indexMode = v as 'zeroBased' | 'fromEnd'))
          }
        />
      </Field>
      <Field label="目标块">
        <NumberInput
          value={data.index}
          min={data.indexMode === 'fromEnd' ? -999 : 0}
          max={data.indexMode === 'fromEnd' ? 0 : 999}
          onChange={(v) => update((ev) => void ((ev.data as { index: number }).index = Math.round(v)))}
        />
      </Field>
      <div className="hint">
        当前共有 {lines.length} 块。
        {data.indexMode === 'fromEnd'
          ? ` 解析为第 ${Math.max(0, Math.min(lines.length - 1, lines.length + data.index)) + 1} 块。`
          : ` 解析为第 ${Math.min(data.index + 1, lines.length)} 块。`}
      </div>
    </>
  );
}

function CharEventEditor({ barId, event }: { barId: string; event: BeatEvent }) {
  const cfg = useStore((s) => s.project.playback.beat);
  const data = event.data as {
    width: number;
    heightScale: number;
    radius: number;
    colors?: string[];
    lines: import('../../model/model').RichLine[];
  };
  const update = (recipe: (ev: BeatEvent) => void) => useStore.getState().updateEvent(barId, event.id, recipe);

  return (
    <>
      <div className="row" style={{ gap: 6 }}>
        <div style={{ flex: 1 }}>
          <Field label="宽">
            <NumberInput
              value={data.width}
              min={2}
              max={200}
              step={1}
              suffix="px"
              onChange={(v) => update((ev) => void ((ev.data as { width: number }).width = v))}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="高倍率">
            <NumberInput
              value={data.heightScale}
              min={1}
              max={6}
              step={0.05}
              onChange={(v) => update((ev) => void ((ev.data as { heightScale: number }).heightScale = v))}
            />
          </Field>
        </div>
        <div style={{ flex: 1 }}>
          <Field label="圆角">
            <NumberInput
              value={data.radius}
              min={0}
              max={40}
              step={0.5}
              onChange={(v) => update((ev) => void ((ev.data as { radius: number }).radius = v))}
            />
          </Field>
        </div>
      </div>

      <ColorStackEditor
        label="图标颜色"
        colors={data.colors}
        fallback="#4ea1ff"
        onChange={(colors) => update((ev) => void ((ev.data as { colors?: string[] }).colors = colors))}
      />

      <div className="section-title" style={{ marginTop: 10 }}>
        <span>歌词字文本</span>
        <span className="line" />
      </div>
      <div className="hint" style={{ marginBottom: 6 }}>
        文本显示在图标正下方居中。每个「行」是一组独立文本（例如上行假名、下行罗马音），
        组内再用分段设置样式。
      </div>
      {data.lines.map((line, i) => (
        <RichLineEditor
          key={line.id}
          line={line}
          onChange={(next) =>
            update((ev) => {
              const d = ev.data as { lines: import('../../model/model').RichLine[] };
              d.lines[i] = next;
            })
          }
          previewFontSize={cfg.textFontSize}
          previewColor={cfg.textColor}
          previewOutlineColor={cfg.textOutlineColor}
          previewRubyScale={cfg.rubyScale}
          previewRubyGap={cfg.rubyGap}
          previewAlign="center"
        />
      ))}
      <div className="row" style={{ gap: 6 }}>
        <button
          className="btn tiny"
          style={{ flex: 1 }}
          onClick={() =>
            update((ev) => {
              const d = ev.data as { lines: import('../../model/model').RichLine[] };
              d.lines.push({ id: `rl_${Math.random().toString(36).slice(2, 9)}`, spans: [{ text: '' }] });
            })
          }
        >
          ＋ 新增一行文本
        </button>
        {data.lines.length > 1 && (
          <button
            className="btn tiny danger"
            onClick={() =>
              update((ev) => {
                const d = ev.data as { lines: import('../../model/model').RichLine[] };
                d.lines.pop();
              })
            }
          >
            删除末行
          </button>
        )}
      </div>
    </>
  );
}

function clampBeat(v: number, upperExclusive: number): number {
  return Math.max(0, Math.min(v, upperExclusive - 1e-6));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}
