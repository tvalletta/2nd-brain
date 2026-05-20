export class KarpathyError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'KarpathyError';
  }
}

export class VaultError extends KarpathyError {
  constructor(message: string) {
    super(message, 'VAULT_ERROR');
    this.name = 'VaultError';
  }
}

export class ConfigError extends KarpathyError {
  constructor(message: string) {
    super(message, 'CONFIG_ERROR');
    this.name = 'ConfigError';
  }
}

export class LockError extends KarpathyError {
  constructor(message: string) {
    super(message, 'LOCK_ERROR');
    this.name = 'LockError';
  }
}

export class JobError extends KarpathyError {
  constructor(message: string) {
    super(message, 'JOB_ERROR');
    this.name = 'JobError';
  }
}

export class ExtractionError extends KarpathyError {
  constructor(
    message: string,
    public readonly rawSnippet?: string,
  ) {
    super(message, 'EXTRACTION_ERROR');
    this.name = 'ExtractionError';
  }
}
