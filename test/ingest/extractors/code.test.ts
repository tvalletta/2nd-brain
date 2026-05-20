import { describe, it, expect } from 'vitest';
import { extractCode } from '../../../src/ingest/extractors/code.js';

describe('extractCode', () => {
  it('extracts function signatures from TypeScript', () => {
    const content = `
export async function fetchUser(id: string): Promise<User> {
  return db.get(id);
}

function helper() {
  return 42;
}
`;
    const result = extractCode(content);
    expect(result).toContain('**Code**');
    expect(result).toContain('exported symbols');
    expect(result).toContain('export async function fetchUser');
    expect(result).toContain('function helper');
  });

  it('extracts class declarations', () => {
    const content = `
export class UserService {
  constructor() {}
}

export abstract class BaseRepo {
  abstract find(): void;
}
`;
    const result = extractCode(content);
    expect(result).toContain('export class UserService');
    expect(result).toContain('export abstract class BaseRepo');
  });

  it('extracts interface and type declarations', () => {
    const content = `
export interface User {
  id: string;
  name: string;
}

export type Config = {
  debug: boolean;
};
`;
    const result = extractCode(content);
    expect(result).toContain('export interface User');
    expect(result).toContain('export type Config');
  });

  it('extracts export statements', () => {
    const content = `
export const MAX_RETRIES = 3;
export let counter = 0;
export enum Status { Active, Inactive }
`;
    const result = extractCode(content);
    expect(result).toContain('export const MAX_RETRIES');
    expect(result).toContain('export let counter');
    expect(result).toContain('export enum Status');
  });

  it('falls back to raw content when no signatures found', () => {
    const content = '// just a comment\nconst x = 1;\n';
    const result = extractCode(content);
    expect(result).toBe(content);
  });
});
