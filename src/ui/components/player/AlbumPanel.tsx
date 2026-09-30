/** 专辑图设置：显示、素材、位置、大小、光碟样式、旋转 */

import { useStore } from '../../../state/store';
import { Checkbox, Field, PosPad, Section, Slider, Toggle } from '../common';
import { assetsOfKind, importFiles, pickFiles } from '../../importer';
import { formatBytes } from '../../../core/util';

export function AlbumPanel({ onChanged }: { onChanged: () => void }) {
  const project = useStore((s) => s.project);
  const album = project.playback.album;
  const update = useStore((s) => s.updatePlayback);
  const images = assetsOfKind(project, 'image');

  return (
    <>
      <Section title="显示">
        <Checkbox
          checked={album.enabled}
          label="显示专辑图片"
          onChange={(v) => {
            update((d) => void (d.album.enabled = v));
            onChanged();
          }}
        />
        <div className="hint">默认位置在画面中间偏左。</div>
      </Section>

      <Section title="素材">
        <div className="row" style={{ gap: 6 }}>
          <select
            className="input"
            value={album.assetId ?? ''}
            onChange={(e) => {
              update((d) => void (d.album.assetId = e.target.value || null));
              onChanged();
            }}
          >
            <option value="">（未选择图片）</option>
            {images.map((a) => (
              <option key={a.id} value={a.id}>
                {a.originalName}
              </option>
            ))}
          </select>
          <button
            className="btn"
            onClick={async () => {
              const files = await pickFiles('image/*', true);
              if (!files.length) return;
              const res = await importFiles(files, 'image');
              const first = res.added[0] ?? res.reused[0];
              if (first) {
                update((d) => void (d.album.assetId = first.id));
                onChanged();
              }
            }}
          >
            导入
          </button>
        </div>
        {album.assetId && project.assets[album.assetId] && (
          <div className="hint" style={{ marginTop: 6 }}>
            {project.assets[album.assetId].originalName} · {formatBytes(project.assets[album.assetId].size)}
          </div>
        )}
      </Section>

      <Section title="位置与大小">
        <PosPad
          x={album.pos.x}
          y={album.pos.y}
          onChange={(p) => {
            update((d) => void (d.album.pos = p));
            onChanged();
          }}
          aspect={project.canvas.width / project.canvas.height}
          hint={`x = ${(album.pos.x * 100).toFixed(1)}%　y = ${(album.pos.y * 100).toFixed(1)}%（点击或拖动设置中心点）`}
        />
        <Field label="大小">
          <Slider
            value={album.size}
            min={0.02}
            max={1.5}
            step={0.005}
            onChange={(v) => {
              update((d) => void (d.album.size = v));
              onChanged();
            }}
            format={(v) => `${(v * 100).toFixed(1)}% 宽`}
          />
        </Field>
        <Field label="透明度">
          <Slider
            value={album.opacity}
            min={0}
            max={1}
            step={0.01}
            onChange={(v) => {
              update((d) => void (d.album.opacity = v));
              onChanged();
            }}
          />
        </Field>
        <Field label="圆角">
          <Slider
            value={album.cornerRadius}
            min={0}
            max={200}
            step={1}
            onChange={(v) => {
              update((d) => void (d.album.cornerRadius = v));
              onChanged();
            }}
            format={(v) => `${v.toFixed(0)}px`}
          />
        </Field>
        <Checkbox
          checked={album.shadow}
          label="投影阴影"
          onChange={(v) => {
            update((d) => void (d.album.shadow = v));
            onChanged();
          }}
        />
      </Section>

      <Section title="光碟样式">
        <Field label="样式">
          <Toggle
            value={album.discStyle ? 'disc' : 'flat'}
            options={[
              { value: 'flat', label: '方形封面' },
              { value: 'disc', label: '黑胶光碟' },
            ]}
            onChange={(v) => {
              update((d) => void (d.album.discStyle = v === 'disc'));
              onChanged();
            }}
          />
        </Field>
        {album.discStyle && (
          <>
            <Field label="碟片底色">
              <input
                type="color"
                value={album.discColor}
                onChange={(e) => {
                  update((d) => void (d.album.discColor = e.target.value));
                  onChanged();
                }}
              />
            </Field>
            <Field label="旋转">
              <Toggle
                value={album.rotate ? 'yes' : 'no'}
                options={[
                  { value: 'no', label: '静止' },
                  { value: 'yes', label: '播放时旋转' },
                ]}
                onChange={(v) => {
                  update((d) => void (d.album.rotate = v === 'yes'));
                  onChanged();
                }}
              />
            </Field>
            {album.rotate && (
              <Field label="转速">
                <Slider
                  value={album.rotateSpeed}
                  min={-180}
                  max={180}
                  step={1}
                  onChange={(v) => {
                    update((d) => void (d.album.rotateSpeed = v));
                    onChanged();
                  }}
                  format={(v) => `${v.toFixed(0)}°/s`}
                />
              </Field>
            )}
          </>
        )}
        {!album.discStyle && (
          <Checkbox
            checked={album.spinAnimation}
            label="外圈装饰环"
            onChange={(v) => {
              update((d) => void (d.album.spinAnimation = v));
              onChanged();
            }}
          />
        )}
      </Section>
    </>
  );
}
