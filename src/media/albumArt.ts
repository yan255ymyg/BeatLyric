/**
 * 专辑图加载与黑胶（光碟）遮罩生成
 *
 * 说明
 *  - 图片与生成的纹理/遮罩都带缓存：同尺寸重复调用返回同一个 canvas 实例，
 *    避免在导出循环里每帧重复绘制（这是逐帧离线导出能跑满速度的关键之一）。
 *  - getDiscTexture() 返回的黑胶纹理带**透明中心孔**（用 destination-out 打孔）。
 *    推荐合成方式（先画专辑图，再用纹理打孔与压纹理）：
 *
 *    ```ts
 *    const disc = getDiscTexture(size, color);
 *    ctx.save();
 *    ctx.beginPath();
 *    ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
 *    ctx.clip();
 *    ctx.drawImage(albumImage, cx - size / 2, cy - size / 2, size, size); // 方形专辑图
 *    ctx.globalCompositeOperation = 'destination-out';
 *    ctx.drawImage(disc, cx - size / 2, cy - size / 2, size, size);       // 打出中心孔
 *    ctx.globalCompositeOperation = 'source-over';
 *    ctx.drawImage(disc, cx - size / 2, cy - size / 2, size, size);       // 压上纹理
 *    ctx.restore();
 *    ```
 */

const TAU = Math.PI * 2;

/* ------------------------------------------------------------------ */
/* 缓存                                                                */
/* ------------------------------------------------------------------ */

const imageCache = new Map<string, HTMLImageElement>();
const imagePromiseCache = new Map<string, Promise<HTMLImageElement>>();
const discCache = new Map<string, HTMLCanvasElement>();
const maskCache = new Map<string, HTMLCanvasElement>();

/** 释放全部图片 / 纹理 / 遮罩缓存（只丢弃引用，已经交给调用方的 canvas 仍然可用） */
export function clearImageCaches(): void {
  imageCache.clear();
  imagePromiseCache.clear();
  discCache.clear();
  maskCache.clear();
}

/* ------------------------------------------------------------------ */
/* 图片                                                                */
/* ------------------------------------------------------------------ */

/** 加载图片资源（返回可供 drawImage 的 HTMLImageElement）；同一 url 只加载一次 */
export async function loadImage(url: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(url);
  if (cached && cached.complete && cached.naturalWidth > 0) return cached;

  const pending = imagePromiseCache.get(url);
  if (pending) return pending;

  const task = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error(`无法加载图片资源：${url}`));
    image.src = url;
  }).then(
    (image) => {
      imageCache.set(url, image);
      imagePromiseCache.delete(url);
      return image;
    },
    (error: unknown) => {
      imagePromiseCache.delete(url);
      throw error instanceof Error ? error : new Error(`无法加载图片资源：${url}`);
    },
  );

  imagePromiseCache.set(url, task);
  return task;
}

/* ------------------------------------------------------------------ */
/* 遮罩 / 纹理                                                          */
/* ------------------------------------------------------------------ */

/** 生成圆形裁剪遮罩 canvas（用于把方图裁成圆）：白色实心圆，圆外透明 */
export function getCircleMask(size: number): HTMLCanvasElement {
  const s = normalizeSize(size);
  const key = String(s);
  const cached = maskCache.get(key);
  if (cached) return cached;

  const canvas = createCanvas(s);
  const ctx = require2d(canvas);
  ctx.clearRect(0, 0, s, s);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(s / 2, s / 2, s / 2, 0, TAU);
  ctx.closePath();
  ctx.fill();

  maskCache.set(key, canvas);
  return canvas;
}

/**
 * 生成黑胶唱片遮罩：中心圆孔 + 若干同心圆纹理，返回一个可复用的 canvas
 * （同尺寸 + 同颜色重复调用返回同一实例）。
 *
 * 圆盘外为透明；中心圆孔为真正的透明孔（destination-out 打孔），用于把专辑图打穿。
 */
export function getDiscTexture(size: number, color: string): HTMLCanvasElement {
  const s = normalizeSize(size);
  const key = `${s}|${color}`;
  const cached = discCache.get(key);
  if (cached) return cached;

  const canvas = createCanvas(s);
  const ctx = require2d(canvas);
  drawDisc(ctx, s, color);

  discCache.set(key, canvas);
  return canvas;
}

/* ------------------------------------------------------------------ */
/* 内部实现                                                             */
/* ------------------------------------------------------------------ */

function normalizeSize(size: number): number {
  if (!Number.isFinite(size) || size <= 0) return 1;
  return Math.max(1, Math.round(size));
}

function createCanvas(size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  return canvas;
}

function require2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法获取 2d 绘图上下文（canvas 尺寸过大或环境不支持）');
  return ctx;
}

function drawDisc(ctx: CanvasRenderingContext2D, size: number, color: string): void {
  const radius = size / 2;
  const centerX = radius;
  const centerY = radius;
  ctx.clearRect(0, 0, size, size);

  // 1) 唱片本体：以传入颜色为底色，叠一层斜向光泽
  ctx.save();
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(0.5, radius - size * 0.004), 0, TAU);
  ctx.closePath();
  ctx.clip();

  ctx.fillStyle = color;
  ctx.fillRect(0, 0, size, size);

  const sheen = ctx.createRadialGradient(
    centerX - radius * 0.35,
    centerY - radius * 0.35,
    Math.max(1, radius * 0.05),
    centerX,
    centerY,
    Math.max(2, radius * 1.15),
  );
  sheen.addColorStop(0, 'rgba(255, 255, 255, 0.20)');
  sheen.addColorStop(0.45, 'rgba(255, 255, 255, 0.03)');
  sheen.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);

  // 2) 同心圆纹理（音轨沟槽）
  const grooveCount = Math.max(16, Math.round(size / 10));
  const grooveInner = radius * 0.40;
  const grooveOuter = radius * 0.985;
  ctx.lineWidth = Math.max(1, size * 0.0015);
  for (let i = 0; i < grooveCount; i++) {
    const r = grooveInner + ((grooveOuter - grooveInner) * i) / (grooveCount - 1);
    ctx.beginPath();
    ctx.arc(centerX, centerY, r, 0, TAU);
    ctx.strokeStyle = i % 2 === 0 ? 'rgba(255, 255, 255, 0.06)' : 'rgba(0, 0, 0, 0.22)';
    ctx.stroke();
  }

  // 3) 中心标签圈（黑胶的纸质标签边界）
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(1, radius * 0.36), 0, TAU);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = Math.max(1, size * 0.004);
  ctx.stroke();

  // 4) 外圈高光
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(0.5, radius - size * 0.006), 0, TAU);
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
  ctx.lineWidth = Math.max(1, size * 0.006);
  ctx.stroke();

  ctx.restore();

  // 5) 中心圆孔：真正打穿（透明），便于调用方用 destination-out 在专辑图上挖孔
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(centerX, centerY, Math.max(0.5, size * 0.035), 0, TAU);
  ctx.closePath();
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();
}
