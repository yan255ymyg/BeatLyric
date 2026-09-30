/**
 * 重叠事件的命中测试与循环选择
 *
 * 需求：当多个事件在**指针位置**上重叠时，反复点击应在它们之间循环，
 * 每次点击把当前最上层的那个移到最下层，并选中下一个。
 *
 * 注意「重叠」的判定不是看拍号是否相同，而是看指针处实际有几个事件图标
 * —— 两个事件拍号不同但图标互相覆盖，同样算重叠。
 *
 * 这里做成纯函数，方便单元测试；DOM 层只负责把指针坐标与图标矩形传进来。
 */

export interface EventRect {
  id: string;
  /** 图标中心的 x（相对轨道左边） */
  x: number;
  /** 图标中心的 y（相对轨道顶边） */
  y: number;
  width: number;
  height: number;
}

export interface HitOptions {
  /** 命中容差（px），让「不太好点的小图标」也容易命中 */
  tolerance?: number;
}

/**
 * 找出指针命中的所有事件。
 *
 * @param rects 按**层叠顺序**排列（数组靠后的画在上面）
 * @returns 命中的矩形，**最上层在最前**（便于「点一次选最上面那个」）
 */
export function hitTestRects(
  rects: EventRect[],
  px: number,
  py: number,
  opts: HitOptions = {},
): EventRect[] {
  const tol = opts.tolerance ?? 3;
  const hits: EventRect[] = [];
  for (const r of rects) {
    const hw = Math.max(r.width / 2, 6) + tol;
    const hh = Math.max(r.height / 2, 8) + tol;
    if (Math.abs(px - r.x) <= hw && Math.abs(py - r.y) <= hh) hits.push(r);
  }
  // 数组靠后 = 画在上面，因此反转后即「从上到下」
  return hits.reverse();
}

export interface CycleResult {
  /** 本次应当选中的事件 id */
  selectedId: string;
  /** 需要被移到最下层的事件 id（上一次选中的那个），没有则为 null */
  sendToBackId: string | null;
  /** 下一次点击时使用的循环序号 */
  cycle: number;
}

/**
 * 决定一次点击应该选中哪个事件。
 *
 * 行为（对应需求 6）：
 *  - 普通点击：选中指针处**最上层**的事件。
 *  - 在同一个位置再次点击：把上一次选中的那个**送到最下层**，
 *    并选中现在最上层的那一个；反复点击就会在所有重叠事件之间循环。
 *  - Ctrl+点击：不参与循环，直接选中（由调用方做加选）。
 *
 * @param hits      指针命中的事件（最上层在前）
 * @param lastClick 上一次点击的位置与循环序号
 * @param px,py     本次点击位置
 * @param additive  是否 Ctrl+点击
 * @param previousSelectedId 当前已选中的事件（用于判断「是不是同一个」）
 */
export function resolveClick(
  hits: EventRect[],
  lastClick: { x: number; y: number; cycle: number } | null,
  px: number,
  py: number,
  additive: boolean,
  previousSelectedId?: string | null,
): CycleResult | null {
  if (!hits.length) return null;

  const sameSpot =
    lastClick !== null && Math.abs(lastClick.x - px) < 5 && Math.abs(lastClick.y - py) < 5;
  const cycleFrom = sameSpot && !additive ? lastClick!.cycle : -1;
  const cycle = cycleFrom + 1;

  // 同一处反复点击且确实有重叠：本次选中「下一个」
  if (cycleFrom >= 0 && hits.length > 1) {
    const idx = Math.min(cycle, hits.length - 1);
    return { selectedId: hits[idx].id, sendToBackId: previousSelectedId ?? null, cycle };
  }
  // 普通点击：选最上层，循环序号归零
  return { selectedId: hits[0].id, sendToBackId: null, cycle: 0 };
}

/** 把某个事件移到数组最前（= 最下层） */
export function sendToBack<T extends { id: string }>(items: T[], id: string): T[] {
  const idx = items.findIndex((x) => x.id === id);
  if (idx <= 0) return items;
  const copy = [...items];
  const [item] = copy.splice(idx, 1);
  copy.unshift(item);
  return copy;
}
