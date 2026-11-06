import type { Logger } from '../log/logger.js';

/** SIGINT/SIGTERM -> abort the run controller; teardown then runs in the normal finally paths (NFR-7). */
export function installSignalHandlers(ctrl: AbortController, logger: Logger): () => void {
  const handler = (sig: string) => () => {
    logger.warn('signal_received', { signal: sig });
    if (!ctrl.signal.aborted) ctrl.abort('SIGNAL');
  };
  const i = handler('SIGINT');
  const t = handler('SIGTERM');
  process.on('SIGINT', i);
  process.on('SIGTERM', t);
  return () => {
    process.off('SIGINT', i);
    process.off('SIGTERM', t);
  };
}

export function raceAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error('aborted'));
  return new Promise<T>((res, rej) => {
    const on = () => rej(new Error('aborted'));
    signal.addEventListener('abort', on, { once: true });
    p.then(
      (v) => { signal.removeEventListener('abort', on); res(v); },
      (e) => { signal.removeEventListener('abort', on); rej(e); },
    );
  });
}
