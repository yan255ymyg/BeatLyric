/**
 * 特效引擎
 * ═════════
 *
 * 目标
 * ────
 * 播放页面（实时）与视频导出（离线逐帧）需要**同一套**特效求值逻辑。
 * 因此本模块只做纯计算：
 *
 *   const plan = new EffectsPlan(timeline, project.playback.effects, { width, height, beatsPerBar });
 *   plan.at(t, frame);   // t 为秒
 *
 * 「预计算 + 无状态求值」带来三个必要的性质：
 *  1. **确定性**：相同 (plan, configs, t) 永远得到逐位相同的结果。
 *     不读 `Date.now()`、不读帧率、不使用 `Math.random()`
 *     （粒子随机数来自基于 (triggerIndex, particleIndex) 的 mulberry32）。
 *  2. **无墙钟依赖**：导出可以任意跳帧、乱序、重复求值，画面完全一致。
 *  3. **可复用**：`at(t, out)` 把结果写进调用方传入的对象，逐帧调用零分配
 *     （抖动/脉冲与粒子数量无关，因此粒子按需生成）。
 *
 * 强度与坐标约定（渲染器实现时必须遵守）
 * ──────────────────────────────────────
 * | 特效                    | 影响的字段          | 强度含义 / 单位                       |
 * |-------------------------|---------------------|---------------------------------------|
 * | shake                   | shakeX / shakeY     | 像素（画布坐标），直接乘 strength     |
 * | beatPulse / barPulse    | scale               | 缩放增量：峰值 scale = 1 + strength   |
 * | charBounce              | offsetX / offsetY   | strength × 画布高度，向上为负（像素） |
 * | sparks                  | particles[].x / .y  | **比例坐标 0..1**，见下               |
 * | flash                   | flashColor/Alpha    | 峰值透明度 = strength（0..1）         |
 *
 * `ParticleState.x / y` 使用**相对画布的归一化比例 0..1**（画布左上角为 (0,0)，
 * x 向右、y 向下），渲染器绘制时乘以画布宽高即可，参见 `at()` 中 spawn 处的注释。
 *
 * 合成规则（多个特效同时命中同一个 t）
 * ────────────────────────────────────
 *  - shakeX / shakeY / offsetX / offsetY：**累加**
 *  - scale：**相乘**（基准 1）
 *  - flash：取**最强**的一个（透明度最大者；并列时取先出现的配置），不做叠加混色
 *  - particles：**拼接**，全局上限 `MAX_PARTICLES`，超出丢弃最旧的
 */

import type { EffectConfig } from '../model/model';
import { beatToSeconds, type Timeline } from '../core/timeline';

/** 粒子数量全局上限：超出后丢弃最旧的粒子（保证单帧成本有界） */
export const MAX_PARTICLES = 400;
/** 粒子默认颜色 */
export const DEFAULT_SPARK_COLOR = '#ffd27f';

/* ------------------------------------------------------------------ */
/* 公开类型                                                            */
/* ------------------------------------------------------------------ */

/** 特效在某一时刻的合成结果 */
export interface EffectFrame {
  /** 抖动位移，像素（画布坐标） */
  shakeX: number;
  shakeY: number;
  /** 整体缩放倍数，1 = 不缩放 */
  scale: number;
  /** 整体额外位移，像素（向上为负） */
  offsetX: number;
  offsetY: number;
  /** 闪光覆盖：颜色与透明度 */
  flashColor: string | null;
  flashAlpha: number;
  /**
   * 火星粒子。
   * `x` / `y` 为**相对画布的比例 0..1**（左上角为原点，y 向下），
   * `size` 为相对画布高度的比例，`alpha` 为 0..1 透明度。
   */
  particles: ParticleState[];
}

export interface ParticleState {
  x: number;
  y: number;
  size: number;
  alpha: number;
  color: string;
}

/** 一次触发（拍 / 小节 / 歌词字） */
export interface TriggerPoint {
  /** 触发时刻（秒） */
  time: number;
  /** 触发时刻的画布宽度与高度（用于把相对强度换算成像素） */
  width: number;
  height: number;
  /** 触发的拍号（整数四舍五入后的拍位置） */
  beat: number;
  /** 是否是小节第 1 拍 */
  downbeat: boolean;
}

