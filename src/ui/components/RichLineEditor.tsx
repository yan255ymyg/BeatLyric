/**
 * 富文本行编辑器（v2）
 *
 * 设计取舍（按需求调整）
 * ────────────────────
 *  - **没有「整体文本」输入框**：要表达一整段文本时，只用一个分段即可。
 *    这样「整体」与「分段」的关系不再暧昧 —— 数据里只有分段，没有第二套来源。
 *  - **没有「整体样式」**：全部样式都挂在分段上。
 *  - 颜色用**颜色栈**：1 个颜色 = 纯色，多个颜色 = 自上而下渐变。
 *    通过「添加颜色 / 删除颜色」操作，不再有「纯色 ↔ 渐变」的模式切换。
 *  - 不允许换行（一个分段就是一行文本）；输入换行符会被直接过滤掉。
 *  - 顶部有**行内实时预览**，使用与播放画面完全相同的绘制代码。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import type { RichLine, SpanStyle } from '../../model/model';
import { uid } from '../../core/util';
import { drawRichLine, measureRichLine, measureRichLineHeight } from '../../render/richTextRenderer';
import { prepareCanvas } from '../../render/canvasKit';
import { spansToText } from '../../core/richText';

export interface RichLineEditorProps {
  line: RichLine;
  onChange: (next: RichLine) => void;
  /** 紧凑模式（用于逐拍歌词的歌词字文本）：隐藏预览与部分控件 */
  compact?: boolean;
  placeholder?: string;
  /** 预览时使用的基准字号 */
  previewFontSize?: number;
  /** 预览时使用的默认颜色 */
  previewColor?: string;
  previewBold?: boolean;
  previewRubyScale?: number;
  previewRubyGap?: number;
  previewOutlineColor?: string;
  previewAlign?: 'left' | 'center' | 'right';
}

const GRADIENT_PRESETS: { label: string; colors: string[] }[] = [
  { label: '黄→绿', colors: ['#ffd93d', '#36d399'] },
  { label: '青→紫', colors: ['#4ea1ff', '#a06bff'] },
  { label: '白→蓝', colors: ['#ffffff', '#4ea1ff'] },
  { label: '橙→红', colors: ['#ffb020', '#ff3b5c'] },
  { label: '三色', colors: ['#ffd93d', '#36d399', '#4ea1ff'] },
];

function sanitizeSingleLine(value: string): string {
  return value.replace(/[\r\n\u2028\u2029]+/g, ' ');
}

