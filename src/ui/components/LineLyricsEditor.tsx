/**
 * 逐行歌词编辑区
 *
 * 术语：这里的「行」其实是「块」（block），一个块里可以包含多个子行。
 * 主歌词块只有一块，决定播放时的竖直中心位置与突出显示；
 * 临时行由逐拍歌词里的「临时行开始 / 结束」事件驱动（在播放页与预览中生效）。
 */

import { useMemo, useState } from 'react';
import clsx from 'clsx';
import type { LyricLine } from '../../model/model';
import { createLyricLine } from '../../core/factories';
import { useStore } from '../../state/store';
import { RichLineEditor } from '../components/RichLineEditor';
import { spansToText } from '../../core/richText';
import { EventGlyph } from '../components/EventGlyph';
import { Field, NumberInput, Section, Slider, Toggle } from '../components/common';
import { getPlayback } from '../../playback/controller';

export function LineLyricsEditor() {
  const project = useStore((s) => s.project);
  const selectedLineId = useStore((s) => s.selectedLineId);
  const lrc = getPlayback().lrc;
  const [editing, setEditing] = useState(true);

  const lines = project.lines;
  const selectedIndex = lines.findIndex((l) => l.id === selectedLineId);

  const styleProps = project.playback.lrc;

  return (
    <>
      <div className="tabs">
        <button className={clsx('tab', editing && 'active')} onClick={() => setEditing(true)}>
          编辑
        </button>
        <button className={clsx('tab', !editing && 'active')} onClick={() => setEditing(false)}>
          排版设置
        </button>
        <span style={{ flex: 1 }} />
        <span className="hint" style={{ alignSelf: 'center' }}>
          共 {lines.length} 块
        </span>
      </div>

      {editing ? (
        <>
          <div className="panel-body">
            {lines.length === 0 && (
              <div className="empty">
                还没有逐行歌词。
                <br />
                逐行歌词与逐拍歌词相互独立：逐拍歌词负责发音，逐行歌词负责原文与翻译。
              </div>
            )}
            {lines.map((line, index) => (
              <LineCard
                key={line.id}
                line={line}
                index={index}
                total={lines.length}
                selected={line.id === selectedLineId}
                isMain={index === lrc.mainLine}
                isTemp={lrc.tempLines.includes(index)}
              />
            ))}
          </div>
          <div className="panel-foot">
            <div className="row" style={{ gap: 6 }}>
              <button className="btn" style={{ flex: 1 }} onClick={() => useStore.getState().addLine(selectedLineId)}>
                ＋ 新增块
              </button>
              <button
                className="btn"
                disabled={selectedIndex < 0}
                onClick={() => useStore.getState().duplicateLine(selectedLineId!)}
              >
                复制
              </button>
              <button
                className="btn"
                disabled={selectedIndex <= 0}
                title="上移"
                onClick={() => useStore.getState().moveLine(selectedLineId!, -1)}
              >
                ↑
              </button>
              <button
                className="btn"
                disabled={selectedIndex < 0 || selectedIndex >= lines.length - 1}
                title="下移"
                onClick={() => useStore.getState().moveLine(selectedLineId!, 1)}
              >
                ↓
              </button>
              <button
                className="btn danger"
                disabled={selectedIndex < 0}
                onClick={() => useStore.getState().removeLine(selectedLineId!)}
              >
                删除
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="panel-body">
          <Section title="版式">
            <Field label="字号">
              <Slider
                value={styleProps.fontSize}
                min={10}
                max={120}
                step={1}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.fontSize = v))}
                format={(v) => `${v.toFixed(0)}px`}
              />
            </Field>
            <Field label="行距">
              <Slider
                value={styleProps.lineSpacing}
                min={0.8}
                max={3}
                step={0.01}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.lineSpacing = v))}
              />
            </Field>
            <Field label="对齐">
              <Toggle
                value={styleProps.align}
                options={[
                  { value: 'left', label: '左' },
                  { value: 'center', label: '中' },
                  { value: 'right', label: '右' },
                ]}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.align = v as 'left' | 'center' | 'right'))}
              />
            </Field>
            <Field label="显示行数">
              <div className="row" style={{ gap: 6, width: '100%' }}>
                <span className="hint">上</span>
                <NumberInput
                  value={styleProps.aboveCount}
                  min={0}
                  max={20}
                  onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.aboveCount = Math.round(v)))}
                />
                <span className="hint">下</span>
                <NumberInput
                  value={styleProps.belowCount}
                  min={0}
                  max={20}
                  onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.belowCount = Math.round(v)))}
                />
              </div>
            </Field>
          </Section>

          <Section title="突出显示">
            <Field label="主行放大">
              <Slider
                value={styleProps.mainScale}
                min={0.6}
                max={2.5}
                step={0.01}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.mainScale = v))}
                format={(v) => `${v.toFixed(2)}×`}
              />
            </Field>
            <Field label="主行颜色">
              <input
                type="color"
                value={styleProps.mainColor}
                onChange={(e) => useStore.getState().updatePlayback((d) => void (d.lrc.mainColor = e.target.value))}
              />
            </Field>
            <Field label="普通行颜色">
              <input
                type="color"
                value={styleProps.color}
                onChange={(e) => useStore.getState().updatePlayback((d) => void (d.lrc.color = e.target.value))}
              />
            </Field>
            <Field label="普通行透明">
              <Slider
                value={styleProps.inactiveOpacity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.inactiveOpacity = v))}
              />
            </Field>
            <Field label="临时行透明">
              <Slider
                value={styleProps.tempOpacity}
                min={0}
                max={1}
                step={0.01}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.tempOpacity = v))}
              />
            </Field>
          </Section>

          <Section title="注音 (ruby)">
            <Field label="注音字号">
              <Slider
                value={styleProps.rubyScale}
                min={0.2}
                max={1.2}
                step={0.01}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.rubyScale = v))}
                format={(v) => `${(v * 100).toFixed(0)}%`}
              />
            </Field>
            <Field label="注音间距">
              <Slider
                value={styleProps.rubyGap}
                min={-4}
                max={20}
                step={1}
                onChange={(v) => useStore.getState().updatePlayback((d) => void (d.lrc.rubyGap = v))}
                format={(v) => `${v.toFixed(0)}px`}
              />
            </Field>
          </Section>

          <Section>
            <button className="btn" onClick={() => useStore.getState().setPage('player')}>
              前往播放编辑页调整位置与动画 →
            </button>
          </Section>
        </div>
      )}
    </>
  );
}

