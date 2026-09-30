import { describe, expect, it } from 'vitest';
import { createBar, createEvent, createProject } from '../core/factories';
import { buildTimeline } from '../core/timeline';
import type { EffectConfig, Project } from '../model/model';
import {
  createEffectFrame,
  EffectsPlan,
  flashEnvelope,
  pulseEnvelope,
  shakeEnvelope,
  type EffectFrame,
} from './effects';

/* ------------------------------------------------------------------ */
/* 夹具                                                                */
/* ------------------------------------------------------------------ */

const CANVAS = { width: 1920, height: 1080 };
const BEATS_PER_BAR = 4;

/** 120bpm、每小节 4 拍、每拍一个歌词字事件的基础项目（4 小节 = 16 拍 = 8 秒） */
function beatProject(barCount = 4, beatsPerBar = BEATS_PER_BAR): Project {
  const p = createProject('fx');
  p.timeline.bpm = 120; // 1 拍 = 0.5s
  p.timeline.beatsPerNewBar = beatsPerBar;
  p.bars = Array.from({ length: barCount }, () => createBar(beatsPerBar));
  p.bars.forEach((bar, bi) => {
    for (let k = 0; k < beatsPerBar; k++) bar.events.push(createEvent('char', bi * beatsPerBar + k));
  });
  return p;
}

function planOf(p: Project, configs: EffectConfig[]): EffectsPlan {
  return new EffectsPlan(buildTimeline(p), configs, { ...CANVAS, beatsPerBar: p.timeline.beatsPerNewBar });
}

let seq = 0;
function cfg(partial: Partial<EffectConfig> & { type: EffectConfig['type'] }): EffectConfig {
  seq += 1;
  return {
    id: `fx${seq}`,
    enabled: true,
    trigger: 'beat',
    strength: 1,
    durationMs: 200,
    frequency: 2,
    ...partial,
  };
}

function snapshot(f: EffectFrame): string {
  return JSON.stringify(f);
}

/**
 * 冻结一帧的深拷贝。
 * `at(t)` 默认复用同一个结果对象，所以直接持有两次调用的返回值会互相覆盖 ——
 * 比较不同调用的结果前必须深拷贝。
 */
function freeze(f: EffectFrame): EffectFrame {
  return JSON.parse(snapshot(f)) as EffectFrame;
}

/* ------------------------------------------------------------------ */
/* 触发点预计算                                                        */
/* ------------------------------------------------------------------ */

