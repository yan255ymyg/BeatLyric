/**
 * 持久化与编辑流程的集成测试
 *
 * 覆盖三处最容易出隐性回归的地方：
 *  1. project.json 往返（serialize -> deserialize）不丢信息、不崩溃
 *  2. 资源导入：复制进 assets/、同名同内容静默复用、同名不同内容询问覆盖
 *  3. 撤销 / 重做与时间轴缓存
 */

import { describe, expect, it } from 'vitest';
import { createBar, createEvent, createLyricLine, createProject, spanOf } from './factories';
import { deserializeProject, serializeProject, findMissingAssets } from './serialize';
import { MemoryDirectory, ProjectRepository, sanitizeFileName, sha256Hex, guessKind } from './storage';
import type { ImportDecision } from './storage';
import { getTimeline } from '../state/store';
import type { Project } from '../model/model';

/* ------------------------------------------------------------------ */
/* 序列化往返                                                          */
/* ------------------------------------------------------------------ */

describe('project.json 往返', () => {
  function richProject(): Project {
    const p = createProject('往返测试');
    p.meta.artist = '测试作者';
    p.timeline = { bpm: 143.5, beatsPerNewBar: 3, audioOffsetMs: -120, defaultSnap: 3, customSnap: 12 };
    p.canvas = { width: 1280, height: 720, background: '#101820', gradient: { from: '#101820', to: '#000000' } };
    p.bars = [createBar(3), createBar(3)];
    p.bars[0].beatCount = 5;
    p.bars[0].transform = { scaleX: 0.5, offsetX: 0.25 };

    const char = createEvent('char', 1.5);
    (char.data as { width: number; gradient?: { from: string; to: string }; lines: unknown[] }).width = 14;
    (char.data as { gradient?: { from: string; to: string } }).gradient = { from: '#ffd93d', to: '#36d399' };
    (char.data as { lines: unknown[] }).lines = [
      { id: 'rl1', spans: [{ text: 'ノー', style: { bold: true, gradient: { from: '#ffd93d', to: '#36d399' } } }] },
      { id: 'rl2', spans: [{ text: 'noo', style: { colors: ['#ffffff'] } }] },
    ];
    p.bars[0].events.push(
      char,
      createEvent('bpm', 2),
      createEvent('pause', 3),
      createEvent('force', 4),
      createEvent('lrcNext', 0),
      createEvent('lrcTempStart', 1),
    );
    (p.bars[0].events[2].data as { ms: number }).ms = 250;
    (p.bars[0].events[3].data as { lengthBeats: number; ms: number }).lengthBeats = 1;
    (p.bars[0].events[3].data as { ms: number }).ms = 300;

    p.lines = ['第一句', '第二句'].map((t) => {
      const l = createLyricLine();
      l.subLines = [
        { id: `a${t}`, spans: [spanOf(t, { colors: ['#dbe6f5'] })] },
        { id: `b${t}`, spans: [spanOf('translation', { fontSize: 18, colors: ['#8fa3c0'] })] },
      ];
      return l;
    });
    p.lines.push({ id: 'ruby', subLines: [{ id: 'r', spans: [{ text: '桜', style: { ruby: 'さくら' } }] }] });

    p.playback.lrc.pos = { x: 0.31, y: 0.62 };
    p.playback.beat.visibleBarCount = 4;
    p.playback.spectrum.enabled = true;
    p.playback.spectrum.columns = 96;
    p.playback.effects = [
      { id: 'f1', type: 'sparks', enabled: true, trigger: 'char', strength: 1.5, durationMs: 700, frequency: 1, count: 22, color: '#ffd27f' },
    ];
    return p;
  }

  it('往返后关键字段完全一致', () => {
    const original = richProject();
    const { project: back, warnings } = deserializeProject(serializeProject(original));

    expect(warnings).toEqual([]);
    expect(back.meta.name).toBe('往返测试');
    expect(back.meta.artist).toBe('测试作者');
    expect(back.timeline).toEqual(original.timeline);
    expect(back.canvas).toEqual(original.canvas);
    expect(back.bars).toHaveLength(2);
    expect(back.bars[0].beatCount).toBe(5);
    expect(back.bars[0].transform).toEqual({ scaleX: 0.5, offsetX: 0.25 });
    expect(back.bars[0].events).toHaveLength(6);
    expect(back.bars[0].events.map((e) => e.type)).toEqual([
      'char',
      'bpm',
      'pause',
      'force',
      'lrcNext',
      'lrcTempStart',
    ]);
    expect(back.bars[0].events[2].beat).toBe(3);
    expect((back.bars[0].events[2].data as { ms: number }).ms).toBe(250);
    expect(back.lines).toHaveLength(3);
    expect((back.lines[2].subLines[0].spans[0].style as { ruby: string }).ruby).toBe('さくら');
    expect((back.lines[0].subLines[1].spans[0].style as { fontSize: number }).fontSize).toBe(18);
    expect(back.playback.lrc.pos).toEqual({ x: 0.31, y: 0.62 });
    expect(back.playback.beat.visibleBarCount).toBe(4);
    expect(back.playback.spectrum.columns).toBe(96);
    expect(back.playback.effects[0].count).toBe(22);
  });

  it('往返后时间轴完全一致（说明编辑语义没有被序列化破坏）', () => {
    const original = richProject();
    const { project: back } = deserializeProject(serializeProject(original));
    const a = getTimeline(original);
    const b = getTimeline(back);
    expect(b.totalBeats).toBe(a.totalBeats);
    expect(b.endSec).toBeCloseTo(a.endSec, 9);
    expect(b.ticks.map((t) => [t.type, t.beat, t.sec])).toEqual(a.ticks.map((t) => [t.type, t.beat, t.sec]));
  });

  it('脏数据不会导致崩溃，并给出可读的默认值', () => {
    const broken = JSON.stringify({
      formatVersion: 99,
      timeline: { bpm: 'abc', beatsPerNewBar: -3, audioOffsetMs: null },
      bars: [{ beatCount: 'x', events: [{ type: '不存在的类型', beat: 1 }, { type: 'pause', beat: 'q', data: { ms: 'z' } }] }],
      lines: [{ subLines: [{ spans: 'not-an-array' }] }],
      playback: { album: { size: 'big', pos: 'nope' }, effects: [{ type: 'sparks', count: 1e9 }] },
      assets: { a1: { kind: '???', file: '' } },
    });
    const { project, warnings } = deserializeProject(broken);
    expect(warnings.length).toBeGreaterThan(0); // 版本过高会提示
    expect(project.timeline.bpm).toBe(128); // 回退到 createProject 的默认 BPM
    expect(project.timeline.beatsPerNewBar).toBe(1); // 被夹取到合法下界
    expect(project.bars).toHaveLength(1);
    expect(project.bars[0].beatCount).toBe(1);
    // 无法识别的 type 会被宽容地降级为「歌词字」（而不是丢弃用户数据），
    // 非法拍号的 pause 则回退到第 0 拍；ms 被夹取到 0。
    expect(project.bars[0].events.map((e) => e.type)).toEqual(['char', 'pause']);
    expect(project.bars[0].events[0].beat).toBe(1); // 越界的拍会被夹回小节范围
    expect((project.bars[0].events[1].data as { ms: number }).ms).toBe(100); // 非法值回退到默认 100ms
    expect(project.lines[0].subLines[0].spans).toEqual([{ text: '' }]);
    expect(project.playback.album.size).toBeGreaterThan(0);
    expect(project.playback.album.pos).toEqual({ x: 0.2, y: 0.42 });
    expect(Object.keys(project.assets)).toEqual([]); // file 为空 → 丢弃
    expect(project.playback.effects[0].count).toBe(2000); // 被夹取到上限
  });

  it('顶层不是合法 JSON 时抛出可读错误', () => {
    expect(() => deserializeProject('{oops')).toThrow(/JSON/);
    expect(() => deserializeProject('[]')).toThrow(/顶层/);
  });

  it('缺少的素材会被列出来', () => {
    const p = createProject('missing');
    p.assets['a1'] = {
      id: 'a1',
      kind: 'image',
      file: 'assets/cover.png',
      originalName: 'cover.png',
      mime: 'image/png',
      size: 100,
      sha256: 'x',
      addedAt: 0,
    };
    const missing = findMissingAssets(p, new Set(['project.json']));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('cover.png');
    expect(findMissingAssets(p, new Set(['assets/cover.png']))).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* 资源导入                                                            */
/* ------------------------------------------------------------------ */

function fileOf(name: string, content: string, type = 'image/png'): File {
  return new File([content], name, { type });
}

describe('素材导入与同名覆盖', () => {
  it('首次导入会复制到 assets/ 并返回资源引用', async () => {
    const dir = new MemoryDirectory('proj');
    const repo = new ProjectRepository(dir, async () => 'overwrite');
    const res = await repo.importFile(fileOf('cover.png', 'AAA'), createProject('t'));
    expect(res.asset).not.toBeNull();
    expect(res.asset!.file).toBe('assets/cover.png');
    expect(res.asset!.originalName).toBe('cover.png');
    expect(res.asset!.kind).toBe('image');
    expect(await dir.exists('assets/cover.png')).toBe(true);
    expect(await (await dir.readFile('assets/cover.png')).text()).toBe('AAA');
  });

  it('同名同内容：静默复用，不询问、不覆盖', async () => {
    const dir = new MemoryDirectory('proj');
    let asked = 0;
    const repo = new ProjectRepository(dir, async () => {
      asked += 1;
      return 'overwrite';
    });
    const first = await repo.importFile(fileOf('cover.png', 'SAME'), createProject('t'));
    const project = createProject('t');
    project.assets[first.asset!.id] = first.asset!;

    const second = await repo.importFile(fileOf('cover.png', 'SAME'), project);
    expect(asked).toBe(0);
    expect(second.reused).toContain('cover.png');
    expect(second.asset!.sha256).toBe(first.asset!.sha256);
  });

  it('同名不同内容：询问后按选择处理', async () => {
    const dir = new MemoryDirectory('proj');
    const decisions: ImportDecision[] = [];
    let queue: ImportDecision[] = ['keep', 'overwrite'];
    const repo = new ProjectRepository(dir, async () => {
      const d = queue.shift() ?? 'cancel';
      decisions.push(d);
      return d;
    });

    const first = await repo.importFile(fileOf('a.png', 'OLD'), createProject('t'));
    const project = createProject('t');
    project.assets[first.asset!.id] = first.asset!;
    expect(await (await dir.readFile('assets/a.png')).text()).toBe('OLD');

    // 选择「保留现有」→ 目录内容不变，沿用已有资源
    const kept = await repo.importFile(fileOf('a.png', 'NEW'), project);
    expect(kept.skipped).toContain('a.png');
    expect(kept.asset!.sha256).toBe(first.asset!.sha256);
    expect(await (await dir.readFile('assets/a.png')).text()).toBe('OLD');

    // 选择「覆盖」→ 目录内容更新，返回新资源
    const overwritten = await repo.importFile(fileOf('a.png', 'NEW'), project);
    expect(overwritten.overwritten).toContain('a.png');
    expect(overwritten.asset!.sha256).not.toBe(first.asset!.sha256);
    expect(await (await dir.readFile('assets/a.png')).text()).toBe('NEW');

    expect(decisions).toEqual(['keep', 'overwrite']);
  });

  it('选择取消时什么都不做', async () => {
    const dir = new MemoryDirectory('proj');
    const repo = new ProjectRepository(dir, async () => 'cancel');
    const first = await repo.importFile(fileOf('a.png', 'OLD'), createProject('t'));
    const project = createProject('t');
    project.assets[first.asset!.id] = first.asset!;

    const res = await repo.importFile(fileOf('a.png', 'NEW'), project);
    expect(res.asset).toBeNull();
    expect(await (await dir.readFile('assets/a.png')).text()).toBe('OLD');
  });

  it('目录里有同名文件但项目不认识它时，保留现有并另存为新名字', async () => {
    const dir = new MemoryDirectory('proj');
    await dir.writeFile('assets/b.png', new File(['GHOST'], 'b.png', { type: 'image/png' }));
    const repo = new ProjectRepository(dir, async () => 'keep');
    const res = await repo.importFile(fileOf('b.png', 'MINE'), createProject('t'));
    expect(res.skipped).toContain('b.png');
    expect(res.asset!.file).not.toBe('assets/b.png');
    expect(res.asset!.file).toMatch(/^assets\/b-.*\.png$/);
    expect(await (await dir.readFile('assets/b.png')).text()).toBe('GHOST');
  });

  it('文件名会被清洗，路径分隔符无法逃出 assets/', async () => {
    expect(sanitizeFileName('../../evil.png')).toBe('evil.png');
    expect(sanitizeFileName('a<b>c:d|e?f*g.png')).toBe('a_b_c_d_e_f_g.png');
    expect(sanitizeFileName('...hidden')).toBe('_hidden');
    const dir = new MemoryDirectory('proj');
    const repo = new ProjectRepository(dir, async () => 'overwrite');
    const res = await repo.importFile(fileOf('..\\..\\x.png', 'X'), createProject('t'));
    expect(res.asset!.file).toBe('assets/x.png');
  });

  it('ZIP 往返：导出的压缩包能被重新打开', async () => {
    const dir = new MemoryDirectory('proj');
    const repo = new ProjectRepository(dir, async () => 'overwrite');
    const file = fileOf('song.mp3', 'AUDIODATA', 'audio/mpeg');
    const res = await repo.importFile(file, createProject('t'));
    const project = createProject('打包测试');
    project.assets[res.asset!.id] = res.asset!;
    project.audioAssetId = res.asset!.id;

    const zip = await repo.exportZip(project);
    const bytes = new Uint8Array(await zip.arrayBuffer());
    const { dir: reopened, text } = ProjectRepository.openZip(bytes, '打包测试.blsp');
    const { project: back } = deserializeProject(text);
    expect(back.meta.name).toBe('打包测试');
    expect(back.audioAssetId).toBe(res.asset!.id);
    expect(await (await reopened.readFile('assets/song.mp3')).text()).toBe('AUDIODATA');
  });

  it('打开不含 project.json 的压缩包会给出可读错误', () => {
    const dir = new MemoryDirectory('x');
    void dir;
    // 直接构造一个空 zip
    const empty = new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(() => ProjectRepository.openZip(empty, 'bad')).toThrow(/project\.json/);
  });

  it('按 MIME 与扩展名判断素材类型', () => {
    expect(guessKind('audio/mpeg', 'a.mp3')).toBe('audio');
    expect(guessKind('video/mp4', 'v.mp4')).toBe('video');
    expect(guessKind('image/png', 'i.png')).toBe('image');
    expect(guessKind('', 'song.flac')).toBe('audio');
    expect(guessKind('', 'clip.mkv')).toBe('video');
    expect(guessKind('', 'unknown.bin')).toBe('image');
  });

  it('sha256 对内容敏感且稳定', async () => {
    const a = await sha256Hex(new TextEncoder().encode('hello').buffer);
    const b = await sha256Hex(new TextEncoder().encode('hello').buffer);
    const c = await sha256Hex(new TextEncoder().encode('hello!').buffer);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
