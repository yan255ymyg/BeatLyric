/**
 * 颜色栈编辑器
 *
 * 语义（对应需求）：用「添加颜色 / 删除颜色」来设置，
 * 只有一种颜色就是纯色，有多种颜色就是自上而下的渐变色。
 * 因此不再需要「纯色 / 渐变」的模式切换。
 */

import { Field } from './common';

const PRESETS: { label: string; colors: string[] }[] = [
  { label: '黄→绿', colors: ['#ffd93d', '#36d399'] },
  { label: '青→紫', colors: ['#4ea1ff', '#a06bff'] },
  { label: '白→蓝', colors: ['#ffffff', '#4ea1ff'] },
  { label: '橙→红', colors: ['#ffb020', '#ff3b5c'] },
  { label: '蓝→青→绿', colors: ['#4ea1ff', '#2ee6c0', '#36d399'] },
];

export function ColorStackEditor({
  label,
  colors,
  fallback,
  onChange,
  /** 少于该数量时不允许删除 */
  minColors = 0,
}: {
  label: string;
  colors: string[] | undefined;
  fallback: string;
  onChange: (colors: string[] | undefined) => void;
  minColors?: number;
}) {
  const list = colors && colors.length ? colors : [fallback];
  const isGradient = list.length > 1;

  return (
    <>
      <Field label={label}>
        <div className="row wrap" style={{ gap: 4, width: '100%' }}>
          {list.map((c, i) => (
            <span key={i} className="row" style={{ gap: 2 }}>
              <input
                type="color"
                title={isGradient ? `渐变第 ${i + 1}/${list.length} 个色标` : '颜色'}
                value={c}
                onChange={(e) => {
                  const next = [...list];
                  next[i] = e.target.value;
                  onChange(next);
                }}
              />
              {list.length > Math.max(1, minColors) && (
                <button
                  className="btn tiny ghost"
                  title="删除这个颜色"
                  style={{ padding: '0 3px' }}
                  onClick={() => {
                    const next = list.filter((_, k) => k !== i);
                    onChange(next.length ? next : undefined);
                  }}
                >
                  −
                </button>
              )}
            </span>
          ))}
          <button
            className="btn tiny"
            title="添加一个颜色（多于 1 个颜色即为渐变色）"
            onClick={() => onChange([...list, list[list.length - 1]])}
          >
            ＋色
          </button>
          <select
            className="input"
            style={{ width: 92, flexShrink: 0 }}
            value=""
            title="渐变色预设"
            onChange={(e) => {
              const p = PRESETS.find((x) => x.label === e.target.value);
              if (p) onChange([...p.colors]);
            }}
          >
            <option value="">预设…</option>
            {PRESETS.map((p) => (
              <option key={p.label} value={p.label}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
      </Field>
      <div className="hint" style={{ marginTop: -3, marginBottom: 6 }}>
        {isGradient ? `${list.length} 个颜色 → 由上至下的渐变` : '1 个颜色 → 纯色'}
      </div>
    </>
  );
}
