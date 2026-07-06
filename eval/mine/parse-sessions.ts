/**
 * Phase 0 — Session-transcript mining (spec §9.2).
 *
 * Extracts verbatim user prompts as candidate eval queries from two sources:
 *   PRIMARY (full, untruncated): AI Conversations/claude/<project>/<date>-<hex>.md
 *     → "### Turn N — User (time)" blocks.
 *   SECONDARY (truncated "..."): AI Conversations/_summaries/session-*.md
 *     → "## Prompts" → "### Prompt N (time)" blocks. Handles BOTH protected-region
 *       dialects: "%% begin:prompts %%" (new) and "<!-- PROTECTED:prompts -->" (old).
 *
 * Also derives the IMPLICIT-FAILURE signal (spec §9.2 / consideration #6):
 * sessions whose later prompts show reformulation/correction are flagged as
 * high-value hard items.
 *
 * Filters: <task-notification> blocks, trivial acks, and non-retrieval coding
 * prompts (kept but tagged retrieval_intent=false for later triage).
 *
 * Read-only. Run: npx tsx eval/mine/parse-sessions.ts
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/loader.js';

const REPO_ROOT = join(import.meta.dirname, '..', '..');

interface MinedQuery {
  query: string;
  source: 'transcript' | 'summary';
  session_hex: string;
  project: string | null;
  ts_hint: string | null;
  truncated: boolean;
  retrieval_intent: boolean;
  hard_reformulation: boolean; // part of a correction/re-ask chain
}

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, out);
    else if (e.toLowerCase().endsWith('.md')) out.push(full);
  }
  return out;
}

const hexOf = (file: string) => /-([0-9a-f]{8})\.md$/i.exec(file)?.[1] ?? 'unknown';

// ---- filters / classifiers ------------------------------------------------
const TRIVIAL = /^(y|yes|no|ok|okay|sure|thanks|ty|go|go ahead|do it|continue|proceed|#\d+|\d+)\.?$/i;
const isTaskNotification = (s: string) => /^\s*<task-notification/i.test(s) || /^\s*<system-reminder/i.test(s) || /^\s*<local-command/i.test(s);

// retrieval intent: asks the knowledge base about people/meetings/decisions/notes/history
const RETRIEVAL_RE = new RegExp(
  [
    '\\b(what|when|who|where|which|why|how)\\b.*\\b(did|do|does|was|were|is|are|have|has|decide|discuss|say|said|happen|work(ed)? on)\\b',
    '\\b(find|search|look ?up|recall|remember|dig up|surface|pull up)\\b',
    '\\b(my )?(notes?|transcripts?|recordings?|plaud|sessions?|meeting|1:1|standup|decision|summary|summaries)\\b',
    '\\bdo i have\\b',
    '\\bwhat (did|do) (we|i|you)\\b',
  ].join('|'),
  'i',
);
// correction / re-ask signal
const CORRECTION_RE = /\b(no,|actually|that'?s not|not (quite|right|what)|wrong|missing|still (not|missing)|again|premature|instead|you (missed|forgot|didn'?t)|re-?do|try again|isn'?t (right|correct)|doesn'?t (look|seem))\b/i;

function extractTranscriptPrompts(text: string): { text: string; ts: string | null }[] {
  const out: { text: string; ts: string | null }[] = [];
  // "### Turn N — User (HH:MM:SS)" ... until next "### Turn"
  const re = /^###\s+Turn\s+\d+\s+[—-]\s+User\s*(?:\(([^)]*)\))?\s*$/gim;
  const idxs: { start: number; ts: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) idxs.push({ start: m.index + m[0].length, ts: m[1] ?? null });
  const nextTurn = /^###\s+Turn\s+\d+\s+[—-]/gim;
  for (const { start, ts } of idxs) {
    nextTurn.lastIndex = start;
    const nm = nextTurn.exec(text);
    const end = nm ? nm.index : text.length;
    out.push({ text: text.slice(start, end).trim(), ts });
  }
  return out;
}

function extractSummaryPrompts(text: string): { text: string; ts: string | null; truncated: boolean }[] {
  // isolate the prompts protected region (both dialects)
  let region = '';
  const newer = /%%\s*begin:prompts\s*%%([\s\S]*?)%%\s*end:prompts\s*%%/i.exec(text);
  const older = /<!--\s*PROTECTED:prompts\s*-->([\s\S]*?)<!--\s*\/PROTECTED:prompts\s*-->/i.exec(text);
  region = newer?.[1] ?? older?.[1] ?? '';
  if (!region) return [];
  const out: { text: string; ts: string | null; truncated: boolean }[] = [];
  const re = /^###\s+Prompt\s+\d+\s*(?:\(([^)]*)\))?\s*$/gim;
  const idxs: { start: number; ts: string | null }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(region))) idxs.push({ start: m.index + m[0].length, ts: m[1] ?? null });
  const nextP = /^###\s+Prompt\s+\d+/gim;
  for (const { start, ts } of idxs) {
    nextP.lastIndex = start;
    const nm = nextP.exec(region);
    const end = nm ? nm.index : region.length;
    const body = region.slice(start, end).trim();
    out.push({ text: body, ts, truncated: /\.\.\.\s*$/.test(body) });
  }
  return out;
}

async function main() {
  const config = await loadConfig(REPO_ROOT);
  const vault = config.vaultPath;
  const claudeDir = join(vault, 'AI Conversations', 'claude');
  const summariesDir = join(vault, 'AI Conversations', '_summaries');

  const mined: MinedQuery[] = [];
  const seenHexFromTranscript = new Set<string>();

  // PRIMARY: claude transcripts (full prompts)
  const claudeFiles = existsSync(claudeDir) ? walk(claudeDir) : [];
  for (const file of claudeFiles) {
    const hex = hexOf(file);
    const project = file.slice(claudeDir.length + 1).split('/')[0] ?? null;
    const prompts = extractTranscriptPrompts(readFileSync(file, 'utf8'));
    const kept = prompts.filter((p) => p.text && !isTaskNotification(p.text) && !TRIVIAL.test(p.text.trim()));
    if (kept.length) seenHexFromTranscript.add(hex);
    kept.forEach((p, i) => {
      const laterCorrection = i > 0 && CORRECTION_RE.test(p.text);
      mined.push({
        query: p.text.length > 500 ? p.text.slice(0, 500) : p.text,
        source: 'transcript',
        session_hex: hex,
        project,
        ts_hint: p.ts,
        truncated: false,
        retrieval_intent: RETRIEVAL_RE.test(p.text),
        hard_reformulation: laterCorrection,
      });
    });
  }

  // SECONDARY: summaries, but only for sessions NOT already covered by a transcript
  const summaryFiles = existsSync(summariesDir) ? walk(summariesDir) : [];
  for (const file of summaryFiles) {
    const hex = hexOf(file);
    if (seenHexFromTranscript.has(hex)) continue; // prefer full transcript version
    const prompts = extractSummaryPrompts(readFileSync(file, 'utf8'));
    const kept = prompts.filter((p) => p.text && !isTaskNotification(p.text) && !TRIVIAL.test(p.text.trim()));
    kept.forEach((p, i) => {
      const laterCorrection = i > 0 && CORRECTION_RE.test(p.text);
      mined.push({
        query: p.text,
        source: 'summary',
        session_hex: hex,
        project: null,
        ts_hint: p.ts,
        truncated: p.truncated,
        retrieval_intent: RETRIEVAL_RE.test(p.text),
        hard_reformulation: laterCorrection,
      });
    });
  }

  const retrieval = mined.filter((q) => q.retrieval_intent);
  const hard = mined.filter((q) => q.hard_reformulation);

  console.log('\n=== SESSION-TRANSCRIPT MINING ===');
  console.log(`claude transcript files: ${claudeFiles.length}  |  summary files: ${summaryFiles.length}`);
  console.log(`total user prompts mined: ${mined.length}`);
  console.log(`  from transcripts (full): ${mined.filter((q) => q.source === 'transcript').length}`);
  console.log(`  from summaries (truncated-safe): ${mined.filter((q) => q.source === 'summary').length}`);
  console.log(`retrieval-intent prompts: ${retrieval.length}`);
  console.log(`hard reformulation / correction prompts: ${hard.length}`);
  console.log('\n--- sample retrieval-intent queries ---');
  for (const q of retrieval.slice(0, 12)) console.log(`  [${q.source}${q.truncated ? ',trunc' : ''}] ${q.query.replace(/\n/g, ' ').slice(0, 100)}`);

  const outDir = join(REPO_ROOT, 'eval', 'dataset');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'mined-session-queries.json'), JSON.stringify(mined, null, 2));
  console.log(`\nWrote eval/dataset/mined-session-queries.json (${mined.length} prompts)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
