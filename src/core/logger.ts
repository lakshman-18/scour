import type { Logger } from './types.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';
const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3, silent: 99 };

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};
export const color = process.stderr.isTTY && !process.env.NO_COLOR ? C : new Proxy(C, { get: () => (s: string) => s });

/**
 * Logs go to stderr, always. stdout is reserved for data so that
 * `scour get URL | jq` never breaks.
 */
export class ConsoleLogger implements Logger {
  constructor(private level: LogLevel = 'warn') {}
  setLevel(l: LogLevel): void {
    this.level = l;
  }
  private emit(l: LogLevel, tag: string, msg: string, meta?: unknown): void {
    if (ORDER[l] < ORDER[this.level]) return;
    const extra = meta === undefined ? '' : ` ${color.dim(typeof meta === 'string' ? meta : JSON.stringify(meta))}`;
    process.stderr.write(`${tag} ${msg}${extra}\n`);
  }
  debug(m: string, meta?: unknown): void { this.emit('debug', color.dim('·'), color.dim(m), meta); }
  info(m: string, meta?: unknown): void { this.emit('info', color.cyan('→'), m, meta); }
  warn(m: string, meta?: unknown): void { this.emit('warn', color.yellow('!'), m, meta); }
  error(m: string, meta?: unknown): void { this.emit('error', color.red('✗'), m, meta); }
}

export const nullLogger: Logger = {
  debug() {}, info() {}, warn() {}, error() {},
};
