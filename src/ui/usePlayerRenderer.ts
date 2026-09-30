/**
 * 播放页渲染循环
 *
 * 用播放控制器的每帧回调驱动画布重绘：**不经过 React state**，
 * 因此拖动进度、播放、改设置都能保持 60fps，不会因为重渲染卡顿。
 * 项目 / 设置变化时重建特效计划与频谱分析器，并在下一帧生效。
 */

import { useEffect, useMemo, useRef } from 'react';
import { getTimeline, useStore } from '../state/store';
import { getPlayback } from '../playback/controller';
import { prepareCanvas } from '../render/canvasKit';
import { makeEffectsPlan, renderFrame, type RenderResources } from '../render/frameRenderer';
import { offlineSpectrumSource, realtimeSpectrumSource, type SpectrumSource } from '../render/spectrumRenderer';
import { OfflineSpectrum, RealtimeSpectrum } from '../media/spectrum';
import { ensurePeaks, peekSharedPeaks } from './waveformBridge';
import { fetchAudioForProject } from './audioBridge';
import { loadImageAsset, loadVideoAsset, peekImage, peekVideo } from './assetUrls';
import { getDiscTexture, getCircleMask } from '../media/albumArt';
import { LrcCursor } from '../core/lrc';

export interface PlayerRendererHandle {
  canvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** 强制重绘一次（编辑设置后立刻看到效果） */
  redraw: () => void;
}

