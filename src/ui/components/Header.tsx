/** 顶部栏：项目信息、页面切换、播放控制、进度条 */

import { useEffect, useMemo, useRef, useState } from 'react';
import clsx from 'clsx';
import { useStore } from '../../state/store';
import { getPlayback } from '../../playback/controller';
import { formatTimecode } from '../../playback/duration';
import { getTimeline } from '../../state/store';
import { clamp } from '../../core/util';
import { fetchAudioForProject } from '../audioBridge';

export function Header({
  onOpenFolder,
  onSaveAsZip,
  onShowShortcuts,
}: {
  onOpenFolder: () => void;
  onSaveAsZip: () => void;
  onShowShortcuts: () => void;
}) {
  const project = useStore((s) => s.project);
  const page = useStore((s) => s.page);
  const playing = useStore((s) => s.playing);
  const positionSec = useStore((s) => s.positionSec);
  const dirty = useStore((s) => s.dirty);
  const persisted = useStore((s) => s.persisted);
  const directory = useStore((s) => s.directory);
  const lastSavedAt = useStore((s) => s.lastSavedAt);
  const [editingName, setEditingName] = useState(false);
  const [audioDuration, setAudioDuration] = useState(0);
  const rafRef = useRef(0);

  /* 让进度条在播放时保持在 DOM 上跟随（不通过 React 高频重渲染） */
  const [pos, setPos] = useState(positionSec);
  useEffect(() => {
    setPos(positionSec);
  }, [positionSec]);
  useEffect(() => {
    const off = getPlayback().onFrame((p) => {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(() => setPos(p));
    });
    return () => {
      off();
      cancelAnimationFrame(rafRef.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const buf = await fetchAudioForProject(project);
      if (!cancelled) setAudioDuration(buf?.duration ?? 0);
    })();
    return () => {
      cancelled = true;
    };
  }, [project.audioAssetId, project.assets, project]);

  const total = useMemo(() => {
    const tl = getTimeline(project);
    const audioEnd = Math.max(0, audioDuration - project.timeline.audioOffsetMs / 1000);
    return Math.max(tl.endSec, audioEnd, 0.001);
  }, [project, audioDuration]);

  const toggle = () => getPlayback().toggle();

  return (
    <div className="header">
      <div className="brand">
        <span className="dot" />
        <span>逐拍歌词工作台</span>
      </div>

      <div className="page-tabs">
        <button className={clsx('page-tab', page === 'lyrics' && 'active')} onClick={() => useStore.getState().setPage('lyrics')}>
          歌词编辑
        </button>
        <button className={clsx('page-tab', page === 'player' && 'active')} onClick={() => useStore.getState().setPage('player')}>
          播放编辑
        </button>
      </div>

      <div className="transport">
        <button className="btn icon" title="回到开头 (Home)" onClick={() => getPlayback().seek(0)}>
          ⏮
        </button>
        <button className="btn primary icon" title="播放 / 暂停 (空格)" onClick={toggle} style={{ minWidth: 40 }}>
          {playing ? '⏸' : '▶'}
        </button>
        <div className="timecode">{formatTimecode(pos)}</div>
        <div className="seekbar">
          <input
            type="range"
            min={0}
            max={total}
            step={0.001}
            value={clamp(pos, 0, total)}
            onChange={(e) => getPlayback().seek(Number(e.target.value))}
          />
        </div>
        <div className="timecode" style={{ minWidth: 74, color: 'var(--text-2)' }}>
          {formatTimecode(total)}
        </div>
      </div>

      <div className="header-spacer" />

      <div className="row" style={{ gap: 6 }}>
        {editingName ? (
          <input
            className="input"
            autoFocus
            style={{ width: 150 }}
            defaultValue={project.meta.name}
            onBlur={(e) => {
              setEditingName(false);
              const v = e.target.value.trim() || '未命名项目';
              if (v !== project.meta.name) useStore.getState().commit('重命名项目', (d) => void (d.meta.name = v));
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') setEditingName(false);
            }}
          />
        ) : (
          <button
            className="btn ghost"
            title="点击重命名项目"
            onClick={() => setEditingName(true)}
            style={{ fontWeight: 600, maxWidth: 190, overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            {project.meta.name}
          </button>
        )}
        <span className="hint" title={persisted ? `项目目录：${directory.name}` : '尚未保存到磁盘'}>
          {persisted ? (dirty ? '● 未保存' : `已保存 ${lastSavedAt ? new Date(lastSavedAt).toLocaleTimeString() : ''}`) : '● 内存项目'}
        </span>
        <button className="btn" title="打开或创建项目文件夹（.blsp）" onClick={onOpenFolder}>
          打开项目
        </button>
        <button className="btn" title="导出项目为 ZIP 压缩包" onClick={onSaveAsZip}>
          导出 ZIP
        </button>
        <button className="btn ghost" title="快捷键 (?)" onClick={onShowShortcuts}>
          ?
        </button>
      </div>
    </div>
  );
}