export interface EffectsPlanOptions {
  /** 画布逻辑尺寸 */
  width: number;
  height: number;
  /** 每小节节拍数（用于判断 downbeat） */
  beatsPerBar: number;
}

/** 触发点种类 */
export type TriggerKind = 'beat' | 'bar' | 'char';

/* ------------------------------------------------------------------ */
/* 包络函数                                                            */
/* ------------------------------------------------------------------ */
/*
 * 全部包络满足 envelope(0) === 0 且 envelope(duration) === 0，
 * 这样「触发瞬间」与「结束瞬间」都自然落在中性值上，不会出现残影闪烁，
 * 也不需要在调用处做额外的边界特判。
 */

/** 检查包络参数是否可用；不可用（时长为 0 / 非有限）时视为「无效果」 */
function validEnvelope(age: number, duration: number, strength: number): boolean {
  return duration > 1e-9 && Number.isFinite(duration) && Number.isFinite(strength) && age >= 0 && age < duration;
}

/**
 * 抖动包络：`sin(age * frequency * 2π) * (1 - t)²`。
 * 高频正弦制造抖动，二次衰减保证结束前干净地回到 0。
 * frequency 为「每秒振荡次数」（frequency = 0 时退化为高频恒定振荡）。
 */
export function shakeEnvelope(age: number, duration: number, strength: number, frequency: number): number {
  if (!validEnvelope(age, duration, strength)) return 0;
  const t = age / duration;
  const decay = (1 - t) * (1 - t);
  const hz = Number.isFinite(frequency) && frequency > 0 ? frequency : 12;
  return Math.sin(age * hz * Math.PI * 2) * decay * strength;
}

/** 脉冲包络（beatPulse / barPulse）：先快速冲高、再回落，峰值 1（age = 0 时为 0） */
export function pulseEnvelope(age: number, duration: number, strength: number, frequency: number): number {
  void frequency;
  if (!validEnvelope(age, duration, strength)) return 0;
  const t = age / duration;
  // 0.12 处到达峰值，之后二次衰减到 0
  const peakAt = 0.12;
  const rise = t < peakAt ? t / peakAt : 1;
  const fall = 1 - t;
  return rise * rise * fall * fall * strength;
}

/** 歌词字弹跳包络：与脉冲同形，渲染器用它驱动「向上位移 + 放大」 */
export function bounceEnvelope(age: number, duration: number, strength: number, frequency: number): number {
  return pulseEnvelope(age, duration, strength, frequency);
}

/** 闪光包络：触发瞬间 = strength，随后三次衰减到 0 */
export function flashEnvelope(age: number, duration: number, strength: number, frequency: number): number {
  void frequency;
  if (!validEnvelope(age, duration, strength)) return 0;
  const t = age / duration;
  const decay = 1 - t;
  return decay * decay * decay * strength;
}

/**
 * 粒子透明度包络：从触发瞬间起**单调衰减**到 0。
 *
 * 说明：早先实现用的是 sin² 钟形曲线（先亮起再淡出），但火星应当是「出现即最亮、
 * 随下落逐渐熄灭」，而且单调衰减让「透明度随时间递减」成为一个稳定可断言的性质，
 * 因此改为 (1-t) 的平方。
 */
function alphaEnvelope(t: number): number {
  if (t <= 0 || t >= 1) return t <= 0 ? 1 : 0;
  const decay = 1 - t;
  return decay * decay;
}

/* ------------------------------------------------------------------ */
/* 确定性伪随机                                                        */
/* ------------------------------------------------------------------ */

