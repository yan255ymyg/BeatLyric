/** 歌词编辑页：左侧逐拍歌词、右侧逐行歌词，中间可拖动调整宽度 */

import { useCallback, useRef, useState } from 'react';
import { BeatLyricsEditor } from '../components/BeatLyricsEditor';
import { LineLyricsEditor } from '../components/LineLyricsEditor';
import { TimelineToolbar } from '../components/TimelineToolbar';
import { Splitter } from '../components/Splitter';
import { clampSize } from '../components/Splitter';

export function LyricsEditorPage() {
  const rootRef = useRef<HTMLDivElement>(null);
  const [leftFrac, setLeftFrac] = useState(0.58);

  const onResize = useCallback(
    (delta: number) => {
      const w = rootRef.current?.clientWidth ?? 1200;
      setLeftFrac((f) => clampSize(f + delta / Math.max(1, w), 0.22, 0.82));
    },
    [],
  );

  return (
    <div
      className="workspace lyrics"
      ref={rootRef}
      style={{ gridTemplateColumns: `minmax(300px, ${leftFrac}fr) 6px minmax(280px, ${1 - leftFrac}fr)` }}
    >
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">逐拍歌词</span>
          <span className="hint">发音与时间点</span>
          <span style={{ flex: 1 }} />
        </div>
        <TimelineToolbar />
        <BeatLyricsEditor />
      </div>
      <Splitter onResize={onResize} onReset={() => setLeftFrac(0.58)} title="拖动调整两栏宽度（双击复位）" />
      <div className="panel">
        <div className="panel-head">
          <span className="panel-title">逐行歌词</span>
          <span className="hint">原文 / 翻译 / 注音</span>
        </div>
        <LineLyricsEditor />
      </div>
    </div>
  );
}
