/**
 * 可拖拽分割条
 *
 * 需求：界面各框架能手动调整宽度和高度。
 *
 * 宽高以**像素**保存在组件状态里（不是比例），这样窗口缩放时布局不会被意外改动；
 * 每个面板都有最小尺寸限制，避免被拖到不可用。
 */

import { useCallback, useRef, useState } from 'react';
import clsx from 'clsx';

export interface SplitterProps {
  /** 拖动方向：vertical = 左右拖（调整宽度） */
  direction?: 'vertical' | 'horizontal';
  /** 拖动时回调新的尺寸值（像素） */
  onResize: (deltaPx: number) => void;
  /** 双击复位 */
  onReset?: () => void;
  title?: string;
}

export function Splitter({ direction = 'vertical', onResize, onReset, title }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const lastRef = useRef(0);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
      lastRef.current = direction === 'vertical' ? e.clientX : e.clientY;
      setDragging(true);
    },
    [direction],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const cur = direction === 'vertical' ? e.clientX : e.clientY;
      const delta = cur - lastRef.current;
      lastRef.current = cur;
      if (delta !== 0) onResize(delta);
    },
    [dragging, direction, onResize],
  );

  const stop = useCallback(() => setDragging(false), []);

  return (
    <div
      className={clsx('splitter', direction === 'vertical' ? 'vertical' : 'horizontal', dragging && 'dragging')}
      title={title ?? '拖动调整大小（双击复位）'}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDoubleClick={onReset}
    />
  );
}

/** 让某个尺寸值保持在 [min, max] 内的辅助函数 */
export function clampSize(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

/**
 * 面板尺寸状态：保存左右两侧的宽度（像素）。
 * 返回 current 与 adjust，便于在网格布局里直接用。
 */
export function useSplitSizes(initial: { left: number; right: number }) {
  const [left, setLeft] = useState(initial.left);
  const [right, setRight] = useState(initial.right);
  return {
    left,
    right,
    setLeft,
    setRight,
    adjustLeft: (d: number) => setLeft((v) => clampSize(v + d, 220, 900)),
    adjustRight: (d: number) => setRight((v) => clampSize(v - d, 240, 900)),
    reset: () => {
      setLeft(initial.left);
      setRight(initial.right);
    },
  };
}
