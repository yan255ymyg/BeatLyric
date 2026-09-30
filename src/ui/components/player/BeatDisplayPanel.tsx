/**
 * 逐拍歌词显示设置
 * 位置、横向/纵向缩放、展示小节数、透明度、主轴与刻度样式、节拍序号、
 * 歌词字文本、扫过动画、事件可见性
 */

import { ALL_EVENT_TYPES, EVENT_META, type BeatEventType } from '../../../model/model';
import { useStore } from '../../../state/store';
import { Checkbox, ColorField, Field, PosPad, Section, Slider, Toggle, ColorOrGradient } from '../common';
import { EventGlyph } from '../EventGlyph';

export function BeatDisplayPanel() {
  const project = useStore((s) => s.project);
  const cfg = project.playback.beat;
  const update = useStore((s) => s.updatePlayback);
  const up = (recipe: (d: typeof cfg) => void) => update((d) => recipe(d.beat));

  return (
    <>
      <Section title="位置与整体">
        <PosPad
          x={cfg.pos.x}
          y={cfg.pos.y}
          onChange={(p) => up((d) => void (d.pos = p))}
          aspect={project.canvas.width / project.canvas.height}
          hint={`默认在画布靠下位置整行铺展。x = ${(cfg.pos.x * 100).toFixed(1)}%，y = ${(cfg.pos.y * 100).toFixed(1)}%`}
        />
        <Field label="对齐锚点">
          <Toggle
            value={cfg.anchor}
            options={[
              { value: 'bottom', label: '底部' },
              { value: 'center', label: '居中' },
              { value: 'top', label: '顶部' },
            ]}
            onChange={(v) => up((d) => void (d.anchor = v as typeof d.anchor))}
          />
        </Field>
        <Field label="横向缩放 X">
          <Slider value={cfg.scaleX} min={0.2} max={3} step={0.01} onChange={(v) => up((d) => void (d.scaleX = v))} />
        </Field>
        <Field label="纵向缩放 Y">
          <Slider value={cfg.scaleY} min={0.2} max={3} step={0.01} onChange={(v) => up((d) => void (d.scaleY = v))} />
        </Field>
        <div className="row" style={{ gap: 6, marginBottom: 7 }}>
          <button className="btn tiny" onClick={() => up((d) => void ((d.scaleX = 1), (d.scaleY = 1)))}>
            缩放复位
          </button>
          <button className="btn tiny" onClick={() => up((d) => void (d.scaleY = d.scaleX))}>
            Y 跟随 X
          </button>
        </div>
        <Field label="展示小节">
          <Slider
            value={cfg.visibleBarCount}
            min={1}
            max={8}
            step={1}
            integer
            onChange={(v) => up((d) => void (d.visibleBarCount = Math.max(1, Math.round(v))))}
          />
        </Field>
        <div className="hint">默认展示当前小节与下一小节；当前小节播放完毕后整块向上滚动渐隐。</div>
      </Section>

      <Section title="透明度">
        <Field label="当前小节">
          <Slider value={cfg.currentOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.currentOpacity = v))} />
        </Field>
        <Field label="后续小节">
          <Slider value={cfg.nextOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.nextOpacity = v))} />
        </Field>
        <Field label="渐隐目标">
          <Slider value={cfg.fadingOpacity} min={0} max={1} step={0.01} onChange={(v) => up((d) => void (d.fadingOpacity = v))} />
        </Field>
        <Field label="过渡时长">
          <Slider
            value={cfg.transitionBeats}
            min={0}
            max={4}
            step={0.05}
            onChange={(v) => up((d) => void (d.transitionBeats = v))}
          />
        </Field>
        <div className="hint">
          过渡发生在当前小节的最后若干拍内：整块内容向上平移一个行距，
          让下一小节在它真正开始时正好就位。
        </div>
      </Section>

      <Section title="主轴与节拍刻度">
        <div className="row" style={{ gap: 6 }}>
          <div style={{ flex: 1 }}>
            <Field label="主轴高度">
              <Slider value={cfg.barHeight} min={4} max={80} step={1} onChange={(v) => up((d) => void (d.barHeight = v))} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="刻度宽度">
              <Slider value={cfg.beatMarkWidth} min={1} max={24} step={0.5} onChange={(v) => up((d) => void (d.beatMarkWidth = v))} />
            </Field>
          </div>
        </div>
        <Field label="主轴边框">
          <input type="color" value={cfg.barStroke} onChange={(e) => up((d) => void (d.barStroke = e.target.value))} />
          <Slider value={cfg.barStrokeWidth} min={0} max={8} step={0.1} onChange={(v) => up((d) => void (d.barStrokeWidth = v))} />
        </Field>
        <ColorOrGradient
          label="主轴填充"
          color={cfg.barFill.from}
          gradient={cfg.barFill}
          onChange={(v) => up((d) => void (d.barFill = v.gradient ?? { from: v.color ?? '#3fb6e8', to: v.color ?? '#3fb6e8' }))}
        />
        <ColorOrGradient
          label="刻度填充"
          color={cfg.beatMarkFill.from}
          gradient={cfg.beatMarkFill}
          onChange={(v) => up((d) => void (d.beatMarkFill = v.gradient ?? { from: v.color ?? '#ffd93d', to: v.color ?? '#ffd93d' }))}
        />
        <Field label="刻度边框">
          <input type="color" value={cfg.beatMarkStroke} onChange={(e) => up((d) => void (d.beatMarkStroke = e.target.value))} />
          <Slider value={cfg.beatMarkStrokeWidth} min={0} max={6} step={0.1} onChange={(v) => up((d) => void (d.beatMarkStrokeWidth = v))} />
        </Field>
        <Field label="行间距">
          <Slider value={cfg.rowGap} min={0} max={200} step={1} onChange={(v) => up((d) => void (d.rowGap = v))} />
        </Field>
      </Section>

      <Section title="节拍序号">
        <Checkbox checked={cfg.showBeatNumbers} label="在刻度正下方显示拍号" onChange={(v) => up((d) => void (d.showBeatNumbers = v))} />
        <Field label="序号颜色">
          <input type="color" value={cfg.beatNumberColor} onChange={(e) => up((d) => void (d.beatNumberColor = e.target.value))} />
        </Field>
        <Field label="序号字号">
          <Slider value={cfg.beatNumberFontSize} min={6} max={48} step={1} onChange={(v) => up((d) => void (d.beatNumberFontSize = v))} />
        </Field>
        <Checkbox checked={cfg.beatNumberBold} label="序号加粗" onChange={(v) => up((d) => void (d.beatNumberBold = v))} />
        <Checkbox checked={cfg.showBarLabel} label="显示小节标注" onChange={(v) => up((d) => void (d.showBarLabel = v))} />
        <Checkbox checked={cfg.showPlayhead} label="显示播放头" onChange={(v) => up((d) => void (d.showPlayhead = v))} />
        {cfg.showPlayhead && <ColorField label="播放头色" value={cfg.playheadColor} onChange={(v) => up((d) => void (d.playheadColor = v))} />}
      </Section>

      <Section title="歌词字文本">
        <Field label="字号">
          <Slider value={cfg.textFontSize} min={8} max={160} step={1} onChange={(v) => up((d) => void (d.textFontSize = v))} />
        </Field>
        <Field label="颜色">
          <input type="color" value={cfg.textColor} onChange={(e) => up((d) => void (d.textColor = e.target.value))} />
        </Field>
        <Field label="描边色">
          <input type="color" value={cfg.textOutlineColor} onChange={(e) => up((d) => void (d.textOutlineColor = e.target.value))} />
        </Field>
        <Field label="描边粗细">
          <Slider value={cfg.textOutlineWidth} min={0} max={20} step={0.5} onChange={(v) => up((d) => void (d.textOutlineWidth = v))} />
        </Field>
        <div className="row" style={{ gap: 6 }}>
          <div style={{ flex: 1 }}>
            <Field label="文字间距">
              <Slider value={cfg.textGap} min={-40} max={120} step={1} onChange={(v) => up((d) => void (d.textGap = v))} />
            </Field>
          </div>
          <div style={{ flex: 1 }}>
            <Field label="注音字号">
              <Slider value={cfg.rubyScale} min={0.2} max={1.2} step={0.01} onChange={(v) => up((d) => void (d.rubyScale = v))} />
            </Field>
          </div>
        </div>
        <Field label="注音间距">
          <Slider value={cfg.rubyGap} min={-10} max={30} step={1} onChange={(v) => up((d) => void (d.rubyGap = v))} />
        </Field>
      </Section>

      <Section title="扫过动画">
        <Field label="动画时长">
          <Slider value={cfg.pulseMs} min={0} max={2000} step={10} onChange={(v) => up((d) => void (d.pulseMs = v))} />
        </Field>
        <Field label="放大倍数">
          <Slider value={cfg.pulseScale} min={1} max={4} step={0.05} onChange={(v) => up((d) => void (d.pulseScale = v))} />
        </Field>
        <div className="hint">点事件在播放头扫过时放大渐隐；强制行进在整段经过之后才放大渐隐。</div>
      </Section>

      <Section title="显示内容（图标 / 文本）">
        {ALL_EVENT_TYPES.map((t) => (
          <div className="row between" key={t} style={{ marginBottom: 5 }}>
            <span className="row" style={{ gap: 6 }}>
              <EventGlyph type={t} size={13} />
              <span style={{ fontSize: 12 }}>{EVENT_META[t].label}</span>
            </span>
            <span className="row" style={{ gap: 10 }}>
              <label className="row" style={{ gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.eventVisibility[t].icon}
                  onChange={(e) => up((d) => void (d.eventVisibility[t as BeatEventType].icon = e.target.checked))}
                />
                <span className="hint">图标</span>
              </label>
              <label className="row" style={{ gap: 4, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={cfg.eventVisibility[t].text}
                  onChange={(e) => up((d) => void (d.eventVisibility[t as BeatEventType].text = e.target.checked))}
                />
                <span className="hint">文本</span>
              </label>
            </span>
          </div>
        ))}
        <Field label="文本色">
          <input type="color" value={cfg.eventLabelColor} onChange={(e) => up((d) => void (d.eventLabelColor = e.target.value))} />
        </Field>
        <Field label="文本字号">
          <Slider value={cfg.eventLabelFontSize} min={6} max={64} step={1} onChange={(v) => up((d) => void (d.eventLabelFontSize = v))} />
        </Field>
      </Section>
    </>
  );
}