describe('EffectsPlan 触发点收集', () => {
  it('拍 / 小节 / 歌词字触发点数量正确', () => {
    const p = beatProject(4, 4); // 16 拍 / 4 小节 / 16 个歌词字
    const plan = planOf(p, [
      cfg({ type: 'beatPulse', trigger: 'beat' }),
      cfg({ type: 'barPulse', trigger: 'bar' }),
      cfg({ type: 'charBounce', trigger: 'char' }),
      cfg({ type: 'beatPulse', trigger: 'beat', enabled: false }),
    ]);
    const count = (kind: 'beat' | 'bar' | 'char') => plan.triggers.filter((t) => t.kind === kind).length;
    expect(count('beat')).toBe(16);
    expect(count('bar')).toBe(4);
    expect(count('char')).toBe(16);
    expect(plan.triggers).toHaveLength(36);
    // 触发点按时间升序
    for (let i = 1; i < plan.triggers.length; i++) {
      expect(plan.triggers[i].time).toBeGreaterThanOrEqual(plan.triggers[i - 1].time - 1e-12);
    }
  });

  it('enabled=false 的配置完全不参与（也不会产生触发点）', () => {
    const p = beatProject(2, 4);
    const plan = planOf(p, [cfg({ type: 'shake', trigger: 'beat', enabled: false })]);
    expect(plan.triggers).toHaveLength(0);
    const f = plan.at(0.25);
    expect(f.shakeX).toBe(0);
    expect(f.shakeY).toBe(0);
    expect(plan.activeAt(0.25)).toBe(false);
  });

  it('小节拍数不同、事件为小数拍时也能正确求秒', () => {
    const p = createProject('mixed');
    p.timeline.bpm = 120; // 0.5 s/拍
    p.timeline.beatsPerNewBar = 4;
    p.bars = [createBar(4), createBar(4), createBar(8)];
    p.bars[0].events.push(createEvent('char', 0.5), createEvent('char', 3.5));
    p.bars[1].events.push(createEvent('char', 5), createEvent('char', 7.5));
    p.bars[2].events.push(createEvent('char', 8), createEvent('char', 15.5));
    p.bars[0].events.push(createEvent('char', 4)); // 越界：小节 0 只允许 [0, 4)
    const plan = planOf(p, [
      cfg({ type: 'beatPulse', trigger: 'beat' }),
      cfg({ type: 'barPulse', trigger: 'bar' }),
      cfg({ type: 'charBounce', trigger: 'char' }),
    ]);
    const count = (kind: 'beat' | 'bar' | 'char') => plan.triggers.filter((t) => t.kind === kind).length;
    expect(count('beat')).toBe(16);
    expect(count('bar')).toBe(3);
    expect(count('char')).toBe(6); // 越界事件被跳过
    expect(plan.triggers.filter((t) => t.kind === 'char').map((t) => t.time)).toEqual([0.25, 1.75, 2.5, 3.75, 4, 7.75]);
  });

  it('暂停会把后续触发点整体推后（time 单调递增，不会出现负 age）', () => {
    const p = beatProject(1, 4);
    const pause = createEvent('pause', 2);
    (pause.data as { ms: number }).ms = 500;
    p.bars[0].events.push(pause);
    const plan = planOf(p, [cfg({ type: 'beatPulse', trigger: 'beat' })]);
    // beat2 = 1s（暂停前一瞬），暂停 0.5s，之后 0.5s/拍
    const beats = plan.triggers.filter((t) => t.kind === 'beat').map((t) => t.time);
    expect(beats).toEqual([0, 0.5, 1, 2]);
    for (let i = 1; i < plan.triggers.length; i++) {
      expect(plan.triggers[i].time).toBeGreaterThanOrEqual(plan.triggers[i - 1].time);
    }
  });
});

/* ------------------------------------------------------------------ */
/* 中性结果                                                            */
/* ------------------------------------------------------------------ */

describe('无特效时的中性结果', () => {
  const neutral = (p: Project, t: number): EffectFrame =>
    planOf(p, [
      cfg({ type: 'shake', enabled: false }),
      cfg({ type: 'beatPulse', enabled: false }),
      cfg({ type: 'barPulse', enabled: false }),
      cfg({ type: 'charBounce', enabled: false }),
      cfg({ type: 'sparks', enabled: false }),
      cfg({ type: 'flash', enabled: false }),
    ]).at(t);

  it('scale=1、位移为 0、无闪光、无粒子', () => {
    const p = beatProject(4, 4);
    for (const t of [0, 0.25, 1, 3.3, 7.9, 9]) {
      const f = neutral(p, t);
      expect(f.scale).toBe(1);
      expect(f.shakeX).toBe(0);
      expect(f.shakeY).toBe(0);
      expect(f.offsetX).toBe(0);
      expect(f.offsetY).toBe(0);
      expect(f.flashAlpha).toBe(0);
      expect(f.flashColor).toBeNull();
      expect(f.particles).toEqual([]);
    }
  });

  it('配置数组为空时也返回中性结果', () => {
    const p = beatProject(1, 4);
    const f = planOf(p, []).at(0.1);
    expect(f).toEqual({
      shakeX: 0,
      shakeY: 0,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
      flashColor: null,
      flashAlpha: 0,
      particles: [],
    });
  });

  it('createEffectFrame 返回中性结果且 particles 非空数组', () => {
    const f = createEffectFrame();
    expect(f.scale).toBe(1);
    expect(Array.isArray(f.particles)).toBe(true);
    expect(f.particles).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* 各特效                                                              */
/* ------------------------------------------------------------------ */

describe('shake', () => {
  it('触发瞬间附近抖动非零，durationMs 之后归零', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 })]);
    // 触发点 t = 0（第 1 拍）
    expect(frameToZero(plan, 0)).toBe(true); // 触发瞬间包络为 0（sin(0)）
    let sawX = false;
    let sawY = false;
    for (let t = 0.001; t < 0.14; t += 0.001) {
      const f = plan.at(t);
      if (Math.abs(f.shakeX) > 1e-6) sawX = true;
      if (Math.abs(f.shakeY) > 1e-6) sawY = true;
      expect(Math.abs(f.shakeX)).toBeLessThanOrEqual(4 + 1e-9); // 强度即像素上限
    }
    expect(sawX).toBe(true);
    expect(sawY).toBe(true);
    // 时长之后：直到下一拍触发前都必须是 0
    for (const t of [0.141, 0.2, 0.3, 0.49]) {
      const f = plan.at(t);
      expect(f.shakeX).toBe(0);
      expect(f.shakeY).toBe(0);
    }
    // 下一拍（t = 0.5s）重新触发
    expect(Math.abs(plan.at(0.51).shakeX)).toBeGreaterThan(0);
  });
});

