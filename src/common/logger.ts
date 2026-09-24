/** Minimal leveled logger writing one line per entry to stdout/stderr. */
type Level = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: Level = 'info';

export function setLogLevel(level: Level): void {
  threshold = level;
}

function write(level: Level, scope: string, message: string, err?: unknown): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${message}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  out(line);
  if (err instanceof Error && err.stack) out(err.stack);
  else if (err !== undefined) out(String(err));
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

export function logger(scope: string): Logger {
  return {
    debug: (m) => write('debug', scope, m),
    info: (m) => write('info', scope, m),
    warn: (m, e) => write('warn', scope, m, e),
    error: (m, e) => write('error', scope, m, e),
  };
}
