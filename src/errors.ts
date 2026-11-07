export type ErrorCode =
  | 'SCHEMA_VIOLATION'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'UNSAFE_YAML'
  | 'DUPLICATE_CASE_ID'
  | 'ILLEGAL_TRANSITION'
  | 'REVISION_STALE'
  | 'APPROVAL_INVALID'
  | 'PATH_ESCAPE'
  | 'SCOPE_DENIED'
  | 'PLAINTEXT_SECRET'
  | 'SECRET_UNAVAILABLE'
  | 'MUTATION_ON_PRODUCTION'
  | 'UNOWNED_MUTATION'
  | 'FOREIGN_RESOURCE'
  | 'FIXTURE_FAILED'
  | 'NOT_COMPARABLE'
  | 'REDACTION_FAILURE'
  | 'CAP_EXCEEDED'
  | 'PLAN_MISMATCH'
  | 'USAGE_ERROR';

export interface Issue {
  path: string;
  code: string;
  message: string;
}

export class FrameworkError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly path?: string,
    public readonly issues: Issue[] = [],
  ) {
    super(message);
    this.name = 'FrameworkError';
  }
}

export function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
