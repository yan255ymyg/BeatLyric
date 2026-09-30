/**
 * 特效设置
 * 屏幕抖动、整拍 / 整小节震动或放大、歌词字震动或放大、火星飘落、闪光
 */

import type { EffectConfig, EffectType } from '../../../model/model';
import { useStore } from '../../../state/store';
import { Checkbox, Field, NumberInput, Section, Slider, Toggle } from '../common';

const EFFECT_LABELS: Record<EffectType, string> = {
  shake: '屏幕抖动',
  beatPulse: '整拍脉冲缩放',
  barPulse: '整小节脉冲缩放',
  charBounce: '歌词字跳动',
  sparks: '火星飘落',
  flash: '闪光',
};

const EFFECT_HINTS: Record<EffectType, string> = {
  shake: '画面按强度做高频位移抖动，时长内衰减。',
  beatPulse: '每个触发点让整体画面放大后回落。',
  barPulse: '每小节开始时整体放大，幅度通常比整拍大。',
  charBounce: '每个歌词字事件触发向上位移 + 放大。',
  sparks: '每个触发点喷出若干粒子，受重力下落并淡出。',
  flash: '全屏颜色闪光，透明度按时长衰减。',
};

export function EffectsPanel() {
  const project = useStore((s) => s.project);
  const effects = project.playback.effects;

  return (
    <>
      <Section title="特效列表">
        <div className="hint" style={{ marginBottom: 8 }}>
          特效可叠加。所有特效都按「触发点 + 包络」计算，因此在实时预览与离线导出中完全一致。
        </div>
        {effects.map((fx) => (
          <EffectCard key={fx.id} fx={fx} />
        ))}
        <button className="btn" style={{ width: '100%', marginTop: 6 }} onClick={() => useStore.getState().addEffect()}>
          ＋ 新增特效
        </button>
      </Section>
    </>
  );
}

function EffectCard({ fx }: { fx: EffectConfig }) {
  const update = useStore.getState().updateEffect;
  return (
    <div
      style={{
        border: '1px solid var(--line-soft)',
        borderRadius: 7,
        padding: 8,
        marginBottom: 8,
        background: fx.enabled ? 'var(--bg-2)' : 'transparent',
        opacity: fx.enabled ? 1 : 0.65,
      }}
    >
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <input
          type="checkbox"
          checked={fx.enabled}
          onChange={(e) => update(fx.id, (d) => void (d.enabled = e.target.checked))}
        />
        <select className="input" value={fx.type} onChange={(e) => update(fx.id, (d) => void (d.type = e.target.value as EffectType))}>
          {(Object.keys(EFFECT_LABELS) as EffectType[]).map((t) => (
            <option key={t} value={t}>
              {EFFECT_LABELS[t]}
            </option>
          ))}
        </select>
        <button className="btn tiny danger" title="删除" onClick={() => useStore.getState().removeEffect(fx.id)}>
          ✕
        </button>
      </div>

      <div className="hint" style={{ marginBottom: 6 }}>
        {EFFECT_HINTS[fx.type]}
      </div>

      <Field label="触发源">
        <Toggle
          value={fx.trigger}
          options={[
            { value: 'beat', label: '整拍' },
            { value: 'bar', label: '整小节' },
            { value: 'char', label: '歌词字' },
          ]}
          onChange={(v) => update(fx.id, (d) => void (d.trigger = v as EffectConfig['trigger']))}
        />
      </Field>

      <Field label="强度">
        <Slider
          value={fx.strength}
          min={0}
          max={fx.type === 'shake' ? 40 : fx.type === 'sparks' ? 3 : 0.6}
          step={fx.type === 'shake' ? 0.5 : 0.01}
          onChange={(v) => update(fx.id, (d) => void (d.strength = v))}
          format={(v) => (fx.type === 'shake' ? `${v.toFixed(0)}px` : v.toFixed(2))}
        />
      </Field>

      <Field label="时长">
        <NumberInput
          value={fx.durationMs}
          min={1}
          max={20000}
          step={10}
          suffix="ms"
          onChange={(v) => update(fx.id, (d) => void (d.durationMs = v))}
        />
      </Field>

      <Field label="频率">
        <Slider value={fx.frequency} min={0.1} max={60} step={0.1} onChange={(v) => update(fx.id, (d) => void (d.frequency = v))} format={(v) => v.toFixed(1)} />
      </Field>

      {fx.type === 'sparks' && (
        <>
          <Field label="粒子数量">
            <NumberInput value={fx.count ?? 14} min={1} max={200} step={1} onChange={(v) => update(fx.id, (d) => void (d.count = Math.round(v)))} />
          </Field>
          <Field label="颜色">
            <input type="color" value={fx.color ?? '#ffd27f'} onChange={(e) => update(fx.id, (d) => void (d.color = e.target.value))} />
          </Field>
        </>
      )}

      {fx.type === 'flash' && (
        <Field label="颜色">
          <input type="color" value={fx.color ?? '#ffffff'} onChange={(e) => update(fx.id, (d) => void (d.color = e.target.value))} />
        </Field>
      )}

      <Checkbox
        checked={!!fx.downbeatOnly}
        label="只在每小节第 1 拍触发"
        onChange={(v) => update(fx.id, (d) => void (d.downbeatOnly = v))}
      />
    </div>
  );
}
