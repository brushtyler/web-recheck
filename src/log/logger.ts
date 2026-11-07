import { appendLine } from '../io/files.js';
import { redactor, type RedactorLike } from '../security/redactor.js';

export type Level = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export interface LogContext {
  component?: string;
  shard_id?: string;
  worker_id?: string;
  case_id?: string;
  attempt?: number;
}
export type Sink = (line: string) => void;

export const stderrSink: Sink = (line) => {
  process.stderr.write(line + '\n');
};
export const fileSink = (path: string): Sink => (line) => appendLine(path, line);

/** JSONL logger; every line is redacted. A redactor failure never emits raw content and flags the logger as faulted. */
export class Logger {
  faulted = false;
  constructor(
    private readonly runId: string,
    private readonly sinks: Sink[],
    private readonly level: Level = 'info',
    private readonly ctx: LogContext = {},
    private readonly red: RedactorLike = redactor,
    private readonly shared: { faulted: boolean } = { faulted: false },
  ) {}

  child(ctx: LogContext): Logger {
    return new Logger(this.runId, this.sinks, this.level, { ...this.ctx, ...ctx }, this.red, this.shared);
  }

  get hasFault(): boolean {
    return this.shared.faulted;
  }

  private emit(level: Level, event: string, fields: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.level]) return;
    let line: string;
    try {
      line = this.red.redact(JSON.stringify({ ts: new Date().toISOString(), level, run_id: this.runId, ...this.ctx, event, ...fields }));
    } catch {
      this.shared.faulted = true;
      line = JSON.stringify({ level: 'error', run_id: this.runId, event: 'log_redaction_failed' });
    }
    for (const s of this.sinks) {
      try {
        s(line);
      } catch {
        this.shared.faulted = true;
      }
    }
  }
  debug(event: string, fields: Record<string, unknown> = {}): void { this.emit('debug', event, fields); }
  info(event: string, fields: Record<string, unknown> = {}): void { this.emit('info', event, fields); }
  warn(event: string, fields: Record<string, unknown> = {}): void { this.emit('warn', event, fields); }
  error(event: string, fields: Record<string, unknown> = {}): void { this.emit('error', event, fields); }
}

export const nullLogger = (): Logger => new Logger('none', [], 'error');
