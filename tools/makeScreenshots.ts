/** 把 out/ 里的导出帧压成文档用截图（JPEG，控制体积） */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createCanvas, loadImage } from '@napi-rs/canvas';

const outDir = 'docs/screenshots';
mkdirSync(outDir, { recursive: true });

const items: { src: string; dst: string }[] = [
  { src: 'out/frame-0.45.png', dst: `${outDir}/playback-beat-lyrics.jpg` },
  { src: 'out/frame-0.00.png', dst: `${outDir}/playback-spectrum-and-sparks.jpg` },
  { src: 'out/frame-4.00.png', dst: `${outDir}/playback-force-progress.jpg` },
];

for (const it of items) {
  const img = await loadImage(readFileSync(it.src));
  const scale = 1280 / img.width;
  const w = Math.round(img.width * scale);
  const h = Math.round(img.height * scale);
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  const buf = canvas.toBuffer('image/jpeg', 82);
  writeFileSync(it.dst, buf);
  console.log(`${it.dst}  ${w}x${h}  ${(buf.length / 1024).toFixed(0)} KB`);
}
