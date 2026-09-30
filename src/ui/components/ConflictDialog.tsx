/** 导入资源时的同名覆盖询问 */

import { useStore, type ConflictRequest } from '../../state/store';
import { formatBytes } from '../../core/util';

export function ConflictDialog({ request }: { request: ConflictRequest }) {
  const close = (decision: 'overwrite' | 'keep' | 'cancel') => {
    request.resolve(decision);
    useStore.getState().setConflict(null);
  };

  return (
    <div className="overlay">
      <div className="modal" style={{ width: 470 }}>
        <div className="modal-head">项目目录中已存在同名文件</div>
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            文件 <b style={{ color: 'var(--accent)' }}>{request.fileName}</b> 已经存在于项目的 <code>assets/</code> 目录，
            而且与这次导入的内容不同。
          </p>
          <table style={{ width: '100%', marginBottom: 10, color: 'var(--text-2)' }}>
            <tbody>
              <tr>
                <td>目录中现有文件</td>
                <td style={{ textAlign: 'right' }}>{formatBytes(request.existingSize)}</td>
              </tr>
              <tr>
                <td>本次导入文件</td>
                <td style={{ textAlign: 'right' }}>{formatBytes(request.incomingSize)}</td>
              </tr>
            </tbody>
          </table>
          <div className="hint">
            「覆盖」会用本次导入的内容替换目录中的同名文件；「保留现有文件」则沿用目录里已有的那份。
            一次导入多个文件时，每个同名冲突都会单独询问。
          </div>
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={() => close('cancel')}>
            取消导入
          </button>
          <button className="btn" onClick={() => close('keep')}>
            保留现有文件
          </button>
          <button className="btn primary" onClick={() => close('overwrite')}>
            覆盖
          </button>
        </div>
      </div>
    </div>
  );
}
