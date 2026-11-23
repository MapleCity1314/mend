// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves = new Map<string, string>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

type LineFile = { lines: string[]; break: '\n' | '\r\n'; finalBreak: boolean };
type MatchTier = 0 | 1 | 2;
type HunkLine = { kind: 'context' | 'delete' | 'add'; text: string };
type UnifiedHunk = { a: number; oldLines: HunkLine[]; newLines: HunkLine[]; endNoBreak: boolean; bodyLine: number };
type SectionEdit = { oldPath: string | null; newPath: string | null; kind: 'change' | 'create' | 'delete' | 'move'; hunks: UnifiedHunk[] };
type MatchOptions = { strict: boolean; contextIndexes?: Map<number, number> };

function readLineFile(text: string): LineFile {
  const firstLf = text.indexOf('\n');
  const br: '\n' | '\r\n' = firstLf >= 0 && firstLf > 0 && text[firstLf - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], break: br, finalBreak: false };
  const finalBreak = text.endsWith(br);
  const parts = text.split(br);
  if (finalBreak) parts.pop();
  return { lines: parts, break: br, finalBreak };
}

function writeLineFile(file: LineFile): string {
  if (file.lines.length === 0) return '';
  return file.lines.join(file.break) + (file.finalBreak ? file.break : '');
}

function pathChecked(pathText: string): string {
  if (!safe(pathText)) throw new Fail('unsafe', pathText);
  return pathText;
}

function treeText(tree: Tree, pathText: string, missingCode: 'missing' | 'exists'): string {
  pathChecked(pathText);
  const t = tree.get(pathText);
  if (t === null) throw new Fail(missingCode, pathText);
  return t;
}

function equalAt(file: string[], pattern: string[], at: number, tier: MatchTier): boolean {
  if (at < 0 || at + pattern.length > file.length) return false;
  const norm = (s: string): string => tier === 0 ? s : tier === 1 ? s.replace(/[ \t]+$/g, '') : s.replace(/^[ \t]+|[ \t]+$/g, '');
  for (let i = 0; i < pattern.length; i += 1) if (norm(file[at + i]!) !== norm(pattern[i]!)) return false;
  return true;
}

function occurrences(file: string[], pattern: string[], tier: MatchTier): number[] {
  const out: number[] = [];
  if (pattern.length === 0) return out;
  for (let i = 0; i <= file.length - pattern.length; i += 1) if (equalAt(file, pattern, i, tier)) out.push(i);
  return out;
}

function findTier(file: string[], pattern: string[], strict: boolean): { tier: MatchTier | null; positions: number[] } {
  const tiers: MatchTier[] = strict ? [0] : [0, 1, 2];
  for (const tier of tiers) {
    const positions = occurrences(file, pattern, tier);
    if (positions.length > 0) return { tier, positions };
  }
  return { tier: null, positions: [] };
}

function rewriteLines(file: string[], oldLines: string[], newLines: string[], at: number, tier: MatchTier, contextIndexes?: Map<number, number>): string[] {
  const replacement = newLines.map((line, i) => {
    if (contextIndexes?.has(i)) return file[at + contextIndexes.get(i)!]!;
    if (tier !== 2 || line.trim() === '') return line;
    const f = (file[at]!.match(/^[ \t]*/) ?? [''])[0];
    const p = (oldLines[0]!.match(/^[ \t]*/) ?? [''])[0];
    return line.startsWith(p) ? f + line.slice(p.length) : line;
  });
  return [...file.slice(0, at), ...replacement, ...file.slice(at + oldLines.length)];
}

function replaceAtTier(file: string[], oldLines: string[], newLines: string[], at: number, tier: MatchTier, contextIndexes?: Map<number, number>): string[] {
  return rewriteLines(file, oldLines, newLines, at, tier, contextIndexes);
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function unifiedPath(raw: string, prefix: string): string | null {
  let p = raw.slice(4).split('\t', 1)[0]!.trim();
  if (p === '/dev/null') return null;
  if (p.startsWith(prefix)) p = p.slice(2);
  return p;
}

function parseHunkHeader(line: string, lineNumber: number): { a: number; b: number; c: number; d: number } {
  const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!m) throw new Exit2(`error: parse ${lineNumber}`);
  return { a: Number(m[1]), b: Number(m[2] ?? 1), c: Number(m[3]), d: Number(m[4] ?? 1) };
}

