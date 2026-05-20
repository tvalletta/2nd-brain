export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[currentLevel];
}

function formatMessage(level: LogLevel, module: string, message: string, data?: Record<string, unknown>): string {
  const timestamp = new Date().toISOString();
  const base = `[${timestamp}] ${level.toUpperCase().padEnd(5)} [${module}] ${message}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}

export interface Logger {
  debug(message: string, data?: Record<string, unknown>): void;
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export function createLogger(module: string): Logger {
  return {
    debug(message, data) {
      if (shouldLog('debug')) {
        process.stderr.write(formatMessage('debug', module, message, data) + '\n');
      }
    },
    info(message, data) {
      if (shouldLog('info')) {
        process.stderr.write(formatMessage('info', module, message, data) + '\n');
      }
    },
    warn(message, data) {
      if (shouldLog('warn')) {
        process.stderr.write(formatMessage('warn', module, message, data) + '\n');
      }
    },
    error(message, data) {
      if (shouldLog('error')) {
        process.stderr.write(formatMessage('error', module, message, data) + '\n');
      }
    },
  };
}
