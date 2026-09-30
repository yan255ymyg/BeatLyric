/** 应用外壳：页面切换、全局快捷键、项目文件操作、提示与冲突弹窗 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useStore, makeRepository, setConflictResolver } from '../state/store';
import { getPlayback } from '../playback/controller';
import { Header } from './components/Header';
import { LyricsEditorPage } from './pages/LyricsEditorPage';
import { PlayerEditorPage } from './pages/PlayerEditorPage';
import { ConflictDialog } from './components/ConflictDialog';
import { Toasts } from './components/Toasts';
import { ProgressOverlay } from './components/ProgressOverlay';
import { pruneAssetUrls, disposeMediaCaches } from './assetUrls';
import { pickDirectory, fsApiSupported, downloadBlob } from '../core/storage';
import { deserializeProject } from '../core/serialize';

export default function App() {
  const page = useStore((s) => s.page);
  const project = useStore((s) => s.project);
  const toasts = useStore((s) => s.toasts);
  const conflict = useStore((s) => s.conflict);
  const progress = useStore((s) => s.progress);
  const [showShortcuts, setShowShortcuts] = useState(false);

  /* 冲突解决器：交给 UI 弹窗处理 */
  useEffect(() => {
    setConflictResolver(
      (info) =>
        new Promise((resolve) => {
          useStore.getState().setConflict({ ...info, resolve });
        }),
    );
  }, []);

  /* 首次进入时提示保存位置（内存项目不会在刷新后保留） */
  useEffect(() => {
    const t = setTimeout(() => {
      const s = useStore.getState();
      if (!s.persisted) {
        s.pushToast(
          'info',
          '当前是内存项目，刷新后不会保留',
          fsApiSupported()
            ? '点右上角「打开项目」选择一个文件夹（.blsp），之后所有改动会自动保存到那里。'
            : '当前浏览器不支持直接读写文件夹，建议用「导出 ZIP」保存项目，或改用 Chrome / Edge。',
        );
      }
    }, 1200);
    return () => clearTimeout(t);
  }, []);

  /* 资源 URL 随项目变化回收，并把音频同步给播放引擎 */
  useEffect(() => {
    pruneAssetUrls(project);
    void getPlayback().syncAudio(project);
  }, [project]);

  useEffect(() => () => disposeMediaCaches(), []);

  /* 播放状态与引擎同步 */
  useEffect(() => {
    const unsub = useStore.subscribe(() => {
      getPlayback().syncPlaybackState();
    });
    return unsub;
  }, []);

  /* 全局快捷键 */
  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable);

      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 'z') {
        if (typing) return;
        e.preventDefault();
        if (e.shiftKey) useStore.getState().redo();
        else useStore.getState().undo();
        getPlayback().redraw();
        return;
      }
      if (mod && e.key.toLowerCase() === 'y') {
        if (typing) return;
        e.preventDefault();
        useStore.getState().redo();
        getPlayback().redraw();
        return;
      }
      if (typing) return;
      if (e.code === 'Space') {
        e.preventDefault();
        getPlayback().toggle();
        return;
      }
      /* 逐拍歌词的事件操作：删除 / 复制 / 粘贴 */
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const ids = useStore.getState().selectedEventIds;
        if (ids.length) {
          e.preventDefault();
          useStore.getState().deleteSelectedEvents();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === 'c') {
        if (useStore.getState().selectedEventIds.length) {
          e.preventDefault();
          useStore.getState().copySelectedEvents();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === 'v') {
        if (useStore.getState().clipboard.length) {
          e.preventDefault();
          useStore.getState().pasteEvents();
          return;
        }
      }
      if (mod && e.key.toLowerCase() === 'a' && useStore.getState().selectedBarId) {
        // 全选当前小节里的事件
        const { project, selectedBarId } = useStore.getState();
        const bar = project.bars.find((b) => b.id === selectedBarId);
        if (bar) {
          e.preventDefault();
          useStore.getState().selectEvents(bar.events.map((ev) => ev.id));
          return;
        }
      }
      if (e.key === 'Home') {
        e.preventDefault();
        getPlayback().seek(0);
        return;
      }
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const stepSec = e.shiftKey ? 1 : 0.25;
        getPlayback().seek(getPlayback().positionSec + (e.key === 'ArrowRight' ? stepSec : -stepSec));
        return;
      }
      if (e.key === '?' || (e.key === '/' && e.shiftKey)) {
        setShowShortcuts((v) => !v);
      }
    },
    [],
  );

  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  /* 全局禁止浏览器右键菜单（需求：除输入状态外右键不弹菜单） */
  useEffect(() => {
    const block = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      e.preventDefault();
    };
    window.addEventListener('contextmenu', block);
    return () => window.removeEventListener('contextmenu', block);
  }, []);

  /* 自动保存：停止编辑 1.5 秒后写入项目文件 */
  const dirty = useStore((s) => s.dirty);
  const directory = useStore((s) => s.directory);
  useEffect(() => {
    if (!dirty) return;
    const t = setTimeout(async () => {
      const state = useStore.getState();
      const repo = makeRepository(state.directory);
      const res = await repo.saveProject(state.project);
      if (res.ok) state.markSaved();
      else state.pushToast('error', '自动保存失败', res.error);
    }, 1500);
    return () => clearTimeout(t);
  }, [dirty, directory, project]);

  const openFolder = async () => {
    if (!fsApiSupported()) {
      useStore.getState().pushToast('warn', '当前浏览器不支持直接读写文件夹', '请使用 Chrome / Edge。你仍然可以「导出为 ZIP」保存项目。');
      return;
    }
    try {
      const dir = await pickDirectory();
      if (!dir) return;
      const repo = makeRepository(dir);
      const store = useStore.getState();
      if (await repo.hasProject()) {
        const loaded = await repo.readProjectText();
        const { project: p, warnings } = deserializeProject(loaded);
        store.replaceProject(p, { persisted: true, dir });
        warnings.forEach((w) => store.pushToast('warn', w));
        store.pushToast('success', `已打开项目「${p.meta.name}」`);
      } else {
        store.replaceProject(store.project, { persisted: true, dir });
        await repo.saveProject(store.project);
        store.pushToast('success', `已创建项目目录「${dir.name}」`);
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
      useStore.getState().pushToast('error', '打开项目失败', String(err));
    }
  };

  const saveAsZip = async () => {
    const state = useStore.getState();
    const repo = makeRepository(state.directory);
    const blob = await repo.exportZip(state.project);
    downloadBlob(blob, `${state.project.meta.name || 'project'}.blsp.zip`);
    state.pushToast('success', '已导出项目压缩包');
  };

  const bodyClass = useMemo(() => clsx('app-body'), []);

  return (
    <div className="app">
      <Header onOpenFolder={openFolder} onSaveAsZip={saveAsZip} onShowShortcuts={() => setShowShortcuts(true)} />
      <div className={bodyClass}>
        {page === 'lyrics' ? <LyricsEditorPage /> : <PlayerEditorPage />}
      </div>
      <Toasts toasts={toasts} onDismiss={(id) => useStore.getState().dismissToast(id)} />
      {conflict && <ConflictDialog request={conflict} />}
      {progress?.active && <ProgressOverlay progress={progress} />}
      {showShortcuts && <ShortcutsModal onClose={() => setShowShortcuts(false)} />}
    </div>
  );
}

function ShortcutsModal({ onClose }: { onClose: () => void }) {
  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 460 }}>
        <div className="modal-head">键盘快捷键</div>
        <div className="modal-body">
          <table style={{ width: '100%', borderCollapse: 'collapse', lineHeight: 2 }}>
            <tbody>
              {[
                ['空格', '播放 / 暂停'],
                ['← / →', '后退 / 前进 0.25 秒'],
                ['Shift + ← / →', '后退 / 前进 1 秒'],
                ['Home', '回到开头'],
                ['Ctrl + Z', '撤销'],
                ['Ctrl + Shift + Z', '重做'],
                ['双击时间轴', '在该位置插入当前工具的图标'],
                ['右键事件', '删除该事件'],
                ['Delete', '删除选中事件'],
                ['拖动事件', '移动位置（按当前吸附网格）'],
                ['Alt + 点击拍位', '把选中事件移动到该拍位'],
                ['?', '显示 / 隐藏本帮助'],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ width: 150 }}>
                    <span className="kbd">{k}</span>
                  </td>
                  <td style={{ color: 'var(--text-1)' }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="modal-foot">
          <button className="btn primary" onClick={onClose}>
            知道了
          </button>
        </div>
      </div>
    </div>
  );
}
