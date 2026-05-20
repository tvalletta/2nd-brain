import type { AgentToolDef } from '../tool-registry.js';
import { classifyCwd } from '../../ingest/cwd-classifier.js';

export const classifyCwdTool: AgentToolDef = {
  name: 'classify_cwd',
  description:
    'Classify a working directory path into project / general / discovery. Returns the category, slug, and human-readable name.',
  input_schema: {
    type: 'object',
    properties: {
      cwd: {
        type: 'string',
        description: 'The working directory path to classify',
      },
    },
    required: ['cwd'],
  },
  async execute(input) {
    const cwd = input.cwd as string;
    const result = classifyCwd(cwd);
    return JSON.stringify(result);
  },
};
