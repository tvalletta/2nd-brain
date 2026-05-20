export interface VaultAdapter {
  ensureFolder(path: string): Promise<void>;
  listMarkdownFiles(folder: string): Promise<string[]>;
  listFiles(folder: string, pattern?: string): Promise<string[]>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  create(path: string, content: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  getModifiedTime(path: string): Promise<number>;
  atomicWrite(path: string, content: string): Promise<void>;
  delete(path: string): Promise<void>;
}