function parseUnified(lines: string[]): SectionEdit[] {
  const sections: SectionEdit[] = [];
  let i = 0;
  let current: SectionEdit | null = null;
  const ensure = (lineNo: number): SectionEdit => {
    if (!current) throw new Exit2(`error: parse ${lineNo}`);
    return current;
  };
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/([^ ]+) b\/([^ ]+)$/);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (current) sections.push(current);
      current = { oldPath: m[1]!, newPath: m[2]!, kind: 'change', hunks: [] };
      i += 1;
      continue;
    }
    if (line.startsWith('@@')) {
      const sec = ensure(i + 1);
      const h = parseHunkHeader(line, i + 1);
      const oldLines: HunkLine[] = [];
      const newLines: HunkLine[] = [];
      let endNoBreak = false;
      const startBody = i + 1;
      let j = startBody;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ') || (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ '))) break;
        if (b.startsWith('@@')) break;
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          const kind = b === '' || b[0] === ' ' ? 'context' : b[0] === '-' ? 'delete' : 'add';
          const hl = { kind, text: b === '' ? '' : b.slice(1) } as HunkLine;
          if (kind !== 'add') oldLines.push(hl);
          if (kind !== 'delete') newLines.push(hl);
          j += 1;
          continue;
        }
        if (b.startsWith('\\')) {
          if (j === startBody) throw new Exit2(`error: parse ${j + 1}`);
          if (b === '\\ No newline at end of file') endNoBreak = true;
          else throw new Exit2(`error: parse ${j + 1}`);
          j += 1;
          continue;
        }
        break;
      }
      while (oldLines.length > 0 && oldLines[oldLines.length - 1]!.kind === 'context' && oldLines[oldLines.length - 1]!.text === '' && lines[j - 1] === '') oldLines.pop();
      while (newLines.length > 0 && newLines[newLines.length - 1]!.kind === 'context' && newLines[newLines.length - 1]!.text === '' && lines[j - 1] === '') newLines.pop();
      sec.hunks.push({ a: h.a, oldLines, newLines, endNoBreak, bodyLine: startBody + 1 });
      i = j;
      continue;
    }
    if (line.startsWith('--- ')) {
      if ((lines[i + 1] ?? '').startsWith('+++ ')) {
        if (current && current.hunks.length === 0 && current.oldPath !== null && current.newPath !== null) {
          current.oldPath = unifiedPath(line, 'a/');
          current.newPath = unifiedPath(lines[i + 1]!, 'b/');
        } else {
          if (current) sections.push(current);
          current = { oldPath: unifiedPath(line, 'a/'), newPath: unifiedPath(lines[i + 1]!, 'b/'), kind: 'change', hunks: [] };
        }
        i += 2;
        continue;
      }
      if (current && current.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
    }
    if (current && current.hunks.length === 0) {
      if (line.startsWith('rename from ') && current.oldPath === null) current.oldPath = line.slice(12).trim();
      else if (line.startsWith('rename to ') && current.newPath === null) current.newPath = line.slice(10).trim();
      else if (line.startsWith('new file mode')) current.kind = 'create';
      else if (line.startsWith('deleted file mode')) current.kind = 'delete';
    }
    i += 1;
  }
  if (current) sections.push(current);
  for (const s of sections) {
    if (s.oldPath === null && s.newPath === null) throw new Exit2('error: parse 1');
    if (s.oldPath === null) s.kind = 'create';
    else if (s.newPath === null) s.kind = 'delete';
    else if (s.oldPath !== s.newPath) s.kind = 'move';
  }
  return sections;
}

function applyUnifiedHunk(file: string[], hunk: UnifiedHunk, d: number, strict: boolean, pathText: string): { lines: string[]; delta: number } {
  const oldLines = hunk.oldLines.map((x) => x.text);
  const newLines = hunk.newLines.map((x) => x.text);
  const contexts = new Map<number, number>();
  let ni = 0;
  for (const x of hunk.newLines) { if (x.kind === 'context') contexts.set(ni, hunk.oldLines.indexOf(x)); ni += 1; }
  let out: string[];
  if (oldLines.length === 0) {
    const at = Math.max(0, Math.min(file.length, hunk.a + d));
    out = [...file.slice(0, at), ...newLines, ...file.slice(at)];
  } else {
    const found = findTier(file, oldLines, strict);
    if (found.tier === null) throw new Fail('no-match', pathText);
    const target = hunk.a - 1 + d;
    const at = found.positions.reduce((best, p) => Math.abs(p - target) < Math.abs(best - target) || (Math.abs(p - target) === Math.abs(best - target) && p < best) ? p : best, found.positions[0]!);
    out = replaceAtTier(file, oldLines, newLines, at, found.tier, contexts);
  }
  return { lines: out, delta: newLines.length - oldLines.length };
}

