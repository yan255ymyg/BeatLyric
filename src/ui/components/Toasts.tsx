/** 顶层提示条 */

import clsx from 'clsx';
import type { ToastMessage } from '../../state/store';

export function Toasts({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={clsx('toast', t.kind)} onClick={() => onDismiss(t.id)} title="点击关闭">
          <div>{t.text}</div>
          {t.detail && <div className="detail">{t.detail}</div>}
        </div>
      ))}
    </div>
  );
}
