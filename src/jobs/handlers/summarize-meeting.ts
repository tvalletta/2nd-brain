import { nanoid } from 'nanoid';
import type { JobHandler, Job, JobContext } from '../types.js';
import { parseNote, serializeNote } from '../../vault/frontmatter.js';
import { updateProtectedRegion, OPEN_TAG, CLOSE_TAG } from '../../vault/protected-regions.js';
import { chunkDocument } from '../../ingest/chunker.js';
import { summarizeMeetingSource, summarizeMeetingChunks } from '../../enrichment/summarizer.js';
import { slugify, resolveAvailablePath } from '../../vault/paths.js';
import { nowISO, todayStamp } from '../../shared/date-utils.js';
import { createLogger } from '../../shared/logger.js';
import type { SourceType } from '../../ingest/classifier.js';

const log = createLogger('handler:summarize-meeting');

interface MeetingBrief {
  meetingLine: string;
  attendees: string;
  keyDecisions: string;
  actionItems: string;
  openQuestions: string;
  keyThemes: string;
}

function parseMeetingBrief(text: string): MeetingBrief {
  const sections: Record<string, string> = {};
  const sectionKeys = ['MEETING', 'ATTENDEES', 'KEY DECISIONS', 'ACTION ITEMS', 'OPEN QUESTIONS', 'KEY THEMES'];

  for (let i = 0; i < sectionKeys.length; i++) {
    const key = sectionKeys[i];
    const nextKey = sectionKeys[i + 1];
    const pattern = new RegExp(`^${key}:(.*)`, 'ms');
    const match = pattern.exec(text);
    if (!match) {
      sections[key] = '';
      continue;
    }
    let content = match[1];
    if (nextKey) {
      const nextPattern = new RegExp(`\\n${nextKey}:`, 'm');
      const cutoff = nextPattern.exec(content);
      if (cutoff) content = content.slice(0, cutoff.index);
    }
    sections[key] = content.trim();
  }

  return {
    meetingLine: sections['MEETING'] ?? '',
    attendees: sections['ATTENDEES'] ?? '',
    keyDecisions: sections['KEY DECISIONS'] ?? '',
    actionItems: sections['ACTION ITEMS'] ?? '',
    openQuestions: sections['OPEN QUESTIONS'] ?? '',
    keyThemes: sections['KEY THEMES'] ?? '',
  };
}

function extractMeetingDate(brief: MeetingBrief, rawPath: string): string {
  // Try ISO date from MEETING line
  const isoMatch = /(\d{4}-\d{2}-\d{2})/.exec(brief.meetingLine);
  if (isoMatch) return isoMatch[1];

  // Try ISO date from path
  const pathIso = /(\d{4}-\d{2}-\d{2})/.exec(rawPath);
  if (pathIso) return pathIso[1];

  // Try compact date from filename like p-20240515
  const compact = /(\d{4})(\d{2})(\d{2})/.exec(rawPath.split('/').pop() ?? '');
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return todayStamp();
}

function extractAttendeesList(brief: MeetingBrief): string[] {
  if (!brief.attendees || brief.attendees === '(none)') return [];
  return brief.attendees
    .split('\n')
    .map((l) => l.replace(/^[-*]\s*/, '').trim())
    .filter(Boolean);
}

