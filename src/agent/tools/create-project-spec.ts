import type { AgentToolDef } from '../tool-registry.js';
import {
  getOrCreateProjectHub,
  createProjectSpec,
  updateProjectSpec,
  listProjectSpecs,
} from '../../compilation/project-hub.js';

export const createProjectSpecTool: AgentToolDef = {
  name: 'create_project_spec',
  description:
    'Create or update a project sub-spec (technical, product, decisions, design, business). If the spec already exists, updates its content. If the project hub does not exist, creates it.',
  input_schema: {
    type: 'object',
    properties: {
      project_slug: {
        type: 'string',
        description: 'The project slug, e.g. "auth-redesign"',
      },
      project_name: {
        type: 'string',
        description: 'Human-readable project name (used if hub needs to be created)',
      },
      spec_type: {
        type: 'string',
        description: 'Sub-spec type: technical, product, decisions, design, or business',
      },
      title: {
        type: 'string',
        description: 'Title for the sub-spec page',
      },
      content: {
        type: 'string',
        description: 'Markdown content for the sub-spec',
      },
    },
    required: ['project_slug', 'project_name', 'spec_type', 'title', 'content'],
  },
  async execute(input, context) {
    const slug = input.project_slug as string;
    const name = input.project_name as string;
    const specType = input.spec_type as string;
    const title = input.title as string;
    const content = input.content as string;

    // Ensure hub exists
    await getOrCreateProjectHub(context.vault, slug, name, context.sourceFilePath);

    // Check if spec already exists
    const specs = await listProjectSpecs(context.vault, slug);
    const existing = specs.find((s) => s.specType === specType);

    if (existing) {
      await updateProjectSpec(
        context.vault,
        existing.path,
        content,
        true,
        context.sourceFilePath,
      );
      return `Updated existing spec: ${existing.path}`;
    }

    const path = await createProjectSpec(
      context.vault,
      slug,
      specType,
      title,
      content,
      context.sourceFilePath,
    );
    return `Created new spec: ${path}`;
  },
};
