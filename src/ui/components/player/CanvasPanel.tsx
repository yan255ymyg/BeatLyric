/** 画布尺寸与背景 */

import { useStore } from '../../../state/store';
import { Field, NumberInput, Section, Toggle } from '../common';
import { CANVAS_PRESETS, PAGE_BG_PRESETS, applyCanvasPreset } from '../../../model/playerDefaults';

export function CanvasPanel() {
  const project = useStore((s) => s.project);
  const update = useStore((s) => s.updatePlayback);

  return (
    <>
      <Section title="画布尺寸">
        <div className="row wrap" style={{ gap: 5, marginBottom: 8 }}>
          {CANVAS_PRESETS.map((p) => (
            <button
              key={p.id}
              className={
                project.canvas.width === p.width && project.canvas.height === p.height ? 'btn tiny active' : 'btn tiny'
              }
              onClick={() =>
                applyCanvasPreset(
                  (recipe) => useStore.getState().commit('切换画布预设', recipe),
                  p.width,
                  p.height,
                  true,
                )
              }
            >
              {p.label}
            </button>
          ))}
        </div>
        <Field label="宽">
          <NumberInput
            value={project.canvas.width}
            min={16}
            max={7680}
            step={2}
            suffix="px"
            onChange={(v) => useStore.getState().commit('修改画布宽', (d) => void (d.canvas.width = Math.round(v)))}
          />
        </Field>
        <Field label="高">
          <NumberInput
            value={project.canvas.height}
            min={16}
            max={4320}
            step={2}
            suffix="px"
            onChange={(v) => useStore.getState().commit('修改画布高', (d) => void (d.canvas.height = Math.round(v)))}
          />
        </Field>
        <div className="hint">改变画布尺寸后，所有元素位置按归一化坐标自动等比缩放，无需重新摆放。</div>
      </Section>

      <Section title="背景">
        <div className="row wrap" style={{ gap: 6, marginBottom: 8 }}>
          {PAGE_BG_PRESETS.map((p) => (
            <span
              key={p.value}
              className={project.canvas.background === p.value ? 'swatch active' : 'swatch'}
              style={{ background: p.value }}
              title={p.label}
              onClick={() =>
                useStore.getState().commit('修改背景色', (d) => {
                  d.canvas.background = p.value;
                  d.canvas.gradient = undefined;
                })
              }
            />
          ))}
        </div>
        <Field label="背景色">
          <input
            type="color"
            value={project.canvas.background}
            onChange={(e) =>
              useStore.getState().commit('修改背景色', (d) => {
                d.canvas.background = e.target.value;
                d.canvas.gradient = undefined;
              })
            }
          />
          <input
            className="input"
            style={{ width: 90 }}
            value={project.canvas.background}
            onChange={(e) =>
              useStore.getState().commit('修改背景色', (d) => {
                d.canvas.background = e.target.value;
                d.canvas.gradient = undefined;
              })
            }
          />
        </Field>
        <Field label="渐变背景">
          <Toggle
            value={project.canvas.gradient ? 'yes' : 'no'}
            options={[
              { value: 'no', label: '纯色' },
              { value: 'yes', label: '上下渐变' },
            ]}
            onChange={(v) =>
              useStore.getState().commit('修改背景', (d) => {
                if (v === 'yes') d.canvas.gradient = { from: d.canvas.background, to: '#000000' };
                else d.canvas.gradient = undefined;
              })
            }
          />
        </Field>
        {project.canvas.gradient && (
          <>
            <Field label="上色">
              <input
                type="color"
                value={project.canvas.gradient.from}
                onChange={(e) =>
                  useStore.getState().commit('修改背景渐变', (d) => {
                    if (d.canvas.gradient) d.canvas.gradient.from = e.target.value;
                  })
                }
              />
            </Field>
            <Field label="下色">
              <input
                type="color"
                value={project.canvas.gradient.to}
                onChange={(e) =>
                  useStore.getState().commit('修改背景渐变', (d) => {
                    if (d.canvas.gradient) d.canvas.gradient.to = e.target.value;
                  })
                }
              />
            </Field>
          </>
        )}
      </Section>

      <Section title="预览">
        <Field label="跟随播放头">
          <Toggle
            value={project.playback.followPlayhead ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: '跟随' },
              { value: 'no', label: '固定' },
            ]}
            onChange={(v) => update((d) => void (d.followPlayhead = v === 'yes'))}
          />
        </Field>
        <Field label="跟随主歌词">
          <Toggle
            value={project.playback.followMainLine ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: '跟随' },
              { value: 'no', label: '固定' },
            ]}
            onChange={(v) => update((d) => void (d.followMainLine = v === 'yes'))}
          />
        </Field>
      </Section>
    </>
  );
}