describe('beatPulse / barPulse', () => {
  it('触发瞬间 scale > 1，durationMs 之后回到 1', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [cfg({ type: 'beatPulse', trigger: 'beat', strength: 0.05, durationMs: 200 })]);
    expect(plan.at(0).scale).toBeCloseTo(1, 12);
    let peak = 1;
    for (let t = 0; t < 0.2; t += 0.002) peak = Math.max(peak, plan.at(t).scale);
    expect(peak).toBeGreaterThan(1.03);
    expect(peak).toBeLessThanOrEqual(1.05 + 1e-9); // 峰值 = 1 + strength
    expect(plan.at(0.21).scale).toBe(1);
    expect(plan.at(0.45).scale).toBe(1);
  });

  it('barPulse 在每小节第 1 拍触发，峰值缩放为 1 + strength', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [cfg({ type: 'barPulse', trigger: 'bar', strength: 0.1, durationMs: 200 })]);
    expect(plan.at(0.001).scale).toBeGreaterThan(1);
    expect(plan.at(0.02).scale).toBeGreaterThan(1.05);
    expect(plan.at(0.2).scale).toBe(1); // 第 1 小节脉冲结束
    expect(plan.at(1.05).scale).toBe(1); // 小节中间的拍不触发
    expect(plan.at(2.01).scale).toBeGreaterThan(1); // 第 2 小节（beat 4 = 2s）
  });

  it('多个脉冲同时命中时缩放松弛相乘', () => {
    const p = beatProject(1, 4);
    const a = planOf(p, [cfg({ type: 'beatPulse', trigger: 'beat', strength: 0.1, durationMs: 200 })]);
    const b = planOf(p, [cfg({ type: 'barPulse', trigger: 'bar', strength: 0.1, durationMs: 200 })]);
    const both = planOf(p, [
      cfg({ type: 'beatPulse', trigger: 'beat', strength: 0.1, durationMs: 200 }),
      cfg({ type: 'barPulse', trigger: 'bar', strength: 0.1, durationMs: 200 }),
    ]);
    const t = 0.03;
    const expected = a.at(t).scale * b.at(t).scale;
    expect(both.at(t).scale).toBeCloseTo(expected, 12);
  });
});

