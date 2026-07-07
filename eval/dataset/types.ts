export interface EvalItem {
  id: string;
  query: string;
  category: 'plaud-ai-session' | 'entities' | 'hot-topics' | 'decisions';
  subtype: 'lookup' | 'synthesis' | 'relationship' | 'absent';
  source: 'log' | 'session' | 'synthetic';
  source_ref: string;
  intent: string;
  is_regression: boolean;
  query_truncated: boolean;
  needs_review: boolean;
}