export function RichLineEditor({
  line,
  onChange,
  compact,
  placeholder,
  previewFontSize = 26,
  previewColor = '#dbe6f5',
  previewBold = false,
  previewRubyScale = 0.55,
  previewRubyGap = 2,
  previewOutlineColor = '#0b1018',
  previewAlign = 'center',
}: RichLineEditorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [activeSpan, setActiveSpan] = useState(0);

  const spans = line.spans;
  const plain = useMemo(() => spansToText(spans), [spans]);

  /* ---------------- 行内实时预览 ---------------- */
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || compact) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = canvas.clientWidth || 320;
    const fontSize = previewFontSize;
    const lineH = measureRichLineHeight(line, { fontSize, rubyScale: previewRubyScale, rubyGap: previewRubyGap });
    const boxH = Math.max(34, lineH + 14);

    const ctx = prepareCanvas(canvas, cssW, boxH, dpr);
    const m = ctx.getTransform();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(m);

    const anchorX = previewAlign === 'center' ? cssW / 2 : previewAlign === 'right' ? cssW - 10 : 10;
    drawRichLine(ctx, line, {
      baseline: boxH / 2 + fontSize * 0.35,
      anchorX,
      align: previewAlign,
      fontSize,
      color: previewColor,
      bold: previewBold,
      outlineWidth: 0,
      outlineColor: previewOutlineColor,
      rubyScale: previewRubyScale,
      rubyGap: previewRubyGap,
    });
  }, [line, compact, previewFontSize, previewColor, previewBold, previewRubyScale, previewRubyGap, previewOutlineColor, previewAlign]);

  /* ---------------- 分段操作 ---------------- */

  const updateSpan = (index: number, recipe: (span: { text: string; style?: SpanStyle }) => void) => {
    const next = spans.map((s, i) => {
      if (i !== index) return { ...s, style: s.style ? { ...s.style } : undefined };
      const copy = { text: s.text, style: s.style ? { ...s.style } : undefined };
      recipe(copy);
      if (copy.style && Object.keys(copy.style).length === 0) copy.style = undefined;
      return copy;
    });
    onChange({ ...line, spans: next });
  };

  const setStyle = (index: number, patch: Partial<SpanStyle>) => {
    updateSpan(index, (span) => {
      const style: SpanStyle = { ...(span.style ?? {}) };
      (Object.keys(patch) as (keyof SpanStyle)[]).forEach((k) => {
        const v = patch[k];
        if (v === undefined || v === null) delete style[k];
        else (style as Record<string, unknown>)[k as string] = v;
      });
      span.style = Object.keys(style).length ? style : undefined;
    });
  };

  const addSpanAfter = (index: number) => {
    const next = [...spans];
    next.splice(index + 1, 0, { text: '' });
    onChange({ ...line, spans: next });
    setActiveSpan(index + 1);
  };

  const removeSpan = (index: number) => {
    if (spans.length <= 1) {
      onChange({ ...line, spans: [{ text: '' }] });
      return;
    }
    const next = spans.filter((_, i) => i !== index);
    onChange({ ...line, spans: next });
    setActiveSpan(Math.max(0, Math.min(index, next.length - 1)));
  };

  const splitAtCursor = (index: number) => {
    const el = document.activeElement as HTMLInputElement | null;
    if (!el || el.tagName !== 'INPUT') return;
    const pos = el.selectionStart ?? el.value.length;
    const span = spans[index];
    const head = span.text.slice(0, pos);
    const tail = span.text.slice(pos);
    const next = [...spans];
    next.splice(index, 1, { text: head, style: span.style }, { text: tail, style: span.style ? { ...span.style } : undefined });
    onChange({ ...line, spans: next });
    setActiveSpan(index + 1);
  };

  return (
    <div style={{ marginBottom: compact ? 6 : 10 }}>
      {/* 行内实时预览 */}
      {!compact && (
        <div className="rich-preview" title="实时预览（与播放画面使用同一绘制代码）">
          <canvas ref={canvasRef} style={{ width: '100%', display: 'block' }} />
          {!plain && <div className="hint" style={{ padding: '0 0 4px 8px' }}>（空）</div>}
        </div>
      )}

      {/* 分段列表 */}
      <div className={compact ? '' : 'segments'}>
        {spans.map((span, i) => {
          const style = span.style ?? {};
          const colors = style.colors && style.colors.length ? style.colors : [undefined as unknown as string];
          const active = i === activeSpan;
          return (
            <div
              key={i}
              className={clsx('segment', active && !compact && 'active')}
              onFocus={() => setActiveSpan(i)}
              onMouseDown={() => setActiveSpan(i)}
            >
              <div className="row" style={{ gap: 4, marginBottom: 4 }}>
                <input
                  className="input"
                  style={{ flex: 1, minWidth: 40 }}
                  placeholder={placeholder ?? (i === 0 ? '输入这一段的文本（不支持换行）' : '下一段文本…')}
                  value={span.text}
                  onChange={(e) => {
                    const v = sanitizeSingleLine(e.target.value);
                    updateSpan(i, (s) => void (s.text = v));
                  }}
                  onKeyDown={(e) => {
                    // 阻止换行：回车不产生新行
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      addSpanAfter(i);
                    }
                  }}
                />
                <button className="btn tiny" title="在此分段后再加一段" onClick={() => addSpanAfter(i)}>
                  ＋
                </button>
                <button
                  className="btn tiny"
                  title="在光标处切分为两段"
                  onClick={() => {
                    setActiveSpan(i);
                    splitAtCursor(i);
                  }}
                >
                  ⧉
                </button>
                <button
                  className="btn tiny danger"
                  title={spans.length <= 1 ? '清空这一段' : '删除这一段'}
                  onClick={() => removeSpan(i)}
                >
                  ✕
                </button>
              </div>

              {/* 样式：全部集中在分段里 */}
              <div className="seg-style">
                <button
                  className={clsx('btn tiny', style.bold && 'active')}
                  title="粗体"
                  onClick={() => setStyle(i, { bold: style.bold ? undefined : true })}
                  style={{ fontWeight: 700 }}
                >
                  B
                </button>
                <button
                  className={clsx('btn tiny', style.italic && 'active')}
                  title="斜体"
                  onClick={() => setStyle(i, { italic: style.italic ? undefined : true })}
                  style={{ fontStyle: 'italic' }}
                >
                  I
                </button>

                {/* 颜色栈 */}
                <span className="hint" style={{ marginLeft: 4 }}>
                  颜色
                </span>
                {colors.map((c, ci) => (
                  <span key={ci} className="row" style={{ gap: 1 }}>
                    <input
                      type="color"
                      title={colors.length > 1 ? `渐变第 ${ci + 1} 个色标` : '纯色'}
                      value={c ?? previewColor}
                      onChange={(e) => {
                        const next = [...(style.colors ?? [previewColor])];
                        next[ci] = e.target.value;
                        setStyle(i, { colors: next });
                      }}
                    />
                    {colors.length > 1 && (
                      <button
                        className="btn tiny ghost"
                        title="删除这个色标"
                        style={{ padding: '0 3px' }}
                        onClick={() => {
                          const next = [...(style.colors ?? [])];
                          next.splice(ci, 1);
                          setStyle(i, { colors: next.length ? next : undefined });
                        }}
                      >
                        −
                      </button>
                    )}
                  </span>
                ))}
                <button
                  className="btn tiny"
                  title="添加一个色标（多于 1 个颜色即为渐变色）"
                  onClick={() => {
                    const cur = style.colors ?? [previewColor];
                    setStyle(i, { colors: [...cur, cur[cur.length - 1]] });
                  }}
                >
                  ＋色
                </button>
                <select
                  className="input"
                  style={{ width: 74, flexShrink: 0 }}
                  value=""
                  title="渐变色预设"
                  onChange={(e) => {
                    const preset = GRADIENT_PRESETS.find((p) => p.label === e.target.value);
                    if (preset) setStyle(i, { colors: [...preset.colors] });
                  }}
                >
                  <option value="">预设…</option>
                  {GRADIENT_PRESETS.map((p) => (
                    <option key={p.label} value={p.label}>
                      {p.label}
                    </option>
                  ))}
                </select>
                {style.colors && (
                  <button className="btn tiny ghost" title="清除颜色（用整体默认色）" onClick={() => setStyle(i, { colors: undefined })}>
                    ⊘
                  </button>
                )}

                {/* ruby 注音 */}
                <input
                  className="input"
                  style={{ width: 78, flexShrink: 0 }}
                  placeholder="ruby"
                  title="注音：显示在这段文字上方"
                  value={style.ruby ?? ''}
                  onChange={(e) => setStyle(i, { ruby: e.target.value ? sanitizeSingleLine(e.target.value) : undefined })}
                />

                {/* 字号（相对基准的百分比） */}
                <input
                  className="input num"
                  style={{ width: 54, flexShrink: 0 }}
                  title="字号（占基准字号的百分比，留空为 100%）"
                  placeholder="100"
                  value={style.fontSize ?? ''}
                  onChange={(e) => {
                    const v = Number(e.target.value);
                    setStyle(i, { fontSize: Number.isFinite(v) && v > 0 ? Math.round(v) : undefined });
                  }}
                />
                <span className="hint" style={{ flexShrink: 0 }}>
                  %
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {!compact && (
        <div className="row" style={{ marginTop: 4, gap: 6 }}>
          <button
            className="btn tiny"
            onClick={() => {
              // 「一整段文本」= 只有一个分段
              onChange({ ...line, spans: [{ text: plain, style: spans.length === 1 ? spans[0].style : undefined }] });
              setActiveSpan(0);
            }}
            title="合并成一个分段（等价于「一整段文本」）"
          >
            合并为一段
          </button>
          <button
            className="btn tiny ghost"
            onClick={() => {
              onChange({ ...line, spans: [{ text: '' }] });
              setActiveSpan(0);
            }}
          >
            清空
          </button>
          <span style={{ flex: 1 }} />
          <span className="hint">
            {spans.length} 段 · 宽 {Math.round(measureRichLine(line, { fontSize: previewFontSize }))}px
          </span>
        </div>
      )}
    </div>
  );
}

export { uid };
