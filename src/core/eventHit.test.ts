import { describe, expect, it } from 'vitest';
import { hitTestRects, resolveClick, sendToBack, type EventRect } from './eventHit';

/** 三个事件：a 在底层，c 在最上层，b/c 与 a 在指针处重叠 */
function rects(): EventRect[] {
  return [
    { id: 'a', x: 100, y: 20, width: 20, height: 30 },
    { id: 'b', x: 104, y: 22, width: 20, height: 30 },
    { id: 'c', x: 108, y: 18, width: 20, height: 30 },
    { id: 'far', x: 400, y: 20, width: 20, height: 30 },
  ];
}

describe('hitTestRects', () => {
  it('按指针位置命中，且最上层在最前', () => {
    const hits = hitTestRects(rects(), 104, 20);
    expect(hits.map((h) => h.id)).toEqual(['c', 'b', 'a']);
  });

  it('重叠判定基于图标矩形而不是拍号（拍号不同也会命中）', () => {
    const list: EventRect[] = [
      { id: 'e1', x: 50, y: 20, width: 16, height: 30 },
      { id: 'e2', x: 58, y: 20, width: 16, height: 30 }, // 拍号不同但图标重叠
    ];
    const hits = hitTestRects(list, 54, 20);
    expect(hits).toHaveLength(2);
  });

  it('远离所有图标时没有命中', () => {
    expect(hitTestRects(rects(), 250, 20)).toEqual([]);
  });

  it('容差让边界附近也能命中', () => {
    const list: EventRect[] = [{ id: 'x', x: 100, y: 20, width: 10, height: 10 }];
    expect(hitTestRects(list, 100 + 5 + 2, 20, { tolerance: 3 })).toHaveLength(1);
    expect(hitTestRects(list, 100 + 5 + 40, 20, { tolerance: 3 })).toHaveLength(0);
  });
});

describe('resolveClick 循环选择', () => {
  it('首次点击选中指针处最上层的事件', () => {
    const hits = hitTestRects(rects(), 104, 20);
    const r = resolveClick(hits, null, 104, 20, false);
    expect(r).toEqual({ selectedId: 'c', sendToBackId: null, cycle: 0 });
  });

  it('同一位置反复点击会在重叠事件之间循环，并把上一个送到最下层', () => {
    const hits = hitTestRects(rects(), 104, 20); // [c, b, a]
    const first = resolveClick(hits, null, 104, 20, false, null);
    expect(first).toEqual({ selectedId: 'c', sendToBackId: null, cycle: 0 });

    const second = resolveClick(hits, { x: 104, y: 20, cycle: first!.cycle }, 104, 20, false, 'c');
    expect(second).toEqual({ selectedId: 'b', sendToBackId: 'c', cycle: 1 });

    const third = resolveClick(hits, { x: 104, y: 20, cycle: second!.cycle }, 104, 20, false, 'b');
    expect(third).toEqual({ selectedId: 'a', sendToBackId: 'b', cycle: 2 });

    // 已经到底：继续点击不会越界
    const fourth = resolveClick(hits, { x: 104, y: 20, cycle: third!.cycle }, 104, 20, false, 'a');
    expect(fourth!.selectedId).toBe('a');
  });

  it('换一个位置点击会重新从最上层开始', () => {
    const hits = hitTestRects(rects(), 104, 20);
    const r = resolveClick(hits, { x: 300, y: 20, cycle: 2 }, 104, 20, false, 'b');
    expect(r).toEqual({ selectedId: 'c', sendToBackId: null, cycle: 0 });
  });

  it('只有 1 个事件时不进行循环', () => {
    const hits = hitTestRects([{ id: 'only', x: 10, y: 10, width: 20, height: 20 }], 10, 10);
    const r = resolveClick(hits, { x: 10, y: 10, cycle: 0 }, 10, 10, false, 'only');
    expect(r).toEqual({ selectedId: 'only', sendToBackId: null, cycle: 0 });
  });

  it('Ctrl+点击不参与循环（用于加选）', () => {
    const hits = hitTestRects(rects(), 104, 20);
    const r = resolveClick(hits, { x: 104, y: 20, cycle: 1 }, 104, 20, true, 'b');
    expect(r).toEqual({ selectedId: 'c', sendToBackId: null, cycle: 0 });
  });

  it('没点中任何事件时返回 null', () => {
    expect(resolveClick([], null, 0, 0, false)).toBeNull();
  });
});

describe('sendToBack', () => {
  it('把指定元素移到数组最前（渲染时画在最下层）', () => {
    const items = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    expect(sendToBack(items, 'c').map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('已经在最前或不存在时原样返回', () => {
    const items = [{ id: 'a' }, { id: 'b' }];
    expect(sendToBack(items, 'a')).toBe(items);
    expect(sendToBack(items, 'zzz')).toBe(items);
  });

  it('送到底层后，循环的「最上层」变成原来的第二个', () => {
    const list = [
      { id: 'a' },
      { id: 'b' },
      { id: 'c' },
    ];
    const after = sendToBack(list, 'c');
    expect(after[after.length - 1].id).toBe('b'); // 新的最上层
  });
});
