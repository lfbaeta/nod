import type { WaitingReason } from './contracts.ts';

const labels: Record<WaitingReason, string> = {
  question: 'Waiting for your answer',
  approval: 'Waiting for your approval',
  credentials: 'Waiting for you to sign in',
};

export function knownWaitingReason(value: unknown): WaitingReason | undefined {
  if (value === 'question' || value === 'approval' || value === 'credentials') return value;
  return undefined;
}

export function waitingLabel(value: unknown) {
  const reason = knownWaitingReason(value);
  return reason ? labels[reason] : undefined;
}

export function waitingEventText(value: unknown) {
  return `${waitingLabel(value) ?? 'Waiting for your input'}.`;
}
