import { describe, it, expect } from 'vitest';
import { triagePrompt, judgePrompt } from '../../eval/pool/prompts.js';

describe('triagePrompt', () => {
  it('includes every item\'s id, query, and current labels', () => {
    const prompt = triagePrompt([
      { id: 'x-001', query: 'what did we decide about X', category: 'decisions', subtype: 'lookup', source: 'log', intent: 'find the decision' },
    ]);
    expect(prompt).toContain('x-001');
    expect(prompt).toContain('what did we decide about X');
    expect(prompt).toContain('decisions');
    expect(prompt).toContain('lookup');
    expect(prompt).toContain('json');
  });
});

describe('judgePrompt', () => {
  it('includes the query, intent, and every candidate\'s doc_id/title/excerpt', () => {
    const prompt = judgePrompt('what did we decide about X', 'find the decision', [
      { doc_id: 'wiki/decisions/x.md', title: 'Decision: X', excerpt: 'We decided X because...' },
      { doc_id: 'wiki/meetings/y.md', title: 'Meeting Y', excerpt: 'Unrelated meeting notes' },
    ]);
    expect(prompt).toContain('what did we decide about X');
    expect(prompt).toContain('find the decision');
    expect(prompt).toContain('wiki/decisions/x.md');
    expect(prompt).toContain('Decision: X');
    expect(prompt).toContain('We decided X because...');
    expect(prompt).toContain('wiki/meetings/y.md');
    expect(prompt).toContain('json');
  });

  it('handles an empty intent without leaving a literal "undefined" in the prompt', () => {
    const prompt = judgePrompt('q', '', [{ doc_id: 'a.md', title: 'A', excerpt: 'e' }]);
    expect(prompt).not.toContain('undefined');
  });

  describe('judgePrompt escaping instruction', () => {
    it('instructs the model to escape quote characters within string values', () => {
      const prompt = judgePrompt('q', 'i', [{ doc_id: 'a.md', title: 'A', excerpt: 'e' }]);
      expect(prompt.toLowerCase()).toContain('escape');
      expect(prompt).toContain('\\"');
    });
  });
});

describe('triagePrompt escaping instruction', () => {
  it('instructs the model to escape quote characters within string values', () => {
    const prompt = triagePrompt([{ id: 'x', query: 'q', category: 'decisions', subtype: 'lookup', source: 'log', intent: '' }]);
    expect(prompt.toLowerCase()).toContain('escape');
    expect(prompt).toContain('\\"');
  });
});
