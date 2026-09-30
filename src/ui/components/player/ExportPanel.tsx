/**
 * 导出面板
 *
 * 离线逐帧渲染 + 硬件编码（WebCodecs + mediabunny），**不做实时录制**：
 * 导出耗时不等于视频时长，画质由码率决定而非设备性能决定。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useStore, getTimeline } from '../../../state/store';
import { Checkbox, Field, NumberInput, Section, Slider, Toggle } from '../common';
import { formatTimecode } from '../../../playback/duration';
import { runExport } from '../../../export/runExport';
import { listPresetsWithSupport, hasWebCodecsVideoEncoder, WEBCODECS_UNSUPPORTED_MESSAGE } from '../../../export/capabilities';
import { formatBytes } from '../../../core/util';
import { downloadBlob } from '../../../core/storage';

export function ExportPanel() {
  const project = useStore((s) => s.project);
  const cfg = project.playback.export;
  const tl = useMemo(() => getTimeline(project), [project]);
  const [supportMsg, setSupportMsg] = useState<string | null>(null);
  const [presets, setPresets] = useState<{ id: string; label: string; available?: boolean; note?: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<{ from: number; to: number }>({ from: 0, to: tl.endSec });
  const [lastResult, setLastResult] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const update = useStore((s) => s.updatePlayback);
  const up = (recipe: (d: typeof cfg) => void) => update((d) => recipe(d.export));

  useEffect(() => {
    setRange((r) => ({ ...r, to: tl.endSec }));
  }, [tl.endSec]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (!hasWebCodecsVideoEncoder()) {
        setSupportMsg(WEBCODECS_UNSUPPORTED_MESSAGE);
        return;
      }
      setSupportMsg(null);
      try {
        const list = await listPresetsWithSupport();
        if (!cancelled) {
          setPresets(
            list.map((p) => ({
              id: p.id,
              label: `${p.label}${p.available === false ? '（不可用）' : ''}`,
              available: p.available,
            })),
          );
        }
      } catch (err) {
        if (!cancelled) setSupportMsg(String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const estimatedFrames = Math.max(1, Math.round(((range.to - range.from) / 1) * cfg.fps));
  const estimatedBytes = ((cfg.videoBitrateMbps + cfg.audioBitrateKbps / 1000) * 1e6 * Math.max(0.1, range.to - range.from)) / 8;

  const start = async () => {
    if (busy) return;
    const store = useStore.getState();
    const controller = new AbortController();
    abortRef.current = controller;
    setBusy(true);
    setLastResult(null);
    store.setProgress({ active: true, title: '正在导出视频', detail: '准备资源…', value: 0, total: estimatedFrames });
    try {
      const result = await runExport({
        project: store.project,
        fps: cfg.fps,
        width: cfg.useCanvasSize ? project.canvas.width : cfg.width,
        height: cfg.useCanvasSize ? project.canvas.height : cfg.height,
        format: cfg.format,
        videoCodec: cfg.videoCodec,
        audioCodec: cfg.audioCodec,
        videoBitrateMbps: cfg.videoBitrateMbps,
        audioBitrateKbps: cfg.audioBitrateKbps,
        fromSec: range.from,
        toSec: range.to,
        signal: controller.signal,
        onProgress: (p) => {
          useStore.getState().setProgress({
            active: true,
            title: p.phase === 'audio' ? '正在编码音频' : p.phase === 'finalize' ? '正在封装文件' : '正在渲染帧',
            detail: `${p.phase} · ${p.done}/${p.total}`,
            value: p.done,
            total: p.total || estimatedFrames,
          });
        },
      });

      const ext = result.mimeType.includes('webm') ? 'webm' : 'mp4';
      const name = `${project.meta.name || 'beatlyric'}-${cfg.width}x${cfg.height}-${cfg.fps}fps.${ext}`;
      downloadBlob(result.blob, name);
      setLastResult(
        `已导出 ${name}（${formatBytes(result.bytes)}，${result.frames} 帧，${formatTimecode(result.durationSec)}）` +
          (result.fallbackNote ? `\n注意：${result.fallbackNote}` : ''),
      );
      store.pushToast('success', '视频导出完成', result.fallbackNote);
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') store.pushToast('warn', '导出已取消');
      else store.pushToast('error', '导出失败', String(err));
    } finally {
      abortRef.current = null;
      setBusy(false);
      useStore.getState().setProgress(null);
    }
  };

  return (
    <>
      <Section title="导出设置">
        {supportMsg ? (
          <div className="hint error">{supportMsg}</div>
        ) : (
          <div className="hint">
            使用离线逐帧渲染 + 硬件编码（WebCodecs + mediabunny），导出耗时与视频时长无关，
            画质由码率与分辨率决定，不受设备实时性能影响。
          </div>
        )}

        <Field label="使用画布尺寸">
          <Toggle
            value={cfg.useCanvasSize ? 'yes' : 'no'}
            options={[
              { value: 'yes', label: `跟随画布 ${project.canvas.width}×${project.canvas.height}` },
              { value: 'no', label: '自定义' },
            ]}
            onChange={(v) => up((d) => void (d.useCanvasSize = v === 'yes'))}
          />
        </Field>

        {!cfg.useCanvasSize && (
          <>
            <Field label="宽">
              <NumberInput value={cfg.width} min={16} max={7680} step={2} onChange={(v) => up((d) => void (d.width = Math.round(v)))} />
            </Field>
            <Field label="高">
              <NumberInput value={cfg.height} min={16} max={4320} step={2} onChange={(v) => up((d) => void (d.height = Math.round(v)))} />
            </Field>
          </>
        )}

        <Field label="帧率">
          <Toggle
            value={String(cfg.fps)}
            options={[
              { value: '24', label: '24' },
              { value: '30', label: '30' },
              { value: '60', label: '60' },
              { value: '120', label: '120' },
            ]}
            onChange={(v) => up((d) => void (d.fps = Number(v)))}
          />
        </Field>

        <Field label="容器">
          <Toggle
            value={cfg.format}
            options={[
              { value: 'mp4', label: 'MP4' },
              { value: 'webm', label: 'WebM' },
            ]}
            onChange={(v) =>
              up((d) => {
                d.format = v as 'mp4' | 'webm';
                if (v === 'mp4') {
                  d.videoCodec = d.videoCodec === 'vp9' ? 'h264' : d.videoCodec;
                  d.audioCodec = 'aac';
                } else {
                  d.videoCodec = d.videoCodec === 'h264' || d.videoCodec === 'hevc' ? 'vp9' : d.videoCodec;
                  d.audioCodec = 'opus';
                }
              })
            }
          />
        </Field>

        <Field label="视频编码">
          <select className="input" value={cfg.videoCodec} onChange={(e) => up((d) => void (d.videoCodec = e.target.value))}>
            {(cfg.format === 'mp4' ? ['h264', 'hevc', 'av1'] : ['vp9', 'av1']).map((c) => (
              <option key={c} value={c}>
                {c === 'h264' ? 'H.264 (AVC) — 兼容性最好' : c === 'hevc' ? 'H.265 (HEVC) — 体积更小' : c === 'av1' ? 'AV1 — 压缩率最高' : 'VP9 — WebM 默认'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="音频编码">
          <select className="input" value={cfg.audioCodec} onChange={(e) => up((d) => void (d.audioCodec = e.target.value))}>
            {(cfg.format === 'mp4' ? ['aac'] : ['opus']).map((c) => (
              <option key={c} value={c}>
                {c === 'aac' ? 'AAC' : 'Opus'}
              </option>
            ))}
          </select>
        </Field>

        <Field label="视频码率">
          <Slider value={cfg.videoBitrateMbps} min={1} max={80} step={0.5} onChange={(v) => up((d) => void (d.videoBitrateMbps = v))} format={(v) => `${v.toFixed(1)} Mbps`} />
        </Field>
        <Field label="音频码率">
          <Slider value={cfg.audioBitrateKbps} min={64} max={512} step={8} onChange={(v) => up((d) => void (d.audioBitrateKbps = v))} format={(v) => `${v.toFixed(0)} kbps`} />
        </Field>
      </Section>

      <Section title="导出范围">
        <Field label="起点">
          <NumberInput value={range.from} min={0} max={Math.max(0, tl.endSec)} step={0.1} suffix="s" onChange={(v) => setRange((r) => ({ ...r, from: Math.max(0, Math.min(v, r.to - 0.1)) }))} />
        </Field>
        <Field label="终点">
          <NumberInput value={range.to} min={0} max={Math.max(0.1, tl.endSec + 60)} step={0.1} suffix="s" onChange={(v) => setRange((r) => ({ ...r, to: Math.max(r.from + 0.1, v) }))} />
        </Field>
        <div className="hint">
          时间轴总长 {formatTimecode(tl.endSec)}；将导出 {estimatedFrames} 帧，预计文件约 {formatBytes(estimatedBytes)}。
        </div>
      </Section>

      <Section title="开始导出">
        <button className="btn primary" style={{ width: '100%' }} disabled={busy || !!supportMsg} onClick={start}>
          {busy ? '导出中…' : '开始导出视频'}
        </button>
        {busy && (
          <button
            className="btn danger"
            style={{ width: '100%', marginTop: 6 }}
            onClick={() => {
              abortRef.current?.abort();
            }}
          >
            取消导出
          </button>
        )}
        {lastResult && (
          <div className="hint" style={{ marginTop: 8, whiteSpace: 'pre-wrap', color: 'var(--accent-2)' }}>
            {lastResult}
          </div>
        )}
      </Section>

      {presets.length > 0 && (
        <Section title="快速预设">
          <div className="row wrap" style={{ gap: 5 }}>
            {presets.map((p) => (
              <button
                key={p.id}
                className="btn tiny"
                disabled={p.available === false}
                onClick={() => {
                  const found = p.id.toLowerCase();
                  up((d) => {
                    if (found.includes('4k')) {
                      d.width = 3840;
                      d.height = 2160;
                      d.useCanvasSize = false;
                    } else if (found.includes('1080')) {
                      d.width = 1920;
                      d.height = 1080;
                      d.useCanvasSize = false;
                    } else if (found.includes('720')) {
                      d.width = 1280;
                      d.height = 720;
                      d.useCanvasSize = false;
                    }
                    if (found.includes('60')) d.fps = 60;
                    if (found.includes('30')) d.fps = 30;
                  });
                }}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Section>
      )}

      <Section title="说明">
        <div className="hint" style={{ lineHeight: 1.9 }}>
          · 导出使用与实时预览**完全相同**的渲染代码，因此逐帧画面一致。
          <br />
          · 视频背景在导出时会逐帧 seek 取帧，速度取决于磁盘与解码器。
          <br />
          · 若某种编码在当前浏览器不可用，会自动回退并在完成后提示。
        </div>
        <Checkbox checked label="导出完成后自动下载" onChange={() => void 0} />
      </Section>
    </>
  );
}