export function usePlayerRenderer(
  canvasRef: React.RefObject<HTMLCanvasElement | null>,
  opts: { active: boolean },
): PlayerRendererHandle {
  const project = useStore((s) => s.project);
  const timeline = useMemo(() => getTimeline(project), [project]);

  const cursorRef = useRef<{ key: unknown; cursor: LrcCursor } | null>(null);
  const effectsRef = useRef<{ key: unknown; plan: ReturnType<typeof makeEffectsPlan> } | null>(null);
  const spectrumRef = useRef<{ key: unknown; source: SpectrumSource | null; realtime: RealtimeSpectrum | null; offline: OfflineSpectrum | null } | null>(null);
  const resourcesRef = useRef<RenderResources>({
    video: null,
    album: null,
    discTexture: null,
    circleMask: null,
    spectrum: null,
    effects: null,
  });
  const dirtyRef = useRef(true);
  const projectRef = useRef(project);
  projectRef.current = project;

  /* 逐行歌词游标（用于版式与高亮，与控制器里的那份保持一致） */
  const cursorOf = () => {
    const st = cursorRef.current;
    if (!st || st.key !== project) {
      const next = new LrcCursor(project, timeline);
      cursorRef.current = { key: project, cursor: next };
    }
    return cursorRef.current!.cursor;
  };

  /* 特效计划 */
  useEffect(() => {
    if (effectsRef.current?.key === project) return;
    effectsRef.current = { key: project, plan: makeEffectsPlan(project, timeline) };
    resourcesRef.current.effects = effectsRef.current.plan;
    dirtyRef.current = true;
  }, [project, timeline]);

  /* 素材加载 */
  useEffect(() => {
    let cancelled = false;
    const pb = project.playback;
    void (async () => {
      const albumAsset = pb.album.assetId ? project.assets[pb.album.assetId] : null;
      const videoAsset = pb.video.assetId ? project.assets[pb.video.assetId] : null;

      const [album, video] = await Promise.all([
        albumAsset ? loadImageAsset(albumAsset) : Promise.resolve(null),
        videoAsset ? loadVideoAsset(videoAsset) : Promise.resolve(null),
      ]);
      if (cancelled) return;
      resourcesRef.current.album = album ?? (pb.album.assetId ? peekImage(pb.album.assetId) : null);
      resourcesRef.current.video = video ?? (pb.video.assetId ? peekVideo(pb.video.assetId) : null);
      if (pb.album.discStyle) {
        const size = 512;
        resourcesRef.current.discTexture = getDiscTexture(size, pb.album.discColor);
        resourcesRef.current.circleMask = getCircleMask(size);
      } else {
        resourcesRef.current.discTexture = null;
        resourcesRef.current.circleMask = null;
      }
      dirtyRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [project, project.playback.album.assetId, project.playback.video.assetId, project.playback.album.discStyle, project.playback.album.discColor]);

  /* 频谱数据源 */
  useEffect(() => {
    const pb = project.playback;
    if (!pb.spectrum.enabled) {
      spectrumRef.current = null;
      resourcesRef.current.spectrum = null;
      return;
    }
    let cancelled = false;
    void (async () => {
      const buffer = await fetchAudioForProject(project);
      if (cancelled || !buffer) return;
      const offline = new OfflineSpectrum(buffer, {
        minFreq: pb.spectrum.minFreq,
        maxFreq: pb.spectrum.maxFreq,
        columns: pb.spectrum.columns,
        gain: pb.spectrum.gain,
      });
      spectrumRef.current = {
        key: project,
        offline,
        realtime: null,
        source: {
          columns: pb.spectrum.columns,
          sample: (out?: Float32Array) => offline.timeAt(getPlayback().positionSec, out),
        },
      };
      resourcesRef.current.spectrum = spectrumRef.current.source;
      dirtyRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
  }, [project, project.playback.spectrum.enabled, project.playback.spectrum.columns, project.playback.spectrum.minFreq, project.playback.spectrum.maxFreq]);

  /* 波形峰值预热（编辑器与导出都会用到） */
  useEffect(() => {
    void ensurePeaks();
  }, [project.audioAssetId, project.assets]);

  /* 主渲染函数 */
  const draw = useMemo(() => {
    return () => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const p = projectRef.current;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const ctx = prepareCanvas(canvas, p.canvas.width, p.canvas.height, dpr);

      const tl = getTimeline(p);
      const cursor = cursorOf();
      const pos = getPlayback().positionSec;
      const lrcState = cursor.seek(pos);

      // 实时频谱：把分析器接到播放链路上
      if (p.playback.spectrum.enabled) {
        const engine = getPlayback().engine;
        const sr = spectrumRef.current;
        if (!sr || sr.key !== p) {
          // 首次或项目变化：退化为离线频谱（若已就绪）
          if (sr?.offline) resourcesRef.current.spectrum = sr.source;
        } else if (!sr.realtime && engine.audioBuffer) {
          const rt = new RealtimeSpectrum(engine.ctx, {
            minFreq: p.playback.spectrum.minFreq,
            maxFreq: p.playback.spectrum.maxFreq,
            columns: p.playback.spectrum.columns,
            gain: p.playback.spectrum.gain,
          });
          try {
            engine.insertNode(rt.input);
            sr.realtime = rt;
            sr.source = realtimeSpectrumSource(
              rt.input as unknown as { getFloatFrequencyData(a: Float32Array): void; frequencyBinCount: number; context: BaseAudioContext; fftSize: number },
              (_mags, out) => rt.sample(out),
              p.playback.spectrum.columns,
            );
            resourcesRef.current.spectrum = sr.source;
          } catch {
            /* 插链失败时保持离线频谱 */
          }
        }
      }

      try {
        renderFrame(
          ctx,
          p,
          tl,
          pos,
          resourcesRef.current,
          {
            width: p.canvas.width,
            height: p.canvas.height,
            layoutScale: 1,
            lrcState,
            debug: false,
          },
        );
      } catch (err) {
        // 渲染失败不应让整个页面崩掉
        // eslint-disable-next-line no-console
        console.error('渲染失败', err);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasRef]);

  /* 订阅播放帧 + 项目变化 */
  useEffect(() => {
    const off = getPlayback().onFrame(() => draw());
    return off;
  }, [draw]);

  useEffect(() => {
    dirtyRef.current = true;
    draw();
  }, [project, draw, opts.active]);

  /* 实时播放时视频背景需要跟着走 */
  useEffect(() => {
    const pb = project.playback;
    if (!pb.video.enabled) return;
    const timer = window.setInterval(() => {
      const v = resourcesRef.current.video;
      if (!(v instanceof HTMLVideoElement)) return;
      const playing = getPlayback().engine.isPlaying;
      const t = getPlayback().positionSec + pb.video.offsetMs / 1000;
      if (playing) {
        if (v.paused) void v.play().catch(() => undefined);
        if (Math.abs(v.currentTime - t) > 0.35) v.currentTime = Math.max(0, t);
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - t) > 0.05) v.currentTime = Math.max(0, t);
      }
    }, 80);
    return () => window.clearInterval(timer);
  }, [project.playback.video.enabled, project.playback.video.offsetMs, project]);

  return { canvasRef, redraw: draw };
}

export { offlineSpectrumSource, peekSharedPeaks };
