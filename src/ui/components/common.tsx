/** 通用小组件：字段、滑块、色板、颜色选择、位置编辑器、模态框 */

import { useEffect, useRef, useState, type ReactNode } from 'react';
import clsx from 'clsx';
import type { Gradient } from '../../model/model';

export function Section({ title, children, right }: { title?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <div className="section">
      {title && (
        <div className="section-title">
          <span>{title}</span>
          <span className="line" />
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Field({ label, children, stack }: { label: string; children: ReactNode; stack?: boolean }) {
  return (
    <div className={clsx('field', stack && 'stack')}>
      <label>{label}</label>
      <div className="field-input">{children}</div>
    </div>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  step = 1,
  suffix,
  width,
  title,
  compact,
}: {
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
  suffix?: string;
  width?: number;
  title?: string;
  /** 紧凑模式：用于和滑块并排，宽度自适应 */
  compact?: boolean;
}) {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    if (!editing) setText(formatNumber(value));
  }, [value, editing]);

  return (
    <div
      className="row"
      style={{ width: width ? `${width}px` : compact ? undefined : '100%', flex: compact ? 1 : undefined, gap: 4, minWidth: compact ? 46 : undefined }}
    >
      <input
        className="input num"
        title={title}
        value={text}
        onFocus={() => setEditing(true)}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          setEditing(false);
          const v = Number(text);
          if (Number.isFinite(v)) {
            const clamped = clampMaybe(v, min, max);
            onChange(clamped);
            setText(formatNumber(clamped));
          } else {
            setText(formatNumber(value));
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
            e.preventDefault();
            const delta = (e.key === 'ArrowUp' ? 1 : -1) * step * (e.shiftKey ? 10 : 1);
            const next = clampMaybe((Number(text) || 0) + delta, min, max);
            setText(formatNumber(next));
            onChange(next);
          }
        }}
      />
      {suffix && (
        <span className="hint" style={{ flexShrink: 0 }}>
          {suffix}
        </span>
      )}
    </div>
  );
}

function clampMaybe(v: number, min?: number, max?: number): number {
  let out = v;
  if (min !== undefined) out = Math.max(min, out);
  if (max !== undefined) out = Math.min(max, out);
  return out;
}

function formatNumber(v: number): string {
  if (!Number.isFinite(v)) return '0';
  const rounded = Math.round(v * 1000) / 1000;
  return String(rounded);
}

/**
 * 滑块 + 数值输入框。
 * 需求要求「滑块一定要提供输入框直接输入」，因此两者始终成对出现。
 * compact 模式用在小面板里：滑块与输入框并排，输入框宽度固定。
 */
export function Slider({
  value,
  min,
  max,
  step = 0.01,
  onChange,
  format,
  inputWidth = 62,
  integer,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
  format?: (v: number) => string;
  inputWidth?: number;
  integer?: boolean;
}) {
  return (
    <div className="slider-row">
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <NumberInput
        value={value}
        min={min}
        max={max}
        step={step}
        width={inputWidth}
        onChange={(v) => onChange(integer ? Math.round(v) : v)}
        title={format ? format(value) : undefined}
      />
    </div>
  );
}