describe('charBounce', () => {
  it('由歌词字事件触发：向上位移（offsetY < 0）+ 放大', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [
      cfg({ type: 'charBounce', trigger: 'char', strength: 0.25, durationMs: 180, frequency: 2 }),
    ]);
    const atTrigger = plan.at(0.02);
    expect(atTrigger.offsetY).toBeLessThan(0);
    expect(atTrigger.scale).toBeGreaterThan(1);
    expect(-atTrigger.offsetY).toBeLessThanOrEqual(0.25 * CANVAS.height + 1e-9);
    expect(plan.at(0.19).offsetY).toBe(0);
    // 歌词字触发点位于每拍：0.5s 处应再次弹跳
    expect(plan.at(0.52).offsetY).toBeLessThan(0);
  });

  it('歌词字触发不会在小节内的空拍（无 char 事件）上发生', () => {
    const p = createProject('one');
    p.timeline.bpm = 120;
    p.timeline.beatsPerNewBar = 4;
    p.bars = [createBar(4)];
    p.bars[0].events.push(createEvent('char', 0)); // 只有第 1 拍有歌词字
    const plan = planOf(p, [cfg({ type: 'charBounce', trigger: 'char', strength: 0.25, durationMs: 180 })]);
    expect(plan.at(0.02).offsetY).toBeLessThan(0);
    expect(plan.at(0.52).offsetY).toBe(0); // 第 2 拍没有歌词字
    expect(plan.at(1.02).offsetY).toBe(0);
  });

  it('strength 换算：位移与画布高度成正比', () => {
    const p = beatProject(1, 4);
    const cfgA = cfg({ type: 'charBounce', trigger: 'char', strength: 0.1, durationMs: 200 });
    const cfgB = cfg({ type: 'charBounce', trigger: 'char', strength: 0.1, durationMs: 200 });
    const small = new EffectsPlan(buildTimeline(p), [cfgA], { width: 1920, height: 540, beatsPerBar: 4 });
    const large = new EffectsPlan(buildTimeline(p), [cfgB], { width: 1920, height: 1080, beatsPerBar: 4 });
    const a = -small.at(0.02).offsetY;
    const b = -large.at(0.02).offsetY;
    expect(a).toBeGreaterThan(0);
    expect(b / a).toBeCloseTo(2, 9);
  });
});

describe('sparks', () => {
  /** 只有一个触发点的项目（便于精确断言粒子数量） */
  function oneTriggerProject(): Project {
    const p = createProject('sparks');
    p.timeline.bpm = 120; // 0.5 s/拍
    p.timeline.beatsPerNewBar = 4;
    p.bars = [createBar(6)]; // 6 拍 = 3 秒
    p.bars[0].events.push(createEvent('char', 0));
    return p;
  }

  it('触发后粒子数量 = count，且比例坐标在合理范围内', () => {
    const plan = planOf(oneTriggerProject(), [
      cfg({ type: 'sparks', trigger: 'char', strength: 1, durationMs: 800, count: 10, color: '#ffd27f' }),
    ]);
    expect(plan.at(-0.1).particles).toHaveLength(0); // t < 触发时刻：还没有粒子
    const f = plan.at(0.2);
    expect(f.particles).toHaveLength(10);
    for (const pt of f.particles) {
      // x/y 是相对画布的比例 0..1（渲染器乘以画布尺寸）
      expect(pt.x).toBeGreaterThanOrEqual(0);
      expect(pt.x).toBeLessThanOrEqual(1);
      expect(pt.y).toBeGreaterThan(0);
      expect(pt.y).toBeLessThanOrEqual(1.2);
      expect(pt.color).toBe('#ffd27f');
      expect(pt.size).toBeGreaterThan(0);
      expect(pt.alpha).toBeGreaterThan(0);
      expect(pt.alpha).toBeLessThanOrEqual(1);
    }
    expect(plan.at(0.799).particles).toHaveLength(10); // 寿命内仍在
    expect(plan.at(0.8).particles).toHaveLength(0); // durationMs 之后消失
    expect(plan.at(5).particles).toHaveLength(0);
  });

  it('多个触发点的粒子会拼接在一起（受全局上限约束）', () => {
    const p = beatProject(1, 4); // 每拍都有歌词字
    const plan = planOf(p, [
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 800, count: 4, color: '#ffd27f' }),
    ]);
    expect(plan.at(0.3).particles).toHaveLength(4); // 只有 beat0（0s）
    // t = 0.7：beat0（0s）与 beat1（0.5s）两个触发点都在寿命内 -> 拼接
    expect(plan.at(0.7).particles).toHaveLength(8);
    expect(plan.at(1.31).particles).toHaveLength(4); // beat0/beat1 过期，只剩 beat2（1s）
    expect(plan.at(1.81).particles).toHaveLength(4); // beat3（1.5s）已触发
    expect(plan.at(2.31).particles).toHaveLength(0); // 全部过期（1.5s + 0.8s）
  });

  it('相同 t 连续两次求值结果完全相同（确定性，无 Math.random）', () => {
    const p = beatProject(2, 4);
    const plan = planOf(p, [
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 14, color: '#ffd27f' }),
      cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 }),
      cfg({ type: 'flash', trigger: 'bar', strength: 0.3, durationMs: 160 }),
    ]);
    const t = 0.6;
    const first = freeze(plan.at(t));
    const second = freeze(plan.at(t));
    expect(second).toEqual(first);
    expect(first.particles.length).toBeGreaterThan(0);

    // 乱序 / 跳帧求值也不影响结果（导出会这样调用）
    plan.at(7.7);
    plan.at(0.01);
    expect(freeze(plan.at(t))).toEqual(first);

    // 另一个 plan 实例（相同输入）也必须一致
    const plan2 = planOf(p, [
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 14, color: '#ffd27f' }),
      cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 }),
      cfg({ type: 'flash', trigger: 'bar', strength: 0.3, durationMs: 160 }),
    ]);
    expect(freeze(plan2.at(t))).toEqual(first);
  });

  it('粒子随时间下落（y 单调递增）并逐渐淡出', () => {
    const plan = planOf(oneTriggerProject(), [
      cfg({ type: 'sparks', trigger: 'char', strength: 1, durationMs: 800, count: 6 }),
    ]);
    const a = freeze(plan.at(0.2)).particles;
    const b = freeze(plan.at(0.4)).particles;
    expect(b).toHaveLength(a.length);
    for (let i = 0; i < a.length; i++) expect(b[i].y).toBeGreaterThan(a[i].y);
    // 透明度随寿命单调衰减
    const early = freeze(plan.at(0.25)).particles;
    const late = freeze(plan.at(0.7)).particles;
    expect(late).toHaveLength(early.length);
    for (let i = 0; i < early.length; i++) expect(late[i].alpha).toBeLessThan(early[i].alpha);
    // 寿命结束后粒子完全消失
    expect(plan.at(0.801).particles).toHaveLength(0);
    expect(plan.at(1.2).particles).toHaveLength(0);
  });

  it('粒子总数受全局上限约束（丢弃最旧）', () => {
    const p = beatProject(1, 4);
    const plan = planOf(p, [
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 100 }),
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 100 }),
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 100 }),
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 100 }),
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 100 }),
    ]);
    expect(plan.at(0.1).particles.length).toBeLessThanOrEqual(400);
  });
});

