import { classifyFile, type SourceType } from './classifier.js';
import { classifyCwd, type CwdClassification } from './cwd-classifier.js';

/**
 * Content categories that determine which processing pipeline to use.
 * More semantically meaningful than the extension-based SourceType.
 */
export type ContentCategory =
  | 'ai-conversation-claude'
  | 'ai-conversation-cursor'
  | 'meeting-notes'
  | 'article'
  | 'document'
  | 'code-artifact'
  | 'data'
  | 'unknown';

export interface RoutingDecision {
  /** Semantic content category */
  category: ContentCategory;
  /** Which tier determined the category */
  tier: 'deterministic' | 'agent-assisted';
  /** How confident we are in the classification (0-1) */
  confidence: number;
  /** The original extension-based source type (preserved for backward compat) */
  sourceType: SourceType;
  /** For AI conversations: the CWD classification */
  cwdClassification?: CwdClassification;
}

// Patterns for deterministic AI conversation detection
const CLAUDE_SESSION_PATTERN = /\*\*Session ID:\*\*.*\n.*\*\*(?:Date|Working directory):\*\*/;
const CONVERSATION_TURN_PATTERN = /### Turn \d+ \u2014 (?:User|Assistant|Tool)/;
const CURSOR_SOURCE_PATTERN = /\*\*Source:\*\* Cursor/;
const CWD_PATTERN = /\*\*Working directory:\*\*\s*`([^`]+)`/;

// Meeting note patterns
const MEETING_PATH_PATTERN = /(?:^|\/)(?:plaud|meetings?)\//i;
const MEETING_CONTENT_PATTERN = /(?:attendees?|participants?|agenda|action items?|minutes)/i;

/**
 * Two-tier content router.
 *
 * Tier 1 (deterministic): Pattern matching on file structure/content.
 * Tier 2 (agent-assisted): Falls through as 'unknown' for the ingest agent to classify.
 */
export function routeContent(
  filePath: string,
  content: string,
  metadata?: { cwd?: string; source?: string },
): RoutingDecision {
  const sourceType = classifyFile(filePath);

  // --- Tier 1: Deterministic classification ---

  // AI Conversation detection (highest priority — these have very distinct structure)
  if (sourceType === 'markdown' || sourceType === 'plaintext') {
    const aiResult = detectAIConversation(content, filePath, metadata);
    if (aiResult) return aiResult;
  }

  // Meeting notes detection
  if (detectMeetingNotes(filePath, content)) {
    return {
      category: 'meeting-notes',
      tier: 'deterministic',
      confidence: 0.8,
      sourceType,
    };
  }

  // Data files — deterministic by extension
  if (sourceType === 'csv' || sourceType === 'json') {
    return {
      category: 'data',
      tier: 'deterministic',
      confidence: 1.0,
      sourceType,
    };
  }

  // Code files — deterministic by extension
  if (sourceType === 'code') {
    return {
      category: 'code-artifact',
      tier: 'deterministic',
      confidence: 1.0,
      sourceType,
    };
  }

  // PDF — treat as document
  if (sourceType === 'pdf') {
    return {
      category: 'document',
      tier: 'deterministic',
      confidence: 0.7,
      sourceType,
    };
  }

  // Fallback: unknown — Tier 2 (agent) will classify later
  return {
    category: 'unknown',
    tier: 'deterministic',
    confidence: 0.0,
    sourceType,
  };
}

/**
 * Detect AI conversation transcripts from Claude Code or Cursor.
 * Returns a RoutingDecision if detected, null otherwise.
 */
function detectAIConversation(
  content: string,
  _filePath: string,
  metadata?: { cwd?: string; source?: string },
): RoutingDecision | null {
  // Check for the structural markers of an exported session
  const hasSessionId = CLAUDE_SESSION_PATTERN.test(content);
  const hasTurns = CONVERSATION_TURN_PATTERN.test(content);

  if (!hasSessionId || !hasTurns) return null;

  // It's an AI conversation — determine source
  const isCursor = CURSOR_SOURCE_PATTERN.test(content);
  const category: ContentCategory = isCursor
    ? 'ai-conversation-cursor'
    : 'ai-conversation-claude';

  // Extract cwd from content if not provided in metadata
  const cwd = metadata?.cwd ?? extractCwdFromContent(content);
  const cwdClassification = cwd ? classifyCwd(cwd) : undefined;

  return {
    category,
    tier: 'deterministic',
    confidence: 0.95,
    sourceType: 'markdown',
    cwdClassification,
  };
}

/**
 * Extract working directory from session content.
 */
function extractCwdFromContent(content: string): string | null {
  const match = CWD_PATTERN.exec(content);
  return match ? match[1] : null;
}

/**
 * Detect meeting notes by path or content.
 */
function detectMeetingNotes(path: string, content: string): boolean {
  if (MEETING_PATH_PATTERN.test(path)) return true;

  // Content-based: must have multiple meeting indicators
  const firstChunk = content.slice(0, 2000);
  return MEETING_CONTENT_PATTERN.test(firstChunk);
}

/**
 * Check if a content category represents an AI conversation.
 */
export function isAIConversation(category: ContentCategory): boolean {
  return category === 'ai-conversation-claude' || category === 'ai-conversation-cursor';
}

/**
 * Get the AI source name from a category.
 */
export function getAISource(category: ContentCategory): 'claude' | 'cursor' | null {
  if (category === 'ai-conversation-claude') return 'claude';
  if (category === 'ai-conversation-cursor') return 'cursor';
  return null;
}
