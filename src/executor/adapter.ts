import type { TargetT } from '../contracts/index.js';

export interface NetworkEvent { kind: 'network'; url: string; method: string; status: number | null; same_origin: boolean; is_document: boolean; body_preview?: string }
export interface ConsoleEvent { kind: 'console'; level: 'error' | 'warning' | 'info' | 'log'; text: string }
export interface BlockedEvent { kind: 'blocked'; url: string; method: string; reason: 'SCOPE_DENIED' | 'UNOWNED_MUTATION' }
export type PageEvent = NetworkEvent | ConsoleEvent | BlockedEvent;

export type ExecAction =
  | { type: 'navigate'; url: string }
  | { type: 'click'; target: TargetT }
  | { type: 'fill'; target: TargetT; value: string }
  | { type: 'select'; target: TargetT; option: string }
  | { type: 'press'; key: string }
  | { type: 'wait_for'; text?: string; target?: TargetT; timeout_ms: number };

export interface ActionOutcome { ok: boolean; error?: string }
export interface PageState { url: string; title: string; main_status: number | null }

export type PolicyDecision = { allow: true } | { allow: false; reason: 'SCOPE_DENIED' | 'UNOWNED_MUTATION'; detail: string };
export interface RequestPolicy {
  check(url: string, method: string): PolicyDecision;
}

export interface PageSession {
  perform(a: ExecAction, signal: AbortSignal): Promise<ActionOutcome>;
  /** Returns (and clears) buffered events. The buffer is bounded by the adapter. */
  drainEvents(): PageEvent[];
  state(): Promise<PageState>;
  hasText(text: string): Promise<boolean>;
  count(target: TargetT): Promise<number>;
  settle(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}
export interface BrowserSession {
  newContext(policy: RequestPolicy): Promise<PageSession>;
  close(): Promise<void>;
}
export interface LaunchOptions {
  viewport: { w: number; h: number };
  locale: string;
  timezone: string;
  allowedOrigins: string[];
  maxEvents: number;
}
export interface BrowserAdapter {
  launch(opts: LaunchOptions): Promise<BrowserSession>;
}

export const targetKey = (t: TargetT): string => `${t.role ?? t.test_id ?? t.text ?? ''}:${t.name ?? ''}`;
