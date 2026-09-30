import { describe, expect, it } from 'vitest';
import {
  createBar,
  createEvent,
  createLyricLine,
  createProject,
  defaultLrcDisplay,
  spanOf,
} from './factories';
import {
  barSpanOfBeat,
  beatToSeconds,
  buildTimeline,
  computeBarLayout,
  secondsToBeat,
} from './timeline';
import { buildLrcEvents, computeLrcLayout, lrcStateAt, LrcCursor } from './lrc';
import type { Project } from '../model/model';

/**
 * 拍号约定：小节内第 1 拍 = 绝对拍 startBeat，也就是该小节时间轴的第 0 秒。
 * 因此 0 基的内部拍轴上，第 1 小节的第 1 拍是 beat 0。
 */
function project(): Project {
  const p = createProject('t');
  p.timeline.bpm = 120; // 1 拍 = 0.5s
  p.timeline.beatsPerNewBar = 4;
  p.bars = [createBar(4), createBar(4)];
  return p;
}

describe('buildTimeline', () => {
  it('匀速 120bpm：一小节 4 拍 = 2 秒', () => {
    const p = project();
    const tl = buildTimeline(p);
    expect(tl.totalBeats).toBe(8);
    expect(tl.endSec).toBeCloseTo(4, 9);
    expect(beatToSeconds(tl, 0)).toBeCloseTo(0, 9); // 第 1 小节第 1 拍 = 0s
    expect(beatToSeconds(tl, 1)).toBeCloseTo(0.5, 9);
    expect(beatToSeconds(tl, 4)).toBeCloseTo(2, 9); // 第 2 小节第 1 拍
    expect(secondsToBeat(tl, 1)).toBeCloseTo(2, 9);
  });

  it('bpm 事件从该拍起改变速率', () => {
    const p = project();
    const b = createEvent('bpm', 2); // 第 3 拍起 120 -> 240
    (b.data as { bpm: number }).bpm = 240;
    p.bars[0].events.push(b);
    const tl = buildTimeline(p);
    // beat0=0s、beat2=1s（前两拍 120bpm）；240bpm => 0.25s/拍
    expect(beatToSeconds(tl, 2)).toBeCloseTo(1, 9);
    expect(beatToSeconds(tl, 3)).toBeCloseTo(1.25, 9);
    expect(secondsToBeat(tl, 1.25)).toBeCloseTo(3, 9);
    expect(tl.bpmEvents).toHaveLength(1);
    expect(tl.bpmEvents[0].bpm).toBe(240);
    expect(tl.bpmEvents[0].sec).toBeCloseTo(1, 9);
  });

  it('暂停把后续事件整体推后', () => {
    const p = project();
    const e = createEvent('pause', 2);
    (e.data as { ms: number }).ms = 500;
    p.bars[0].events.push(e);
    const tl = buildTimeline(p);
    expect(beatToSeconds(tl, 2)).toBeCloseTo(1, 9); // 暂停前
    expect(beatToSeconds(tl, 3)).toBeCloseTo(2, 9); // 1 + 0.5(暂停) + 0.5(一拍)
    expect(tl.endSec).toBeCloseTo(4.5, 9);
    // 秒 -> 拍：1.2s 落在暂停区间 [1.0, 1.5) 内，播放头停在暂停点
    expect(secondsToBeat(tl, 1.2)).toBeCloseTo(2, 9);
    // 暂停从 1.0s 持续到 1.5s，因此 1.6s 已经过了暂停，走了 0.1s 即 0.2 拍
    expect(secondsToBeat(tl, 1.6)).toBeCloseTo(2.2, 9);
  });

  it('同一拍上的 bpm 事件与暂停都被正确处理', () => {
    const p = project();
    const e1 = createEvent('pause', 2);
    (e1.data as { ms: number }).ms = 100;
    const e2 = createEvent('bpm', 2);
    (e2.data as { bpm: number }).bpm = 60;
    p.bars[0].events.push(e1, e2);
    const tl = buildTimeline(p);
    // beat2 = 1s，暂停 0.1s，之后 60bpm => 1s/拍
    expect(beatToSeconds(tl, 3)).toBeCloseTo(2.1, 9);
    expect(tl.bpmEvents[0].bpm).toBe(60);
  });

  it('强制行进用指定毫秒走完覆盖的拍', () => {
    const p = project();
    const f = createEvent('force', 0);
    (f.data as { lengthBeats: number }).lengthBeats = 2;
    (f.data as { ms: number }).ms = 200;
    p.bars[0].events.push(f);
    const tl = buildTimeline(p);
    // beat0 -> beat2 用 200ms，之后恢复 0.5s/拍
    expect(beatToSeconds(tl, 2)).toBeCloseTo(0.2, 9);
    expect(beatToSeconds(tl, 4)).toBeCloseTo(1.2, 9);
    expect(tl.endSec).toBeCloseTo(3.2, 9);
    const tick = tl.ticks[0];
    expect(tick.type).toBe('force');
    expect(tick.durationBeats).toBeCloseTo(2, 9);
    expect(tick.endSec - tick.sec).toBeCloseTo(0.2, 9);
  });

  it('强制行进的覆盖长度会被夹取到小节内', () => {
    const p = project();
    const f = createEvent('force', 2);
    (f.data as { lengthBeats: number }).lengthBeats = 99;
    (f.data as { ms: number }).ms = 100;
    p.bars[0].events.push(f);
    const tl = buildTimeline(p);
    expect(tl.ticks[0].durationBeats).toBeCloseTo(2, 9); // 只能覆盖到小节末
  });

  it('小节拍数各自保存：改变某小节拍数会影响总拍数与后续起点', () => {
    const p = project();
    p.bars[0].beatCount = 8;
    const tl = buildTimeline(p);
    expect(tl.totalBeats).toBe(12);
    expect(tl.spans[1].startBeat).toBe(8);
    expect(beatToSeconds(tl, 8)).toBeCloseTo(4, 9);
  });

  it('越界事件不参与计算', () => {
    const p = project();
    p.bars[0].events.push(createEvent('pause', 4)); // 小节 0 只允许 [0,4)
    const tl = buildTimeline(p);
    expect(tl.ticks).toHaveLength(0);
  });

  it('多小节 bpm 与暂停混合', () => {
    const p = project();
    const b = createEvent('bpm', 4);
    (b.data as { bpm: number }).bpm = 60;
    p.bars[1].events.push(b);
    const tl = buildTimeline(p);
    // 0..2s 走完 4 拍；beat4 = 2s，之后 1s/拍
    expect(beatToSeconds(tl, 4)).toBeCloseTo(2, 9);
    expect(beatToSeconds(tl, 7)).toBeCloseTo(5, 9);
  });

  it('空项目也能得到合法时间轴', () => {
    const p = createProject('empty');
    p.bars = [];
    const tl = buildTimeline(p);
    expect(tl.totalBeats).toBe(0);
    expect(tl.endSec).toBe(0);
    expect(beatToSeconds(tl, 0)).toBe(0);
    expect(secondsToBeat(tl, 3)).toBe(0);
  });

  /**
   * 回归：秒 -> 拍 在小节边界处「提前跳到下一小节」的缺陷。
   *
   * 曾经的实现把「下一段的 beat 等于本段 endBeat」当作暂停来判定，
   * 但那对任何相邻段都成立，于是每到小节边界 `secondsToBeat` 就直接返回 `endBeat`：
   * 例如 2.25s（应为第 2 小节的第 4.5 拍）会错误返回 8，导致逐拍歌词整行错位。
   */
  it('秒 -> 拍 在小节边界处连续，不会提前跳到下一小节', () => {
    const p = project();
    const tl = buildTimeline(p);
    expect(secondsToBeat(tl, 1.9)).toBeCloseTo(3.8, 9);
    expect(secondsToBeat(tl, 2.0)).toBeCloseTo(4, 9);
    expect(secondsToBeat(tl, 2.25)).toBeCloseTo(4.5, 9);
    expect(secondsToBeat(tl, 3.0)).toBeCloseTo(6, 9);
    // 与拍 -> 秒 互为反函数
    for (const beat of [0, 0.5, 3.99, 4, 4.5, 7.5, 8]) {
      expect(secondsToBeat(tl, beatToSeconds(tl, beat))).toBeCloseTo(beat, 6);
    }
  });

  it('秒 -> 拍 在暂停区间内保持不动，暂停结束后继续前进', () => {
    const p = project();
    const e = createEvent('pause', 2);
    (e.data as { ms: number }).ms = 500;
    p.bars[0].events.push(e);
    const tl = buildTimeline(p);
    // 暂停点：1.0s 到达，持续到 1.5s。
    // 暂停之前正常推进；到达暂停点后播放头停住，直到暂停结束才继续。
    expect(secondsToBeat(tl, 0.5)).toBeCloseTo(1, 9);
    expect(secondsToBeat(tl, 0.9)).toBeCloseTo(1.8, 9);
    expect(secondsToBeat(tl, 1.0)).toBeCloseTo(2, 9);
    expect(secondsToBeat(tl, 1.2)).toBeCloseTo(2, 9);
    expect(secondsToBeat(tl, 1.49)).toBeCloseTo(2, 9);
    expect(secondsToBeat(tl, 1.5)).toBeCloseTo(2, 9);
    expect(secondsToBeat(tl, 1.6)).toBeCloseTo(2.2, 9);
    expect(secondsToBeat(tl, 2.0)).toBeCloseTo(3, 9);
  });
});