describe('flash', () => {
  it('触发时 flashAlpha = strength，之后衰减为 0', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [
      cfg({ type: 'flash', trigger: 'beat', strength: 0.25, durationMs: 160, color: '#ffffff' }),
    ]);
    const at = plan.at(0);
    expect(at.flashAlpha).toBeCloseTo(0.25, 12);
    expect(at.flashColor).toBe('#ffffff');
    expect(plan.at(0.08).flashAlpha).toBeGreaterThan(0);
    expect(plan.at(0.08).flashAlpha).toBeLessThan(0.25);
    expect(plan.at(0.16).flashAlpha).toBe(0);
    expect(plan.at(0.3).flashAlpha).toBe(0);
    expect(plan.at(0.16).flashColor).toBeNull();
  });

  it('多个闪光同时命中时取最强的一个（不做叠加混色）', () => {
    const p = beatProject(1, 4);
    const strong = planOf(p, [
      cfg({ type: 'flash', trigger: 'beat', strength: 0.6, durationMs: 200, color: '#ff0000' }),
    ]);
    const both = planOf(p, [
      cfg({ type: 'flash', trigger: 'beat', strength: 0.6, durationMs: 200, color: '#ff0000' }),
      cfg({ type: 'flash', trigger: 'beat', strength: 0.2, durationMs: 200, color: '#00ff00' }),
    ]);
    expect(both.at(0.05).flashAlpha).toBeCloseTo(strong.at(0.05).flashAlpha, 12);
    expect(both.at(0.05).flashColor).toBe('#ff0000');
    expect(both.at(0.05).flashAlpha).toBeLessThanOrEqual(0.6);
  });
});

/* ------------------------------------------------------------------ */
/* 触发源过滤                                                          */
/* ------------------------------------------------------------------ */

