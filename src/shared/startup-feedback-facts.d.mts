export type StartupErrorFacts = {
  detailsOmitted: true;
  class?: string;
  errno?: string;
  syscall?: string;
  httpStatus?: number;
  exitCode?: number;
  signal?: string;
};
export type StartupEventFacts = {
  event: string;
  textOmitted: true;
  error?: StartupErrorFacts;
  phase?: string;
  stage?: string;
  durationMs?: number;
  count?: number;
  exitCode?: number;
  signal?: string;
  httpStatus?: number;
};
export type StartupStatusFacts = {
  phase: string;
  stage: string;
  runtimePhase: string;
  errorPresent: boolean;
  detailsOmitted: true;
  failure?: StartupErrorFacts;
};
export function startupErrorFacts(value: unknown): StartupErrorFacts;
export function startupStatusFacts(value: unknown): StartupStatusFacts;
export function startupEventFacts(event?: unknown, details?: unknown): StartupEventFacts;
export function startupLogFacts(value: unknown): {
  status: string;
  truncated?: boolean;
  entries: Array<StartupEventFacts & { ageMs: number }>;
};
export class StartupFeedbackError extends Error {
  startupReason?: string;
  constructor(reason: string, cause?: unknown);
}
export function startupFailureMessage(error: unknown): string;
export function startupReceiptFacts(
  value: unknown,
  submissionId: string,
): import('./feedback.ts').FeedbackReceipt;