describe('computeBarLayout', () => {
  it('默认铺满整行', () => {
    const p = project();
    const tl = buildTimeline(p);
    const span = tl.spans[0];
    const layout = computeBarLayout(span, span.bar, 0);
    expect(layout.frameFrac.left).toBe(0);
    expect(layout.frameFrac.width).toBe(1);
    expect(layout.beats).toHaveLength(4);
    expect(layout.beats[0].left).toBeCloseTo(0, 9);
    expect(layout.beats[0].width).toBeCloseTo(0.25, 9);
    expect(layout.beats[3].left).toBeCloseTo(0.75, 9);
    expect(layout.beats[0].beat).toBe(0);
  });

  it('缩放 50% + 位置 25% 使时间轴居中，每拍宽度与 8 拍时一致', () => {
    const p = project();
    p.bars[0].beatCount = 4;
    p.bars[1].beatCount = 8;
    const tl = buildTimeline(p);
    const before = computeBarLayout(tl.spans[0], tl.spans[0].bar, 0);
    expect(before.beats[0].width).toBeCloseTo(0.25, 9);
    tl.spans[0].bar.transform = { scaleX: 0.5, offsetX: 0.25 };
    const after = computeBarLayout(tl.spans[0], tl.spans[0].bar, 0);
    expect(after.frameFrac.left).toBeCloseTo(0.25, 9);
    expect(after.frameFrac.width).toBeCloseTo(0.5, 9);
    expect(after.beats[0].width).toBeCloseTo(0.125, 9);
  });

  it('无论怎么设置都不会超出横向范围', () => {
    const p = project();
    const tl = buildTimeline(p);
    const bar = tl.spans[0].bar;
    bar.transform = { scaleX: 0.5, offsetX: 0.9 };
    const l = computeBarLayout(tl.spans[0], bar, 0);
    expect(l.frameFrac.left + l.frameFrac.width).toBeLessThanOrEqual(1 + 1e-9);
    bar.transform = { scaleX: 0.05, offsetX: -5 };
    const l2 = computeBarLayout(tl.spans[0], bar, 0);
    expect(l2.frameFrac.left).toBeGreaterThanOrEqual(0);
    expect(l2.frameFrac.left + l2.frameFrac.width).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('barSpanOfBeat', () => {
  it('按拍定位小节', () => {
    const p = project();
    p.bars[0].beatCount = 3;
    const tl = buildTimeline(p);
    expect(barSpanOfBeat(tl.spans, 0)?.index).toBe(0);
    expect(barSpanOfBeat(tl.spans, 2)?.index).toBe(0);
    expect(barSpanOfBeat(tl.spans, 3)?.index).toBe(1);
    expect(barSpanOfBeat(tl.spans, 99)?.index).toBe(1);
  });
});

describe('逐行歌词状态机', () => {
  function lrcProject(): Project {
    const p = project();
    p.lines = Array.from({ length: 5 }, () => createLyricLine());
    'ABCDE'.split('').forEach((ch, i) => {
      p.lines[i].subLines[0].spans = [spanOf(ch)];
    });
    return p;
  }

  it('下一句 / 上一句按偏移推进', () => {
    const p = lrcProject();
    p.bars[0].events.push(createEvent('lrcNext', 0)); // 0s
    p.bars[0].events.push(createEvent('lrcNext', 2)); // 1s
    p.bars[0].events.push(createEvent('lrcPrev', 3.5)); // 1.75s
    const events = buildLrcEvents(p);
    expect(events).toHaveLength(3);
    expect(lrcStateAt(p, 0).mainLine).toBe(1);
    expect(lrcStateAt(p, 0.5).mainLine).toBe(1);
    expect(lrcStateAt(p, 1.5).mainLine).toBe(2);
    expect(lrcStateAt(p, 2).mainLine).toBe(1);
  });

  it('下一句可以一次前进多块', () => {
    const p = lrcProject();
    const e = createEvent('lrcNext', 0);
    (e.data as { offset: number }).offset = 3;
    p.bars[0].events.push(e);
    expect(lrcStateAt(p, 0).mainLine).toBe(3);
  });

  it('越界夹取到首/末块', () => {
    const p = lrcProject();
    const e = createEvent('lrcPrev', 0);
    (e.data as { offset: number }).offset = 99;
    p.bars[0].events.push(e);
    expect(lrcStateAt(p, 0).mainLine).toBe(0);
    const e2 = createEvent('lrcNext', 1);
    (e2.data as { offset: number }).offset = 99;
    p.bars[0].events.push(e2);
    expect(lrcStateAt(p, 0.5).mainLine).toBe(4);
  });

  it('临时行进入与退出', () => {
    const p = lrcProject();
    const s = createEvent('lrcTempStart', 0);
    (s.data as { index: number }).index = 4;
    const e = createEvent('lrcTempEnd', 2);
    (e.data as { index: number }).index = 4;
    p.bars[0].events.push(s, e);
    expect(lrcStateAt(p, 0.25).tempLines).toEqual([4]);
    expect(lrcStateAt(p, 0.9).tempLines).toEqual([4]);
    expect(lrcStateAt(p, 1.5).tempLines).toEqual([]);
  });

  it('临时行索引可以从末尾计数（-1 = 最后一块）', () => {
    const p = lrcProject();
    expect(p.lines).toHaveLength(5);
    const s = createEvent('lrcTempStart', 0);
    (s.data as { index: number }).index = -1;
    (s.data as { indexMode?: string }).indexMode = 'fromEnd';
    p.bars[0].events.push(s);
    expect(lrcStateAt(p, 0).tempLines).toEqual([4]);
  });

  it('重复进入同一临时行只生效一次，且不会与主行重复', () => {
    const p = lrcProject();
    const mk = (beat: number, index: number) => {
      const e = createEvent('lrcTempStart', beat);
      (e.data as { index: number }).index = index;
      return e;
    };
    p.bars[0].events.push(mk(0, 2), mk(1, 2), mk(1.5, 0));
    expect(lrcStateAt(p, 2).tempLines).toEqual([2]);
  });

  it('LrcCursor 增量推进与一次性重放结果一致', () => {
    const p = lrcProject();
    const s = createEvent('lrcTempStart', 0);
    (s.data as { index: number }).index = 4;
    const n = createEvent('lrcNext', 2);
    const e = createEvent('lrcTempEnd', 4);
    (e.data as { index: number }).index = 4;
    p.bars[0].events.push(s, n);
    p.bars[1].events.push(e);
    const tl = buildTimeline(p);
    const cursor = new LrcCursor(p, tl);
    for (let t = 0; t <= 4; t += 0.05) {
      const a = cursor.advance(t);
      const b = lrcStateAt(p, t, tl);
      expect(a.mainLine).toBe(b.mainLine);
      expect(a.tempLines).toEqual(b.tempLines);
    }
    expect(cursor.seek(0.5)).toEqual(lrcStateAt(p, 0.5, tl));
    expect(cursor.seek(3)).toEqual(lrcStateAt(p, 3, tl));
  });});

describe('逐行版式', () => {
  function linesProject(count: number): Project {
    const p = createProject('t');
    p.lines = Array.from({ length: count }, () => createLyricLine());
    p.lines.forEach((l, i) => {
      l.subLines[0].spans = [spanOf(`L${i}`)];
    });
    return p;
  }

  it('主行居中，上下各取指定数量', () => {
    const p = linesProject(8);
    const cfg = defaultLrcDisplay();
    cfg.aboveCount = 2;
    cfg.belowCount = 2;
    const layout = computeLrcLayout(p.lines, { mainLine: 3, tempLines: [], cursor: 0 }, cfg);
    const pairs = layout.placed.map((x) => [x.lineIndex, x.role] as const);
    expect(pairs).toContainEqual([3, 'main']);
    expect(pairs).toContainEqual([2, 'context']);
    expect(pairs).toContainEqual([1, 'context']);
    expect(pairs).toContainEqual([4, 'context']);
    expect(pairs).toContainEqual([5, 'context']);
    expect(layout.placed.find((x) => x.role === 'main')!.y).toBe(0);
  });

  it('临时行移到主行下方并挤占下方名次（下方第 4、5 块被整体推下去）', () => {
    const p = linesProject(8);
    const cfg = defaultLrcDisplay();
    cfg.aboveCount = 2;
    cfg.belowCount = 2;
    // 主行是第 3 块（索引 3），让索引 6 进入临时行
    const layout = computeLrcLayout(p.lines, { mainLine: 3, tempLines: [6], cursor: 0 }, cfg);
    const temp = layout.placed.find((x) => x.role === 'temp')!;
    expect(temp.lineIndex).toBe(6);
    expect(temp.y).toBeGreaterThan(0);
    const contextIdx = layout.placed.filter((x) => x.role === 'context').map((x) => x.lineIndex);
    // 上方不变
    expect(contextIdx).toContain(2);
    expect(contextIdx).toContain(1);
    // 下方仍然取紧随主行的两块，但被临时行挤到更下面
    expect(contextIdx).toContain(4);
    expect(contextIdx).toContain(5);
    expect(contextIdx).not.toContain(6);
    const below = layout.placed.filter((x) => x.role === 'context' && x.y > 0);
    expect(below.map((x) => x.lineIndex)).toEqual([4, 5]);
    below.forEach((x) => expect(x.y).toBeGreaterThan(temp.y));
  });

  it('主行与临时行都突出显示；普通行使用非激活透明度', () => {
    const p = linesProject(6);
    const cfg = defaultLrcDisplay();
    const layout = computeLrcLayout(p.lines, { mainLine: 2, tempLines: [4], cursor: 0 }, cfg);
    const highlighted = layout.placed.filter((x) => x.highlighted).map((x) => x.lineIndex);
    expect(highlighted.sort()).toEqual([2, 4]);
    layout.placed
      .filter((x) => !x.highlighted)
      .forEach((x) => {
        expect(x.opacity).toBe(cfg.inactiveOpacity);
      });
    expect(layout.placed.find((x) => x.lineIndex === 4)!.opacity).toBe(cfg.tempOpacity);
  });

  it('主行是第一块时上方没有内容', () => {
    const p = linesProject(4);
    const cfg = defaultLrcDisplay();
    const layout = computeLrcLayout(p.lines, { mainLine: 0, tempLines: [], cursor: 0 }, cfg);
    expect(layout.placed.every((x) => x.role !== 'context' || x.y > 0)).toBe(true);
  });
});