export const summarizeMeetingHandler: JobHandler = {
  async execute(job: Job, context: JobContext): Promise<void> {
    const summaryPath = job.targetPath;
    if (!summaryPath) throw new Error('summarize-meeting: no targetPath');

    const rawPath = job.payload.rawPath as string;
    if (!rawPath) throw new Error('summarize-meeting: no rawPath in payload');

    const rawContent = await context.vault.read(rawPath);

    const summaryContent = await context.vault.read(summaryPath);
    const { data, body } = parseNote(summaryContent);
    const sourceType = (data.source_type as SourceType) ?? 'plaintext';
    const sourceHash = (data.source_hash as string) ?? '';
    const title = (data.title as string) ?? 'Untitled Meeting';

    // Chunk the transcript
    const chunkResult = chunkDocument(rawContent, sourceType, sourceHash, {
      maxChunkSize: context.config.enrichment.maxChunkSize,
      overlap: context.config.enrichment.chunkOverlap,
    });

    // Run meeting-specific summarization
    const briefResult =
      chunkResult.chunks.length === 1
        ? await summarizeMeetingSource(context.llm, title, chunkResult.chunks[0].content)
        : await summarizeMeetingChunks(context.llm, title, chunkResult.chunks);

    if (briefResult.status === 'error') throw new Error(`Meeting summarization failed: ${briefResult.error}`);
    const brief = parseMeetingBrief(briefResult.data);
    const meetingDate = extractMeetingDate(brief, rawPath);

    // Update source summary
    let updatedBody = updateProtectedRegion(body, 'summary', briefResult.data);
    data.ingest_status = 'summarized';
    data.confidence = 'medium';
    data.chunk_count = chunkResult.chunks.length;
    data.chunk_strategy = chunkResult.strategy;
    data.updated_at = nowISO();

    await context.vault.atomicWrite(summaryPath, serializeNote(data, updatedBody));

    // Create meeting note at wiki/meetings/
    const meetingsDir = `${context.config.layout.wiki}/meetings`;
    await context.vault.ensureFolder(meetingsDir);

    const slug = slugify(title);
    const meetingFileName = `${meetingDate}-${slug}.md`;
    const existingPaths = new Set(await context.vault.listMarkdownFiles(meetingsDir));
    const meetingPath = resolveAvailablePath(meetingsDir, meetingFileName, existingPaths);

    // Check if a meeting note for this source already exists
    const existingMeetingPath = [...existingPaths].find((p) =>
      p.endsWith(`${meetingDate}-${slug}.md`),
    );

    if (existingMeetingPath) {
      // Update existing meeting note's protected regions
      const existing = await context.vault.read(existingMeetingPath);
      const { data: mData, body: mBody } = parseNote(existing);
      let mUpdated = updateProtectedRegion(mBody, 'meeting-info', brief.meetingLine || '(none)');
      mUpdated = updateProtectedRegion(mUpdated, 'attendees', brief.attendees || '(none)');
      mUpdated = updateProtectedRegion(mUpdated, 'action-items', brief.actionItems || '(none)');
      mUpdated = updateProtectedRegion(mUpdated, 'decisions', brief.keyDecisions || '(none)');
      mUpdated = updateProtectedRegion(mUpdated, 'key-themes', brief.keyThemes || '(none)');
      mData.updated_at = nowISO();
      mData.attendees = extractAttendeesList(brief);
      await context.vault.atomicWrite(existingMeetingPath, serializeNote(mData, mUpdated));
      log.info('Meeting note updated', { path: existingMeetingPath });
    } else {
      // Create new meeting note
      const attendees = extractAttendeesList(brief);
      const meetingFrontmatter: Record<string, unknown> = {
        id: nanoid(),
        type: 'meeting_summary',
        title,
        meeting_date: meetingDate,
        attendees,
        source_path: summaryPath,
        source_refs: [rawPath],
        content_category: 'meeting-notes',
        status: 'draft',
        confidence: 'medium',
        review_state: 'unreviewed',
        created_at: nowISO(),
        updated_at: nowISO(),
        change_origin: 'extraction',
        protected_regions: ['meeting-info', 'attendees', 'action-items', 'decisions', 'key-themes'],
        derived_from: [],
        aliases: [],
        links: [],
        superseded_by: [],
        contradicts: [],
        pending_evidence: [],
        pending_evidence_count: 0,
        also_relevant_to: [],
      };

      const meetingBody = `
# ${title}

**Date:** ${meetingDate}
**Source:** [[${summaryPath.replace(/\.md$/, '')}]]

## Meeting Info
${OPEN_TAG('meeting-info')}
${brief.meetingLine || '(none)'}
${CLOSE_TAG('meeting-info')}

## Attendees
${OPEN_TAG('attendees')}
${brief.attendees || '(none)'}
${CLOSE_TAG('attendees')}

## Key Decisions
${OPEN_TAG('decisions')}
${brief.keyDecisions || '(none)'}
${CLOSE_TAG('decisions')}

## Action Items
${OPEN_TAG('action-items')}
${brief.actionItems || '(none)'}
${CLOSE_TAG('action-items')}

## Open Questions
${OPEN_TAG('open-questions')}
${brief.openQuestions || '(none)'}
${CLOSE_TAG('open-questions')}

## Key Themes
${OPEN_TAG('key-themes')}
${brief.keyThemes || '(none)'}
${CLOSE_TAG('key-themes')}
`;

      await context.vault.create(meetingPath, serializeNote(meetingFrontmatter, meetingBody));
      log.info('Meeting note created', { path: meetingPath, date: meetingDate });
    }

    log.info('Meeting summarized', {
      path: summaryPath,
      chunks: chunkResult.chunks.length,
      meetingDate,
    });
  },
};
