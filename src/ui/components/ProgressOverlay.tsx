/** 长任务进度遮罩（用于视频导出） */

import type { ProgressInfo } from '../../state/store';

export function ProgressOverlay({ progress }: { progress: ProgressInfo }) {
  const pct = progress.total > 0 ? Math.min(100, (progress.value / progress.total) * 100) : 0;
  return (
    <div className="progress-overlay">
      <div className="progress-card">
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{progress.title}</div>
        <div className="hint">{progress.detail}</div>
        <div className="progress-bar">
          <div style={{ width: `${pct}%` }} />
        </div>
        <div className="hint" style={{ textAlign: 'right', fontFamily: 'var(--mono)' }}>
          {progress.value} / {progress.total}（{pct.toFixed(1)}%）
        </div>
      </div>
    </div>
  );
}