/** mulberry32：32 位确定性伪随机，返回 [0,1)；禁止 Math.random() 以保证导出可复现 */
function mulberry32(seed: number): number {
  let a = (seed | 0) + 0x6d2b79f5;
  a = Math.imul(a ^ (a >>> 15), a | 1);
  a ^= a + Math.imul(a ^ (a >>> 7), a | 61);
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** 基于 (触发点序号, 粒子序号, 维度) 的确定性随机数 */
function hashRandom(triggerIndex: number, particleIndex: number, salt: number): number {
  const seed = (Math.imul(triggerIndex + 1, 0x9e3779b1) ^ Math.imul(particleIndex + 1, 0x85ebca6b) ^ Math.imul(salt + 1, 0xc2b2ae35)) | 0;
  return mulberry32(seed);
}

/* ------------------------------------------------------------------ */
/* 内部结构                                                            */
/* ------------------------------------------------------------------ */

interface TriggerRec {
  kind: TriggerKind;
  time: number;
  beat: number;
  downbeat: boolean;
}

/** 每个配置的预计算信息：数组下标同时充当粒子的随机种子 */
interface PreparedConfig {
  cfg: EffectConfig;
  /** 该配置关心的触发点种类 */
  kind: TriggerKind | null;
  durationSec: number;
}

/** 内部预计算数据：只有构造时写入，at() 期间完全只读（因此可重入） */
interface PlanCore {
  width: number;
  height: number;
  beatsPerBar: number;
  triggers: TriggerRec[];
  /** 全部触发点中最长的持续时间，用于界定候选窗口大小 */
  maxDurationSec: number;
  /** 候选窗口覆盖的触发点数量上界 */
  maxCandidates: number;
  configs: PreparedConfig[];
}

/**
 * 求值位置游标（只用于加速「最后一个 time <= t 的触发点」的定位）。
 * - 顺序求值（播放、导出逐帧）走「游标 + 少量线性前进」，均摊 O(1)；
 * - 跳帧 / 后退 / 随机求值走二分，O(log n)。
 */
interface ScanCursor {
  idx: number;
  time: number;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 找到最后一个 `time <= t` 的触发点下标（不存在则 -1）。
 * 传入可用游标时先用游标（顺序求值 O(1)，跳转时再二分）。
 */
function lastIndexAtOrBefore(triggers: TriggerRec[], t: number, cur: ScanCursor | null): number {
  const n = triggers.length;
  if (n === 0) return -1;
  if (cur) {
    const c = cur.idx;
    if (c >= 0 && c < n && cur.time <= t) {
      let j = c;
      while (j + 1 < n && triggers[j + 1].time <= t) j++;
      cur.idx = j;
      cur.time = triggers[j].time;
      return j;
    }
    if (c >= 0 && c <= n && (c >= n || triggers[c].time > t)) {
      // 游标在目标之后：只在游标之前搜索（向后跳转的常见情况）
      let lo = 0;
      let hi = Math.min(c, n - 1);
      let res = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (triggers[mid].time <= t) {
          res = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      if (res >= 0) {
        cur.idx = res;
        cur.time = triggers[res].time;
      }
      return res;
    }
  }
  let lo = 0;
  let hi = n - 1;
  let res = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (triggers[mid].time <= t) {
      res = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  if (res >= 0 && cur) {
    cur.idx = res;
    cur.time = triggers[res].time;
  }
  return res;
}

/** 该触发点是否匹配某个配置 */
function matches(cfg: EffectConfig, rec: TriggerRec): boolean {
  if (rec.kind !== cfg.trigger) return false;
  if (cfg.downbeatOnly && !rec.downbeat) return false;
  return true;
}

/** 触发点种类 == 配置 trigger 时返回它，否则返回 null */
function kindOf(cfg: EffectConfig): TriggerKind | null {
  return cfg.trigger === 'beat' || cfg.trigger === 'bar' || cfg.trigger === 'char' ? cfg.trigger : null;
}

/* ------------------------------------------------------------------ */
/* EffectsPlan                                                         */
/* ------------------------------------------------------------------ */

/**
 * 预计算：把时间轴上的拍/小节/歌词字事件转成触发点序列。
 * 这是纯计算，构造一次后可在实时播放与离线导出中反复求值。
 */
export class EffectsPlan {
  /** 全部触发点（按时间升序），便于调试与 UI 展示 */
  readonly triggers: { kind: TriggerKind; time: number }[];

  private readonly core: PlanCore;
  /** 顺序求值的共享游标（对相同结果无影响，只是加速） */
  private cursor: ScanCursor = { idx: -1, time: Number.NEGATIVE_INFINITY };

  constructor(timeline: Timeline, configs: EffectConfig[], opts: EffectsPlanOptions) {
    const width = Number.isFinite(opts.width) && opts.width > 0 ? opts.width : 1920;
    const height = Number.isFinite(opts.height) && opts.height > 0 ? opts.height : 1080;
    const beatsPerBar =
      Number.isFinite(opts.beatsPerBar) && opts.beatsPerBar >= 1 ? Math.round(opts.beatsPerBar) : 4;

    const raw = collectTriggerRecords(timeline, beatsPerBar, neededKinds(configs));
    raw.sort((a, b) => a.time - b.time);

    // 同一时刻的重复触发点（拍轴上相邻的拍被暂停压到同一秒）会产出完全相同的
    // 效果，去重后既能省算力，也让 triggers 列表更适合 UI 展示。
    const triggers: TriggerRec[] = [];
    for (const rec of raw) {
      const last = triggers[triggers.length - 1];
      if (last && last.kind === rec.kind && last.time === rec.time && last.downbeat === rec.downbeat) continue;
      triggers.push(rec);
    }

    let maxDurationSec = 0;
    for (const cfg of configs) {
      if (!cfg || cfg.enabled === false) continue;
      const d = Number.isFinite(cfg.durationMs) ? cfg.durationMs / 1000 : 0;
      if (d > maxDurationSec) maxDurationSec = d;
    }

    // 候选窗口上界：任何触发点只要与 t 的距离超过 maxDurationSec 就必然失效，
    // 因此一次 at(t) 最多只需要看这么多触发点，无需扫描全表。
    let maxCandidates = 1;
    for (let i = 0; i < triggers.length; i++) {
      const limit = triggers[i].time - maxDurationSec;
      let j = i;
      while (j - 1 >= 0 && triggers[j - 1].time >= limit) j--;
      if (i - j + 1 > maxCandidates) maxCandidates = i - j + 1;
    }

    const prepared: PreparedConfig[] = [];
    for (const cfg of configs) {
      if (!cfg || cfg.enabled === false) continue;
      const durationSec = Number.isFinite(cfg.durationMs) ? Math.max(0, cfg.durationMs) / 1000 : 0;
      prepared.push({ cfg, kind: kindOf(cfg), durationSec });
    }

    this.core = { width, height, beatsPerBar, triggers, maxDurationSec, maxCandidates, configs: prepared };
    this.triggers = triggers.map((r) => ({ kind: r.kind, time: r.time }));
  }

  /** 求 t 秒时的特效合成结果（确定性；可复用 out 以避免逐帧分配） */
  at(t: number, out?: EffectFrame): EffectFrame {
    const frame = out ?? createEffectFrame();
    // 因为结果对象可以被复用，每次调用都必须完整重置（帧内零分配）
    frame.shakeX = 0;
    frame.shakeY = 0;
    frame.scale = 1;
    frame.offsetX = 0;
    frame.offsetY = 0;
    frame.flashColor = null;
    frame.flashAlpha = 0;
    frame.particles.length = 0;
    if (!Number.isFinite(t)) return frame;

    const { triggers, configs, maxCandidates, height } = this.core;
    if (!configs.length || !triggers.length) return frame;

    // ── 定位候选窗口（性能的关键） ──────────────────────────────────
    // 触发点按时间升序。任何在 t 时刻仍然「有效」的触发点都满足
    //     rec.time <= t  且  t - rec.time < maxDurationSec
    // 所以它的下标必然落在最后 maxCandidates 个 time <= t 的触发点之内。
    // 于是每次 at(t) 只需扫描长度 <= maxCandidates 的一个滑窗：
    //   hi = 最后一个 time <= t 的下标（顺序求值用游标 O(1)，跳帧用二分 O(log n)）
    //   lo = hi - maxCandidates + 1
    // 完全不触碰其它触发点，复杂度与总触发点数无关。
    const hi = lastIndexAtOrBefore(triggers, t, this.cursor);
    if (hi < 0) return frame;
    let lo = hi - maxCandidates + 1;
    if (lo < 0) lo = 0;

    for (let ci = 0; ci < configs.length; ci++) {
      const pc = configs[ci];
      if (!pc.kind || pc.durationSec <= 0) continue;
      for (let i = lo; i <= hi; i++) {
        const rec = triggers[i];
        if (!matches(pc.cfg, rec)) continue;
        const age = t - rec.time;
        if (age < 0 || age >= pc.durationSec) continue;
        applyEffect(pc, i, age, frame, height);
      }
    }
    return frame;
  }

  /**
   * 当前时刻是否处于任何持续特效中（可选优化，不影响正确性）。
   * 同样只扫描候选窗口 [lo, hi]，不做全量扫描。
   */
  activeAt(t: number): boolean {
    const { triggers, configs, maxCandidates } = this.core;
    if (!configs.length || !triggers.length || !Number.isFinite(t)) return false;
    const hi = lastIndexAtOrBefore(triggers, t, this.cursor);
    if (hi < 0) return false;
    let lo = hi - maxCandidates + 1;
    if (lo < 0) lo = 0;
    for (let i = lo; i <= hi; i++) {
      const rec = triggers[i];
      const age = t - rec.time;
      if (age < 0) continue;
      for (let ci = 0; ci < configs.length; ci++) {
        const pc = configs[ci];
        if (pc.kind === rec.kind && age < pc.durationSec && matches(pc.cfg, rec)) return true;
      }
    }
    return false;
  }
}

/** 创建一个空的 EffectFrame（渲染器每帧重置用） */
export function createEffectFrame(): EffectFrame {
  return {
    shakeX: 0,
    shakeY: 0,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    flashColor: null,
    flashAlpha: 0,
    particles: [],
  };
}

/* ------------------------------------------------------------------ */
/* 触发点预计算                                                        */
/* ------------------------------------------------------------------ */

/**
 * 找出需要收集的触发点种类：只收集至少有一个 enabled 配置在用的种类，
 * 关闭全部特效时 `triggers` 为空（构造与求值都近乎零成本）。
 */
function neededKinds(configs: EffectConfig[]): Set<TriggerKind> {
  const kinds = new Set<TriggerKind>();
  for (const cfg of configs) {
    if (!cfg || cfg.enabled === false) continue;
    const k = kindOf(cfg);
    if (k) kinds.add(k);
  }
  return kinds;
}

/**
 * 收集全部触发点。
 *
 * - **拍**：遍历 `timeline.spans`，每拍的秒数用 `beatToSeconds` 求得
 *   （它已经处理了 bpm 事件、暂停与强制行进，是唯一可信的映射）。
 * - **小节**：每小节第 1 拍（`span.startBeat`），同样是 downbeat。
 * - **歌词字**：`timeline.ticks` 只包含 pause / force，因此必须自己遍历
 *   `span.bar.events` 里 `type === 'char'` 的事件。越界判断与
 *   `timeline.ts` 的 `collectEvents` 保持一致：
 *   `beat >= span.startBeat && beat < span.startBeat + span.beatCount`
 *   （含 1e-9 容差）。事件的拍号允许是小数（吸附到 1/2、1/3…）。
 */
function collectTriggerRecords(timeline: Timeline, beatsPerBar: number, kinds: Set<TriggerKind>): TriggerRec[] {
  const out: TriggerRec[] = [];
  const spans = timeline.spans ?? [];
  const wantBeat = kinds.has('beat');
  const wantBar = kinds.has('bar');
  const wantChar = kinds.has('char');
  if (!wantBeat && !wantBar && !wantChar) return out;

  for (let si = 0; si < spans.length; si++) {
    const span = spans[si];
    const lower = span.startBeat;
    const upper = span.startBeat + span.beatCount;

    // 每拍一个触发点；downbeat 是每小节第 1 拍
    if (wantBeat) {
      for (let k = 0; k < span.beatCount; k++) {
        const beat = span.startBeat + k;
        out.push({
          kind: 'beat',
          time: beatToSeconds(timeline, beat),
          beat: Math.round(beat),
          downbeat: k === 0,
        });
      }
    }

    // 小节触发点
    if (wantBar) {
      out.push({
        kind: 'bar',
        time: beatToSeconds(timeline, span.startBeat),
        beat: Math.round(span.startBeat),
        downbeat: true,
      });
    }

    // 歌词字触发点
    if (wantChar) {
      for (const ev of span.bar.events) {
        if (ev.type !== 'char') continue;
        if (!Number.isFinite(ev.beat) || ev.beat < lower - 1e-9 || ev.beat >= upper - 1e-9) continue;
        const b = Math.round(ev.beat);
        out.push({
          kind: 'char',
          time: beatToSeconds(timeline, ev.beat),
          beat: b,
          downbeat: ((b % beatsPerBar) + beatsPerBar) % beatsPerBar === 0,
        });
      }
    }
  }

  return out;
}

/* ------------------------------------------------------------------ */
/* 求值                                                                */
/* ------------------------------------------------------------------ */

/** 把某个配置在某触发点上的贡献叠加到 frame 上 */
function applyEffect(
  pc: PreparedConfig,
  triggerIndex: number,
  age: number,
  frame: EffectFrame,
  height: number,
): void {
  const { cfg, durationSec } = pc;
  switch (cfg.type) {
    case 'shake': {
      // 在 (+strength, -strength) 范围内抖动，像素
      const a = shakeEnvelope(age, durationSec, cfg.strength, cfg.frequency);
      frame.shakeX += a;
      frame.shakeY += a * 0.6;
      break;
    }
    case 'beatPulse':
    case 'barPulse': {
      // 峰值缩放 = 1 + strength，多个脉冲同时命中时相乘
      const v = pulseEnvelope(age, durationSec, cfg.strength, cfg.frequency);
      frame.scale *= 1 + v;
      break;
    }
    case 'charBounce': {
      // 向上位移 + 放大。位移 = strength * 画布高度（向上为负）
      const v = bounceEnvelope(age, durationSec, cfg.strength, cfg.frequency);
      frame.offsetY -= v * height;
      frame.scale *= 1 + v * 0.35;
      break;
    }
    case 'sparks': {
      const strength = Number.isFinite(cfg.strength) && cfg.strength !== 0 ? cfg.strength : 1;
      const count = Math.max(
        0,
        Math.min(MAX_PARTICLES, Math.round(Number.isFinite(cfg.count) ? (cfg.count as number) : 0)),
      );
      // 粒子物理（全部在「比例坐标」下积分，与画布像素尺寸无关）：
      //   y(u) = y0 + vy0·u + k·strength·u²      u ∈ [0,1] 为寿命进度
      //   x(u) = x0 + vx0·u
      // 标定方式：strength = 1 时整段寿命大约下落 0.7 个画布高度，
      // 即「火星边飘边落」，而落速仍随 strength 线性变化。
      const fallDistance = strength * 0.3;
      const spawnX = 0.35;
      const spawnVx = 0.12;
      const spawnVy = fallDistance * 0.22;
      const gravity = fallDistance * 0.85;
      const radius = 0.005;
      const color = cfg.color ?? DEFAULT_SPARK_COLOR;
      for (let p = 0; p < count; p++) {
        // 用 (触发点序号, 粒子序号, 维度) 生成确定性随机数 —— 不使用 Math.random()
        const rr = hashRandom(triggerIndex, p, 0);
        const ra = hashRandom(triggerIndex, p, 1);
        const rv = hashRandom(triggerIndex, p, 2);
        const ru = hashRandom(triggerIndex, p, 3);
        const rs = hashRandom(triggerIndex, p, 4);
        const x0 = spawnX + (rr - 0.5) * 0.5;
        const y0 = 0.2 + ra * 0.2;
        const vx = (rv - 0.5) * 2 * spawnVx;
        const vy = spawnVy * (0.6 + ru * 0.8);
        const u = age / durationSec;
        const posX = x0 + vx * u;
        const posY = y0 + vy * u + gravity * u * u;
        if (posY > 1.2) continue; // 已经完全落出画面，直接丢弃
        const size = radius * (0.5 + rs);
        if (frame.particles.length >= MAX_PARTICLES) {
          // 全局上限：丢弃最旧的粒子，保证单帧成本有界
          frame.particles.copyWithin(0, 1);
          frame.particles.length = MAX_PARTICLES - 1;
        }
        frame.particles.push({
          // 比例坐标 0..1，渲染器自行乘以画布宽高
          x: posX < 0 ? 0 : posX > 1 ? 1 : posX,
          y: posY,
          size,
          alpha: alphaEnvelope(u),
          color,
        });
      }
      break;
    }
    case 'flash': {
      const a = flashEnvelope(age, durationSec, cfg.strength, cfg.frequency);
      // 只取最强的一个（并列时保留先出现的），不做叠加混色
      if (a > frame.flashAlpha) {
        frame.flashAlpha = a;
        frame.flashColor = cfg.color ?? '#ffffff';
      }
      break;
    }
    default:
      break;
  }
}
