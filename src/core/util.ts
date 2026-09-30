/** 通用工具 */

let counter = 0;

/** 生成短 id（会话内唯一即可，跨会话冲突概率极低） */
export function uid(prefix = 'id'): string {
  counter = (counter + 1) % 0xffff;
  const rand = Math.random().toString(36).slice(2, 8);
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** 四舍五入到指定小数位 */
export function round(v: number, digits = 3): number {
  const m = Math.pow(10, digits);
  return Math.round(v * m) / m;
}

/** 把 value 吸附到 1/div 网格 */
export function snapTo(value: number, div: number): number {
  if (!div || div <= 0) return value;
  return Math.round(value * div) / div;
}

export function nearlyEqual(a: number, b: number, eps = 1e-6): boolean {
  return Math.abs(a - b) < eps;
}

export const clamp01 = (v: number) => clamp(v, 0, 1);

/** 深拷贝（优先结构化克隆） */
export function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/** #rrggbb -> {r,g,b} */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  let h = hex.trim().replace('#', '');
  if (h.length === 3) h = h.split('').map((c) => c + c).join('');
  const n = Number.parseInt(h || '000000', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

export function rgba(hex: string, alpha: number): string {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${clamp(alpha, 0, 1)})`;
}

export function withAlpha(color: string, alpha: number): string {
  if (color.startsWith('#')) return rgba(color, alpha);
  return color;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds)) return '--:--.---';
  const sign = seconds < 0 ? '-' : '';
  const s = Math.abs(seconds);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const ms = Math.floor((s % 1) * 1000);
  return `${sign}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** 可读的拍号显示，例如 3.5 -> "3 1/2" */
export function formatBeat(beat: number): string {
  const whole = Math.floor(beat + 1e-9);
  const frac = beat - whole;
  if (frac < 1e-6) return String(whole);
  for (const d of [2, 3, 4, 6, 8]) {
    const n = frac * d;
    if (Math.abs(n - Math.round(n)) < 1e-6) return `${whole} ${Math.round(n)}/${d}`;
  }
  return beat.toFixed(3);
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

export function sortedInsertIndex<T>(arr: T[], value: number, get: (item: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (get(arr[mid]) < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 稳定排序：按 key 升序，key 相同按插入顺序 */
export function stableSortBy<T>(arr: readonly T[], key: (item: T) => number): T[] {
  return arr
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const d = key(a.item) - key(b.item);
      return d !== 0 ? d : a.index - b.index;
    })
    .map((x) => x.item);
}

/** 反序列化时不信任输入：取有限数字 */
export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

export function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}