function applyUnifiedSection(tree: Tree, section: SectionEdit, strict: boolean): void {
  if (section.oldPath) pathChecked(section.oldPath);
  if (section.newPath) pathChecked(section.newPath);
  if (section.kind === 'create') {
    const p = section.newPath!;
    if (tree.get(p) !== null) throw new Fail('exists', p);
    const adds = section.hunks.flatMap((h) => h.newLines.filter((x) => x.kind === 'add').map((x) => x.text));
    tree.now.set(p, adds.length ? adds.join('\n') + (section.hunks.at(-1)?.endNoBreak ? '' : '\n') : '');
    return;
  }
  if (section.kind === 'delete') {
    const p = section.oldPath!;
    if (tree.get(p) === null) throw new Fail('missing', p);
    tree.now.set(p, null);
    return;
  }
  const oldPath = section.oldPath!;
  const newPath = section.newPath!;
  const source = treeText(tree, oldPath, 'missing');
  if (section.kind === 'move' && tree.get(newPath) !== null) throw new Fail('exists', newPath);
  const lf = readLineFile(source);
  let lines = [...lf.lines];
  let d = 0;
  for (const h of section.hunks) { const applied = applyUnifiedHunk(lines, h, d, strict, oldPath); lines = applied.lines; d += applied.delta; }
  let finalBreak = lf.finalBreak;
  if (section.kind === 'move' || section.kind === 'change') {
    const last = section.hunks.at(-1);
    if (last && lines.length > 0 && last.endNoBreak === false && ((last.oldLines.length === 0 && last.a + d >= lines.length) || last.oldLines.length > 0)) finalBreak = lf.finalBreak;
    if (last?.endNoBreak) finalBreak = false;
    const result = writeLineFile({ lines, break: lf.break, finalBreak });
    if (section.kind === 'move') { tree.now.set(newPath, result); tree.now.set(oldPath, null); tree.moves.set(oldPath, newPath); }
    else tree.now.set(oldPath, result);
  }
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const sections = parseUnified(lines);
  return sections.map((s) => (tree) => applyUnifiedSection(tree, s, strict));
}

type SearchBlock = { pathText: string; oldLines: string[]; newLines: string[]; searchLine: number };

function parseSearchReplace(lines: string[]): SearchBlock[] {
  const out: SearchBlock[] = [];
  let previousPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') { i += 1; continue; }
    const searchLine = i + 1;
    let pathText: string | null = null;
    for (let j = i - 1; j >= 0; j -= 1) {
      const candidate = lines[j]!.trim();
      if (candidate === '' || candidate.startsWith('```')) continue;
      pathText = candidate;
      break;
    }
    if (pathText === null) pathText = previousPath;
    if (pathText === null) throw new Exit2(`error: parse ${searchLine}`);
    let sep = -1;
    for (let j = i + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '=======') { sep = j; break; }
    if (sep < 0) throw new Exit2(`error: parse ${searchLine}`);
    let end = -1;
    for (let j = sep + 1; j < lines.length; j += 1) if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { end = j; break; }
    if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
    out.push({ pathText, oldLines: lines.slice(i + 1, sep), newLines: lines.slice(sep + 1, end), searchLine });
    previousPath = pathText;
    i = end + 1;
  }
  return out;
}