export function Checkbox({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <label className="row" style={{ cursor: 'pointer', gap: 7, userSelect: 'none' }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span style={{ color: 'var(--text-1)' }}>{label}</span>
    </label>
  );
}

export function Toggle({
  value,
  options,
  onChange,
}: {
  value: string;
  options: { value: string; label: string; title?: string }[];
  onChange: (v: string) => void;
}) {
  return (
    <div className="snap-group">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          title={o.title}
          className={clsx(value === o.value && 'active')}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function ColorField({
  value,
  onChange,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      <div className="field-input">
        <input type="color" value={toHex6(value)} onChange={(e) => onChange(e.target.value)} />
        <input className="input" style={{ width: 90 }} value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
    </div>
  );
}

/** 纯色 / 上下渐变 二选一（用于画布背景、主轴填充、刻度填充这类「整块」的填充） */
export function ColorOrGradient({
  label = '填充',
  color,
  gradient,
  onChange,
}: {
  label?: string;
  color?: string;
  gradient?: Gradient;
  onChange: (v: { color?: string; gradient?: Gradient }) => void;
}) {
  const mode = gradient ? 'gradient' : 'solid';
  return (
    <div>
      <Field label={label}>
        <Toggle
          value={mode}
          options={[
            { value: 'solid', label: '纯色' },
            { value: 'gradient', label: '上下渐变' },
          ]}
          onChange={(m) => {
            if (m === 'solid') onChange({ color: color ?? gradient?.from ?? '#4ea1ff' });
            else onChange({ gradient: { from: color ?? '#ffd93d', to: '#36d399' } });
          }}
        />
      </Field>
      {mode === 'solid' ? (
        <div className="field">
          <label>颜色</label>
          <div className="field-input">
            <input type="color" value={toHex6(color ?? '#4ea1ff')} onChange={(e) => onChange({ color: e.target.value })} />
            <input className="input" style={{ width: 86 }} value={color ?? ''} onChange={(e) => onChange({ color: e.target.value })} />
          </div>
        </div>
      ) : (
        <div className="row" style={{ gap: 6 }}>
          <div style={{ flex: 1 }}>
            <Field label="上色">
              <input
                type="color"
                value={toHex6(gradient?.from ?? '#ffd93d')}
                onChange={(e) => onChange({ gradient: { from: e.target.value, to: gradient?.to ?? '#36d399' } })}
              />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="下色">
              <input
                type="color"
                value={toHex6(gradient?.to ?? '#36d399')}
                onChange={(e) => onChange({ gradient: { from: gradient?.from ?? '#ffd93d', to: e.target.value } })}
              />
            </Field>
          </div>
        </div>
      )}
    </div>
  );
}

export function toHex6(color: string): string {
  const c = (color ?? '').trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  if (/^#[0-9a-f]{8}$/i.test(c)) return c.slice(0, 7);
  return '#000000';
}

/**
 * 归一化位置编辑器：点击 / 拖动设置 x、y（0..1）
 */
export function PosPad({
  x,
  y,
  onChange,
  aspect = 16 / 9,
  hint,
}: {
  x: number;
  y: number;
  onChange: (p: { x: number; y: number }) => void;
  aspect?: number;
  hint?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);

  const apply = (clientX: number, clientY: number) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    onChange({
      x: clamp01((clientX - r.left) / Math.max(1, r.width)),
      y: clamp01((clientY - r.top) / Math.max(1, r.height)),
    });
  };

  return (
    <div>
      <div
        ref={ref}
        className="pos-pad"
        style={{ aspectRatio: String(aspect) }}
        onPointerDown={(e) => {
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          setDragging(true);
          apply(e.clientX, e.clientY);
        }}
        onPointerMove={(e) => {
          if (dragging) apply(e.clientX, e.clientY);
        }}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
      >
        <div className="grid-h" style={{ top: '50%' }} />
        <div className="grid-v" style={{ left: '50%' }} />
        <div className="grid-h" style={{ top: '25%', opacity: 0.5 }} />
        <div className="grid-h" style={{ top: '75%', opacity: 0.5 }} />
        <div className="grid-v" style={{ left: '25%', opacity: 0.5 }} />
        <div className="grid-v" style={{ left: '75%', opacity: 0.5 }} />
        <div className="marker" style={{ left: `${x * 100}%`, top: `${y * 100}%` }} />
      </div>
      {hint && (
        <div className="hint" style={{ marginTop: 5 }}>
          {hint}
        </div>
      )}
    </div>
  );
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function Modal({
  title,
  children,
  footer,
  onClose,
  width,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  width?: number;
}) {
  useEffect(() => {
    if (!onClose) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className="modal" style={width ? { width } : undefined}>
        <div className="modal-head">{title}</div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** 折叠面板 */
export function Disclosure({ summary, children, open }: { summary: string; children: ReactNode; open?: boolean }) {
  return (
    <details open={open}>
      <summary>{summary}</summary>
      {children}
    </details>
  );
}
