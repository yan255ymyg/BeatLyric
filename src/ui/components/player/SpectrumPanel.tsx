/** 频谱设置：方向、列数、大小、位置、颜色 */

import { useStore } from '../../../state/store';
import { Checkbox, Field, PosPad, Section, Slider, Toggle } from '../common';

export function SpectrumPanel({ onChanged }: { onChanged: () => void }) {
  const project = useStore((s) => s.project);
  const sp = project.playback.spectrum;
  const update = useStore((s) => s.updatePlayback);
  const up = (recipe: (d: typeof sp) => void) => {
    update((d) => recipe(d.spectrum));
    onChanged();
  };

  return (
    <>
      <Section title="显示">
        <Checkbox checked={sp.enabled} label="显示频谱图" onChange={(v) => up((d) => void (d.enabled = v))} />
        <div className="hint">实时预览使用 AnalyserNode；导出时使用离线 STFT，因此两者观感一致。</div>
      </Section>

      <Section title="样式">
        <Field label="形状">
          <Toggle
            value={sp.style}
            options={[
              { value: 'bars', label: '柱状' },
              { value: 'mirror', label: '对称' },
              { value: 'wave', label: '波形' },
              { value: 'dots', label: '点阵' },
            ]}
            onChange={(v) => up((d) => void (d.style = v as typeof d.style))}
          />
        </Field>
        <Field label="方向">
          <Toggle
            value={sp.direction}
            options={[
              { value: 'up', label: '向上' },
              { value: 'down', label: '向下' },
              { value: 'left', label: '向左' },
              { value: 'right', label: '向右' },
            ]}
            onChange={(v) => up((d) => void (d.direction = v as typeof d.direction))}
          />
        </Field>
        <Field label="列数">
          <Slider value={sp.columns} min={8} max={192} step={1} onChange={(v) => up((d) => void (d.columns = Math.round(v)))} format={(v) => `${v.toFixed(0)} 列`} />
        </Field>
        <Field label="柱间距">
          <Slider value={sp.barGap} min={0} max={0.85} step={0.01} onChange={(v) => up((d) => void (d.barGap = v))} format={(v) => `${(v * 100).toFixed(0)}%`} />
        </Field>
      </Section>

      <Section title="位置与大小">
        <PosPad
          x={sp.pos.x}
          y={sp.pos.y}
          onChange={(p) => up((d) => void (d.pos = p))}
          aspect={project.canvas.width / project.canvas.height}
          hint={`中心位置：x = ${(sp.pos.x * 100).toFixed(1)}%，y = ${(sp.pos.y * 100).toFixed(1)}%`}
        />
        <Field label="宽度">
          <Slider value={sp.width} min={0.02} max={1.5} step={0.005} onChange={(v) => up((d) => void (d.width = v))} format={(v) => `${(v * 100).toFixed(1)}%`} />
        </Field>
        <Field label="高度">
          <Slider value={sp.height} min={0.02} max={1.5} step={0.005} onChange={(v) => up((d) => void (d.height = v))} format={(v) => `${(v * 100).toFixed(1)}%`} />
        </Field>
      </Section>

      <Section title="颜色与范围">
        <Field label="主色">
          <input type="color" value={sp.color} onChange={(e) => up((d) => void (d.color = e.target.value))} />
        </Field>
        <Checkbox checked={sp.gradient} label="使用渐变色" onChange={(v) => up((d) => void (d.gradient = v))} />
        {sp.gradient && (
          <Field label="渐变到">
            <input type="color" value={sp.colorTo} onChange={(e) => up((d) => void (d.colorTo = e.target.value))} />
          </Field>
        )}
        <Field label="透明度">
          <Slider value={sp.opacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.opacity = v))} />
        </Field>
        <Field label="增益">
          <Slider value={sp.gain} min={0.1} max={6} step={0.05} onChange={(v) => up((d) => void (d.gain = v))} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="频率下限">
          <Slider value={sp.minFreq} min={20} max={2000} step={5} onChange={(v) => up((d) => void (d.minFreq = Math.min(v, d.maxFreq * 0.8)))} format={(v) => `${v.toFixed(0)}Hz`} />
        </Field>
        <Field label="频率上限">
          <Slider value={sp.maxFreq} min={500} max={22050} step={50} onChange={(v) => up((d) => void (d.maxFreq = Math.max(v, d.minFreq * 1.2)))} format={(v) => `${v.toFixed(0)}Hz`} />
        </Field>
        <Checkbox checked={sp.outline} label="描边" onChange={(v) => up((d) => void (d.outline = v))} />
      </Section>
    </>
  );
}