describe('触发源与 downbeatOnly', () => {
  it('downbeatOnly=true 时只有每小节第 1 拍产生触发', () => {
    const p = beatProject(4, 4);
    const plan = planOf(p, [
      cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24, downbeatOnly: true }),
    ]);
    expect(plan.at(0.01).shakeX).not.toBe(0);
    expect(plan.at(0.51).shakeX).toBe(0); // 小节内第 2 拍
    expect(plan.at(1.01).shakeX).toBe(0);
    expect(plan.at(2.01).shakeX).not.toBe(0); // 第 2 小节第 1 拍
    expect(plan.at(4.01).shakeX).not.toBe(0); // 第 3 小节第 1 拍
  });

  it('trigger=bar 只在每小节第 1 拍，trigger=char 只在歌词字上', () => {
    const p = createProject('trig');
    p.timeline.bpm = 120;
    p.timeline.beatsPerNewBar = 4;
    p.bars = [createBar(4), createBar(4), createBar(4), createBar(4), createBar(4)];
    // bar1 / bar3 有歌词字，bar0 / bar2 / bar4 没有
    for (const bi of [1, 3]) {
      for (const b of [bi * 4, bi * 4 + 2]) p.bars[bi].events.push(createEvent('char', b));
    }
    const plan = planOf(p, [
      cfg({ type: 'flash', trigger: 'bar', strength: 0.5, durationMs: 200, color: '#ffffff' }),
      cfg({ type: 'charBounce', trigger: 'char', strength: 0.2, durationMs: 200 }),
    ]);
    // 小节触发点：0s / 2s / 4s / 6s / 8s
    expect(plan.at(0).flashAlpha).toBeCloseTo(0.5, 12);
    expect(plan.at(2).flashAlpha).toBeCloseTo(0.5, 12);
    expect(plan.at(1).flashAlpha).toBe(0); // 小节中间不触发
    expect(plan.at(2.5).flashAlpha).toBe(0); // 2s 的闪光已经结束
    // 歌词字触发点：bar1 -> 2s / 3s；bar3 -> 6s / 7s
    expect(plan.at(2.01).offsetY).toBeLessThan(0);
    expect(plan.at(3.01).offsetY).toBeLessThan(0);
    expect(plan.at(6.01).offsetY).toBeLessThan(0);
    expect(plan.at(7.01).offsetY).toBeLessThan(0);
    expect(plan.at(0.01).offsetY).toBe(0); // bar0 没有歌词字
    expect(plan.at(2.6).offsetY).toBe(0); // 2s 的弹跳已结束，3s 还没到
  });

  it('activeAt 与实际效果一致', () => {
    const p = beatProject(4, 4);
    const configs = [cfg({ type: 'beatPulse', trigger: 'beat', strength: 0.05, durationMs: 200 })];
    const plan = planOf(p, configs);
    expect(plan.activeAt(0.1)).toBe(true);
    expect(plan.activeAt(0.3)).toBe(false);
    expect(plan.activeAt(0.6)).toBe(true);
    expect(plan.activeAt(-1)).toBe(false);
    expect(plan.activeAt(99)).toBe(false);
    // 关闭后永远是 false
    expect(planOf(p, [{ ...configs[0], enabled: false }]).activeAt(0.1)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 复用与包络                                                          */
/* ------------------------------------------------------------------ */

describe('输出复用与包络函数', () => {
  it('at(t, out) 复用对象时结果与新建对象一致（且旧粒子不会残留）', () => {
    const p = beatProject(2, 4);
    const plan = planOf(p, [
      cfg({ type: 'sparks', trigger: 'beat', strength: 1, durationMs: 900, count: 8 }),
      cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 }),
    ]);
    const reused = createEffectFrame();
    const t = 0.3;
    plan.at(t, reused);
    expect(snapshot(reused)).toBe(snapshot(freeze(plan.at(t))));
    const particles = reused.particles.length;
    expect(particles).toBeGreaterThan(0);
    // 同一个对象在下一帧被重置：不能残留上一帧的粒子
    plan.at(20, reused);
    expect(reused.particles).toHaveLength(0);
    expect(reused.scale).toBe(1);
  });

  it('包络函数在两端为 0、中间为正', () => {
    const D = 0.5;
    expect(shakeEnvelope(0, D, 4, 24)).toBe(0);
    expect(shakeEnvelope(D, D, 4, 24)).toBe(0);
    expect(shakeEnvelope(0.1, D, 4, 24)).not.toBe(0);
    expect(pulseEnvelope(0, D, 1, 2)).toBe(0);
    expect(pulseEnvelope(D, D, 1, 2)).toBe(0);
    expect(pulseEnvelope(0.05, D, 1, 2)).toBeGreaterThan(0);
    expect(pulseEnvelope(D / 2, D, 1, 2)).toBeGreaterThan(0);
    expect(flashEnvelope(0, D, 0.4, 1)).toBeCloseTo(0.4, 12);
    expect(flashEnvelope(D, D, 0.4, 1)).toBe(0);
    expect(flashEnvelope(0.25, D, 0.4, 1)).toBeGreaterThan(0);
    // 退化输入不产生 NaN
    expect(pulseEnvelope(0.1, 0, 1, 2)).toBe(0);
    expect(shakeEnvelope(0.1, 0, 1, 2)).toBe(0);
    expect(flashEnvelope(0.1, Number.NaN, 1, 2)).toBe(0);
  });
});

/* ------------------------------------------------------------------ */
/* 性能自检                                                            */
/* ------------------------------------------------------------------ */

describe('性能', () => {
  it('200 小节、每拍都有歌词字：2000 次 at(t) 远快于 2 秒', () => {
    const p = createProject('perf');
    p.timeline.bpm = 120; // 0.5 s/拍 -> 200 * 4 拍 = 400 秒
    p.timeline.beatsPerNewBar = 4;
    const bars = 200;
    p.bars = Array.from({ length: bars }, () => createBar(4));
    p.bars.forEach((bar, bi) => {
      for (let k = 0; k < 4; k++) bar.events.push(createEvent('char', bi * 4 + k));
    });
    const plan = planOf(p, [
      cfg({ type: 'shake', trigger: 'beat', strength: 4, durationMs: 140, frequency: 24 }),
      cfg({ type: 'beatPulse', trigger: 'beat', strength: 0.05, durationMs: 200 }),
      cfg({ type: 'barPulse', trigger: 'bar', strength: 0.05, durationMs: 260 }),
      cfg({ type: 'charBounce', trigger: 'char', strength: 0.2, durationMs: 180 }),
      cfg({ type: 'sparks', trigger: 'char', strength: 1, durationMs: 900, count: 8 }),
      cfg({ type: 'flash', trigger: 'bar', strength: 0.3, durationMs: 160, downbeatOnly: true }),
    ]);
    expect(plan.triggers.length).toBeGreaterThan(1000);

    const frame = createEffectFrame();
    const calls = 2000;
    const started = Date.now();
    let acc = 0;
    for (let i = 0; i < calls; i++) {
      const f = plan.at((i * 0.05) % 390, frame);
      acc += f.scale + f.shakeX + f.particles.length;
    }
    const elapsed = Date.now() - started;
    expect(acc).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(2000); // 留足余量避免偶发失败

    // 乱序访问（模拟导出跳帧）也不应该退化
    const shuffledStart = Date.now();
    for (let i = 0; i < calls; i++) {
      plan.at(((i * 137) % 7800) * 0.05, frame);
    }
    const shuffledElapsed = Date.now() - shuffledStart;
    expect(shuffledElapsed).toBeLessThan(2000);
    // 打印实测耗时，便于回归时对比
    console.info(
      `[effects perf] ${calls} 次顺序 at(): ${elapsed}ms；${calls} 次乱序 at(): ${shuffledElapsed}ms；` +
        `触发点 ${plan.triggers.length} 个`,
    );
  });
});

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

/** 该时刻的全部特效分量是否都处于中性值 */
function frameToZero(plan: EffectsPlan, t: number): boolean {
  const f = plan.at(t);
  return f.shakeX === 0 && f.shakeY === 0 && f.flashAlpha === 0 && f.offsetY === 0 && f.particles.length === 0;
}
