/**
 * 兼容性检查工具（开发用）
 *
 * 把**任意** project.json 喂给 deserializeProject + buildTimeline + buildLrcEvents，
 * 打印关键字段的解析结果，用来确认旧版本的项目文件仍然能正常打开。
 *
 * 运行：
 *   npx tsx tools/checkCompat.ts path/to/project.json
 *
 * 它只读不写，不会修改传入的文件。没有传参时给出用法提示。
 */
import { readFileSync } from 'node:fs';
import { deserializeProject } from '../src/core/serialize';
import { buildTimeline } from '../src/core/timeline';
import { computeLrcLayout, buildLrcEvents } from '../src/core/lrc';

const file = process.argv[2];
if (!file) {
  console.error('用法：npx tsx tools/checkCompat.ts <project.json 路径>');
  console.error('用途：确认旧版本的 .blsp 项目文件在新代码下仍能正常解析。');
  process.exit(1);
}
const text = readFileSync(file, 'utf8');

const { project, warnings } = deserializeProject(text);
const tl = buildTimeline(project);
const lrcEvents = buildLrcEvents(project, tl);

let eventCount = 0;
let charWithColors = 0;
let charWithLegacyColor = 0;
for (const bar of project.bars) {
  for (const ev of bar.events) {
    eventCount++;
    if (ev.type === 'char') {
      const data = ev.data as { colors?: string[] };
      if (data.colors && data.colors.length) charWithColors++;
      else charWithLegacyColor++;
    }
  }
}

const layout = computeLrcLayout(project.lines, { mainLine: 0, tempLines: [], cursor: 0 }, project.playback.lrc);

console.log('=== 兼容性检查 ===');
console.log('文件            :', file);
console.log('读取告警        :', warnings.length ? warnings.join(' | ') : '（无）');
console.log('项目名          :', JSON.stringify(project.meta.name));
console.log('timeline        :', JSON.stringify(project.timeline));
console.log('小节数 / 总拍数  :', project.bars.length, '/', tl.totalBeats);
console.log('小节拍数        :', project.bars.map((b) => b.beatCount).join(','));
console.log('时间轴总秒数    :', tl.endSec.toFixed(3));
console.log('事件总数        :', eventCount);
console.log('歌词字带颜色栈  :', charWithColors, ' 无颜色（用默认）:', charWithLegacyColor);
console.log('逐行歌词块      :', project.lines.length, ' 块内子行总数:', project.lines.reduce((a, l) => a + l.subLines.length, 0));
console.log('逐行歌词事件    :', lrcEvents.length, lrcEvents.slice(0, 5).map((e) => `${e.kind}@${e.sec.toFixed(2)}s`).join(' '));
console.log('首屏版式块数    :', layout.placed.length, ' 版式总高:', layout.totalHeight.toFixed(1));
console.log('逐拍显示 scaleX/Y:', project.playback.beat.scaleX, '/', project.playback.beat.scaleY);
console.log('刻度宽度/主轴高 :', project.playback.beat.beatMarkWidth, '/', project.playback.beat.barHeight);
console.log('频谱启用        :', project.playback.spectrum.enabled);
console.log('特效数          :', project.playback.effects.length);
console.log('音频资源        :', project.audioAssetId ? project.assets[project.audioAssetId]?.originalName : '（无）');
console.log('素材数          :', Object.keys(project.assets).length);
console.log('=== 结论：旧文件可正常打开 ===');