function searchReplaceEdit(block: SearchBlock, strict: boolean): Edit {
  return (tree) => {
    pathChecked(block.pathText);
    if (block.oldLines.length === 0) {
      if (tree.get(block.pathText) !== null) throw new Fail('exists', block.pathText);
      tree.now.set(block.pathText, block.newLines.join('\n') + '\n');
      return;
    }
    const text = treeText(tree, block.pathText, 'missing');
    const lf = readLineFile(text);
    const found = findTier(lf.lines, block.oldLines, strict);
    if (found.tier === null) throw new Fail('no-match', block.pathText);
    if (found.positions.length !== 1) throw new Fail('ambiguous', block.pathText);
    const out = replaceAtTier(lf.lines, block.oldLines, block.newLines, found.positions[0]!, found.tier);
    tree.now.set(block.pathText, writeLineFile({ lines: out, break: lf.break, finalBreak: lf.finalBreak }));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const blocks = parseSearchReplace(lines);
  return blocks.map((b) => searchReplaceEdit(b, strict));
}

type V4AChunk = { anchor: string | null; body: HunkLine[]; end: boolean; line: number };
type V4ASection = { kind: 'add' | 'delete' | 'update'; pathText: string; moveTo: string | null; lines: string[]; chunks: V4AChunk[]; line: number };

function parseV4ASection(lines: string[], start: number): { section: V4ASection; next: number } {
  const header = lines[start]!;
  const m = header.match(/^\*\*\* (Add|Delete|Update) File: (.*)$/);
  if (!m) throw new Exit2(`error: parse ${start + 1}`);
  const section: V4ASection = { kind: m[1]!.toLowerCase() as 'add' | 'delete' | 'update', pathText: m[2]!.trim(), moveTo: null, lines: [], chunks: [], line: start + 1 };
  let i = start + 1;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line === '*** End Patch' || /^\*\*\* (Add|Delete|Update) File: /.test(line)) break;
    if (section.kind === 'add') {
      if (line === '') section.lines.push('');
      else if (line.startsWith('+')) section.lines.push(line.slice(1));
      else if (line.trim() !== '') throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (section.kind === 'delete') {
      if (line.trim() !== '') throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    if (section.moveTo === null && line.startsWith('*** Move to: ')) { section.moveTo = line.slice(13).trim(); i += 1; continue; }
    if (line.startsWith('@@')) {
      const chunk: V4AChunk = { anchor: line.slice(2).trim() || null, body: [], end: false, line: i + 1 };
      i += 1;
      while (i < lines.length && !lines[i]!.startsWith('@@') && (!lines[i]!.startsWith('*** ') || lines[i] === '*** End of File')) {
        const b = lines[i]!;
        if (b === '*** End of File') { chunk.end = true; i += 1; break; }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') chunk.body.push({ kind: b === '' || b[0] === ' ' ? 'context' : b[0] === '-' ? 'delete' : 'add', text: b === '' ? '' : b.slice(1) });
        else throw new Exit2(`error: parse ${i + 1}`);
        i += 1;
      }
      while (chunk.body.length > 0 && chunk.body.at(-1)!.kind === 'context' && chunk.body.at(-1)!.text === '') chunk.body.pop();
      section.chunks.push(chunk);
      continue;
    }
    if (line === '' || line.trim() === '') { i += 1; continue; }
    if (section.chunks.length === 0 && line[0] !== ' ' && line[0] !== '-' && line[0] !== '+') throw new Exit2(`error: parse ${i + 1}`);
    if (section.chunks.length === 0) {
      const chunk: V4AChunk = { anchor: null, body: [], end: false, line: i + 1 };
      while (i < lines.length && (!lines[i]!.startsWith('*** ') || lines[i] === '*** End of File') && !lines[i]!.startsWith('@@')) {
        const b = lines[i]!;
        if (b === '*** End of File') { chunk.end = true; i += 1; break; }
        if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') chunk.body.push({ kind: b === '' || b[0] === ' ' ? 'context' : b[0] === '-' ? 'delete' : 'add', text: b === '' ? '' : b.slice(1) });
        else break;
        i += 1;
      }
      while (chunk.body.length > 0 && chunk.body.at(-1)!.kind === 'context' && chunk.body.at(-1)!.text === '') chunk.body.pop();
      section.chunks.push(chunk);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }
  if (section.kind === 'update' && section.chunks.length === 0 && section.moveTo === null) throw new Exit2(`error: parse ${section.line}`);
  return { section, next: i };
}

function parseV4A(lines: string[]): V4ASection[] {
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0 || lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first < 0 ? 1 : first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && lines[last]!.trim() === '') last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const out: V4ASection[] = [];
  let i = first + 1;
  while (i < last) {
    if (lines[i]!.trim() === '') { i += 1; continue; }
    if (!/^\*\*\* (Add|Delete|Update) File: /.test(lines[i]!)) throw new Exit2(`error: parse ${i + 1}`);
    const p = parseV4ASection(lines, i); out.push(p.section); i = p.next;
  }
  return out;
}

function applyV4AChunk(file: string[], chunk: V4AChunk, cursor: number, strict: boolean, pathText: string): { lines: string[]; cursor: number } {
  let start = cursor;
  if (chunk.anchor !== null) {
    const anchor = findTier(file.slice(cursor), [chunk.anchor], strict);
    if (anchor.tier === null) throw new Fail('no-match', pathText);
    start = cursor + anchor.positions[0]! + 1;
  }
  const oldLines = chunk.body.filter((x) => x.kind !== 'add').map((x) => x.text);
  const newLines = chunk.body.filter((x) => x.kind !== 'delete').map((x) => x.text);
  const contexts = new Map<number, number>();
  let o = 0, n = 0; for (const x of chunk.body) { if (x.kind !== 'delete') { if (x.kind === 'context') contexts.set(n, o); n += 1; } if (x.kind !== 'add') o += 1; }
  if (oldLines.length === 0) {
    const at = chunk.end ? file.length : start;
    return { lines: [...file.slice(0, at), ...newLines, ...file.slice(at)], cursor: at + newLines.length };
  }
  const found = findTier(file.slice(start), oldLines, strict);
  if (found.tier === null) throw new Fail('no-match', pathText);
  const at = start + found.positions[0]!;
  if (chunk.end && at + oldLines.length !== file.length) throw new Fail('no-match', pathText);
  return { lines: replaceAtTier(file, oldLines, newLines, at, found.tier, contexts), cursor: at + newLines.length };
}

function applyV4ASection(tree: Tree, section: V4ASection, strict: boolean): void {
  pathChecked(section.pathText);
  if (section.moveTo !== null) pathChecked(section.moveTo);
  if (section.kind === 'add') {
    if (tree.get(section.pathText) !== null) throw new Fail('exists', section.pathText);
    tree.now.set(section.pathText, section.lines.join('\n') + '\n'); return;
  }
  if (section.kind === 'delete') {
    if (tree.get(section.pathText) === null) throw new Fail('missing', section.pathText);
    tree.now.set(section.pathText, null); return;
  }
  const source = treeText(tree, section.pathText, 'missing');
  if (section.moveTo !== null && tree.get(section.moveTo) !== null) throw new Fail('exists', section.moveTo);
  const lf = readLineFile(source); let lines = [...lf.lines]; let cursor = 0;
  for (const chunk of section.chunks) { const r = applyV4AChunk(lines, chunk, cursor, strict, section.pathText); lines = r.lines; cursor = r.cursor; }
  const result = writeLineFile({ lines, break: lf.break, finalBreak: lf.finalBreak });
  if (section.moveTo !== null) { tree.now.set(section.moveTo, result); tree.now.set(section.pathText, null); tree.moves.set(section.pathText, section.moveTo); } else tree.now.set(section.pathText, result);
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  return parseV4A(lines).map((s) => (tree) => applyV4ASection(tree, s, strict));
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = new Map(tree.moves);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.clear();
      for (const [k, v] of beforeMoves) tree.moves.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const moveRows: Array<{ oldPath: string; newPath: string }> = [];
  for (const [oldPath, newPath] of tree.moves) {
    if (tree.original(oldPath) !== null && tree.original(newPath) === null && tree.get(oldPath) === null && tree.get(newPath) !== null) moveRows.push({ oldPath, newPath });
  }
  const movedOld = new Set(moveRows.map((m) => m.oldPath));
  const movedNew = new Set(moveRows.map((m) => m.newPath));
  const rows: string[] = [];
  for (const m of moveRows.sort((a, b) => Buffer.compare(Buffer.from(a.newPath), Buffer.from(b.newPath)))) rows.push(`R ${m.oldPath} -> ${m.newPath}`);
  if (!check) for (const m of moveRows) {
    const movedValue = tree.get(m.newPath);
    if (movedValue !== null) { mkdirSync(dirname(m.newPath), { recursive: true }); writeFileSync(m.newPath, movedValue); }
    rmSync(m.oldPath, { force: true });
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    if (movedOld.has(p) || movedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push(`${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}`);
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
