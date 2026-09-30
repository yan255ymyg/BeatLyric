/** 视频背景设置：素材、偏移、填充方式、透明度 */

import { useStore } from '../../../state/store';
import { Checkbox, Field, NumberInput, Section, Slider, Toggle } from '../common';
import { assetsOfKind, importFiles, pickFiles } from '../../importer';

export function VideoPanel({ onChanged }: { onChanged: () => void }) {
  const project = useStore((s) => s.project);
  const video = project.playback.video;
  const videos = assetsOfKind(project, 'video');
  const update = useStore((s) => s.updatePlayback);

  return (
    <>
      <Section title="视频背景">
        <Checkbox
          checked={video.enabled}
          label="启用视频背景"
          onChange={(v) => {
            update((d) => void (d.video.enabled = v));
            onChanged();
          }}
        />
        <div className="hint">视频背景只播放画面，不播放声音。</div>
      </Section>

      <Section title="素材">
        <div className="row" style={{ gap: 6 }}>
          <select
            className="input"
            value={video.assetId ?? ''}
            onChange={(e) => {
              update((d) => void (d.video.assetId = e.target.value || null));
              onChanged();
            }}
          >
            <option value="">（未选择视频）</option>
            {videos.map((a) => (
              <option key={a.id} value={a.id}>
                {a.originalName}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={async () => {
              const files = await pickFiles('video/*', true);
              if (!files.length) return;
              const res = await importFiles(files, 'video');
              const first = res.added[0] ?? res.reused[0];
              if (first) {
                update((d) => void (d.video.assetId = first.id));
                onChanged();
              }
            }}
          >
            导入
          </button>
        </div>
      </Section>

      <Section title="播放">
        <Field label="时间偏移">
          <NumberInput
            value={video.offsetMs}
            min={-600000}
            max={600000}
            step={10}
            suffix="ms"
            onChange={(v) => {
              update((d) => void (d.video.offsetMs = v));
              onChanged();
            }}
          />
        </Field>
        <div className="hint">正值表示视频整体延后。视频时间 = 播放头时间 + 偏移。</div>
        <Field label="填充方式">
          <Toggle
            value={video.fit}
            options={[
              { value: 'cover', label: '裁剪铺满' },
              { value: 'contain', label: '完整显示' },
              { value: 'fill', label: '拉伸铺满' },
            ]}
            onChange={(v) => {
              update((d) => void (d.video.fit = v as typeof d.video.fit));
              onChanged();
            }}
          />
        </Field>
        <Field label="缩放">
          <Slider
            value={video.zoom}
            min={0.2}
            max={4}
            step={0.01}
            onChange={(v) => {
              update((d) => void (d.video.zoom = v));
              onChanged();
            }}
            format={(v) => `${v.toFixed(2)}×`}
          />
        </Field>
        <Field label="透明度">
          <Slider
            value={video.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => {
              update((d) => void (d.video.opacity = v));
              onChanged();
            }}
          />
        </Field>
      </Section>
    </>
  );
}
