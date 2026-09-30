/** 逐行歌词显示设置：位置、字号、行距、上下展示行数、透明度、主行样式 */

import { useStore } from '../../../state/store';
import { Field, PosPad, Section, Slider, Toggle } from '../common';

export function LrcDisplayPanel() {
  const project = useStore((s) => s.project);
  const cfg = project.playback.lrc;
  const update = useStore((s) => s.updatePlayback);
  const up = (recipe: (d: typeof cfg) => void) => update((d) => recipe(d.lrc));

  return (
    <>
      <Section title="位置">
        <PosPad
          x={cfg.pos.x}
          y={cfg.pos.y}
          onChange={(p) => up((d) => void (d.pos = p))}
          aspect={project.canvas.width / project.canvas.height}
          hint={`默认在画面中间偏右。x = ${(cfg.pos.x * 100).toFixed(1)}%，y = ${(cfg.pos.y * 100).toFixed(1)}%（主歌词行的中心位置）`}
        />
      </Section>

      <Section title="排版">
        <Field label="字号">
          <Slider value={cfg.fontSize} min={10} max={140} step={1} onChange={(v) => up((d) => void (d.fontSize = v))} format={(v) => `${v.toFixed(0)}px`} />
        </Field>
        <Field label="行距">
          <Slider value={cfg.lineSpacing} min={0.8} max={3} step={0.01} onChange={(v) => up((d) => void (d.lineSpacing = v))} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="对齐">
          <Toggle
            value={cfg.align}
            options={[
              { value: 'left', label: '左' },
              { value: 'center', label: '中' },
              { value: 'right', label: '右' },
            ]}
            onChange={(v) => up((d) => void (d.align = v as typeof d.align))}
          />
        </Field>
        <Field label="上方行数">
          <Slider
            value={cfg.aboveCount}
            min={0}
            max={12}
            step={1}
            onChange={(v) => up((d) => void (d.aboveCount = Math.round(v)))}
            format={(v) => `${v.toFixed(0)} 块`}
          />
        </Field>
        <Field label="下方行数">
          <Slider
            value={cfg.belowCount}
            min={0}
            max={12}
            step={1}
            onChange={(v) => up((d) => void (d.belowCount = Math.round(v)))}
            format={(v) => `${v.toFixed(0)} 块`}
          />
        </Field>
        <div className="hint">
          临时行会占用主歌词下方的一个名次，因此下方的普通块会被整体挤下去。
        </div>
      </Section>

      <Section title="透明度">
        <Field label="主歌词">
          <Slider value={cfg.mainOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.mainOpacity = v))} />
        </Field>
        <Field label="临时行">
          <Slider value={cfg.tempOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.tempOpacity = v))} />
        </Field>
        <Field label="非突出行">
          <Slider value={cfg.inactiveOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.inactiveOpacity = v))} />
        </Field>
        <Field label="临时行间距">
          <Slider value={cfg.tempGapScale} min={0} max={4} step={0.05} onChange={(v) => up((d) => void (d.tempGapScale = v))} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
      </Section>

      <Section title="突出显示">
        <Field label="主行放大">
          <Slider value={cfg.mainScale} min={0.6} max={2.5} step={0.01} onChange={(v) => up((d) => void (d.mainScale = v))} format={(v) => `${v.toFixed(2)}×`} />
        </Field>
        <Field label="主行加粗">
          <Toggle
            value={cfg.mainBold ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: '加粗' },
              { value: 'no', label: '常规' },
            ]}
            onChange={(v) => up((d) => void (d.mainBold = v === 'yes'))}
          />
        </Field>
        <Field label="主行颜色">
          <input type="color" value={cfg.mainColor} onChange={(e) => up((d) => void (d.mainColor = e.target.value))} />
        </Field>
        <Field label="普通颜色">
          <input type="color" value={cfg.color} onChange={(e) => up((d) => void (d.color = e.target.value))} />
        </Field>
        <Field label="普通加粗">
          <Toggle
            value={cfg.bold ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: '加粗' },
              { value: 'no', label: '常规' },
            ]}
            onChange={(v) => up((d) => void (d.bold = v === 'yes'))}
          />
        </Field>
      </Section>

      <Section title="描边与阴影">
        <Field label="描边色">
          <input type="color" value={cfg.outlineColor} onChange={(e) => up((d) => void (d.outlineColor = e.target.value))} />
        </Field>
        <Field label="描边粗细">
          <Slider value={cfg.outlineWidth} min={0} max={20} step={0.5} onChange={(v) => up((d) => void (d.outlineWidth = v))} format={(v) => `${v.toFixed(1)}px`} />
        </Field>
      </Section>

      <Section title="注音 (ruby)">
        <Field label="注音字号">
          <Slider value={cfg.rubyScale} min={0.2} max={1.2} step={0.01} onChange={(v) => up((d) => void (d.rubyScale = v))} format={(v) => `${(v * 100).toFixed(0)}%`} />
        </Field>
        <Field label="注音间距">
          <Slider value={cfg.rubyGap} min={-4} max={20} step={1} onChange={(v) => up((d) => void (d.rubyGap = v))} format={(v) => `${v.toFixed(0)}px`} />
        </Field>
        <div className="hint">注音样式跟随其所在原词局部范围的第一个字。</div>
      </Section>
    </>
  );
}