function LineCard({
  line,
  index,
  total,
  selected,
  isMain,
  isTemp,
}: {
  line: LyricLine;
  index: number;
  total: number;
  selected: boolean;
  isMain: boolean;
  isTemp: boolean;
}) {
  const lrcCfg = useStore((s) => s.project.playback.lrc);
  const preview = useMemo(() => line.subLines.map((s) => spansToText(s.spans)).join(' / '), [line.subLines]);

  return (
    <div
      className={clsx('list-item', selected && 'selected', isMain && 'is-main')}
      style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4, padding: 9 }}
      onClick={() => useStore.getState().selectLine(line.id)}
    >
      <div className="row" style={{ gap: 6 }}>
        <span className="idx">{index + 1}</span>
        <div className="content" style={{ flex: 1, color: preview ? 'var(--text-1)' : 'var(--text-3)' }}>
          {preview || '（空）'}
        </div>
        {isMain && <span className="badge main">主歌词</span>}
        {isTemp && <span className="badge temp">临时行</span>}
        <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
          {line.subLines.length} 行
        </span>
        <div className="tools">
          <button className="btn tiny ghost" title="上移" onClick={(e) => { e.stopPropagation(); useStore.getState().moveLine(line.id, -1); }}>
            ↑
          </button>
          <button className="btn tiny ghost" title="下移" onClick={(e) => { e.stopPropagation(); useStore.getState().moveLine(line.id, 1); }}>
            ↓
          </button>
          <button className="btn tiny ghost" title="在此后新增" onClick={(e) => { e.stopPropagation(); useStore.getState().addLine(line.id); }}>
            ＋
          </button>
          <button className="btn tiny danger" title="删除" onClick={(e) => { e.stopPropagation(); useStore.getState().removeLine(line.id); }}>
            ✕
          </button>
        </div>
      </div>

      {selected && (
        <div style={{ marginTop: 4 }} onClick={(e) => e.stopPropagation()}>
          {line.subLines.map((sub, i) => (
            <div key={sub.id} className="subline-edit">
              <div className="row" style={{ gap: 6, marginBottom: 2 }}>
                <span className="hint" style={{ fontFamily: 'var(--mono)' }}>
                  第 {i + 1} 行
                </span>
                <span style={{ flex: 1 }} />
                {line.subLines.length > 1 && (
                  <button
                    className="btn tiny danger"
                    title="删除这一行"
                    onClick={() =>
                      useStore.getState().commit('删除子行', (d) => {
                        const target = d.lines[index];
                        if (target) target.subLines.splice(i, 1);
                      })
                    }
                  >
                    删除此行
                  </button>
                )}
              </div>
              <RichLineEditor
                line={sub}
                onChange={(next) =>
                  // 直接编辑当前选中的块，避免「先选中再编辑」的两次点击
                  useStore.getState().commit('编辑逐行歌词', (d) => {
                    const target = d.lines[index];
                    if (target) target.subLines[i] = next;
                  })
                }
                previewFontSize={lrcCfg.fontSize}
                previewColor={lrcCfg.color}
                previewBold={lrcCfg.bold}
                previewOutlineColor={lrcCfg.outlineColor}
                previewRubyScale={lrcCfg.rubyScale}
                previewRubyGap={lrcCfg.rubyGap}
                previewAlign={lrcCfg.align}
              />
            </div>
          ))}
          <div className="row" style={{ gap: 6 }}>
            <button
              className="btn tiny"
              onClick={() =>
                useStore.getState().commit('新增子行', (d) => {
                  const target = d.lines[index];
                  target?.subLines.push({ id: `rl_${Math.random().toString(36).slice(2, 9)}`, spans: [{ text: '' }] });
                })
              }
            >
              ＋ 子行
            </button>
            <span className="hint">第 {(index + 1).toString()} / {total} 块</span>
            <span style={{ flex: 1 }} />
            <span className="hint">
              去播放页可设置位置、行距与突出显示；临时行由逐拍歌词的
              <EventGlyph type="lrcTempStart" size={11} />
              <EventGlyph type="lrcTempEnd" size={11} />
              事件驱动
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export { createLyricLine };
