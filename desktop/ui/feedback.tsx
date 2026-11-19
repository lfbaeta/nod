import { useEffect, useRef, useState } from 'react';
import type { FeedbackContext, FeedbackReceipt } from '../../src/shared/feedback';
import { feedbackLimits } from '../../src/shared/feedback';
import { Button, Dialog, DialogContent, DialogTitle } from '../../src/web/components/ui';
import './feedback.css';

export type StartupFeedbackDesktop = {
  openStartupFeedback(): Promise<void>;
  closeStartupFeedback(): Promise<void>;
  startupFeedback(action: string, input?: unknown): Promise<unknown>;
  onStartupFeedback(listener: () => void): (() => void) | undefined;
};

type Review = {
  reviewId: string;
  feedback: string;
  content: string | null;
  recipient: string | null;
};
type Context = FeedbackContext & { pending: FeedbackReceipt | null };

export function StartupFeedback({
  desktop,
  onClose,
}: {
  desktop: StartupFeedbackDesktop;
  onClose(): void;
}) {
  const [context, setContext] = useState<Context>();
  const [feedback, setFeedback] = useState('');
  const [includeReport, setIncludeReport] = useState(true);
  const [review, setReview] = useState<Review>();
  const [receipt, setReceipt] = useState<FeedbackReceipt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pending = useRef(false);
  const active = useRef(true);

  useEffect(() => {
    void run(async () => {
      const value = (await desktop.startupFeedback('context')) as Context;
      if (active.current) {
        setContext(value);
        setReceipt(value.pending);
      }
    });
    return () => {
      active.current = false;
    };
  }, []);

  async function run(action: () => Promise<void>) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      if (active.current)
        setError(cause instanceof Error ? cause.message : 'The report action failed.');
    } finally {
      pending.current = false;
      if (active.current) setBusy(false);
    }
  }

  const close = () => {
    if (pending.current) return;
    void run(async () => {
      await desktop.closeStartupFeedback();
      onClose();
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent className="startup-feedback" aria-describedby={undefined} aria-busy={busy}>
        <DialogTitle>Report a startup bug</DialogTitle>
        <p>Nod can send this report while its background service is stopped.</p>
        {context && (
          <p>
            Recipient:{' '}
            <strong>
              {context.recipient === 'n8n'
                ? 'The Nod team at n8n'
                : context.recipient || 'Reports are turned off'}
            </strong>
            .
          </p>
        )}
        {!receipt && (
          <>
            <label htmlFor="startup-feedback-text">What happened?</label>
            <textarea
              id="startup-feedback-text"
              rows={4}
              maxLength={feedbackLimits.text}
              value={feedback}
              disabled={busy}
              onChange={(event) => {
                setFeedback(event.target.value);
                setReview(undefined);
              }}
            />
            <label className="startup-feedback-choice">
              <input
                type="checkbox"
                checked={includeReport}
                disabled={busy}
                onChange={(event) => {
                  setIncludeReport(event.target.checked);
                  setReview(undefined);
                }}
              />
              Include startup report
            </label>
            <p>
              The report masks known secrets and personal details. It can miss information. Review
              it before sending. Chat and app content are not collected.
            </p>
            {review?.content && (
              <>
                <label htmlFor="startup-feedback-report">Exact report attachment</label>
                <textarea id="startup-feedback-report" rows={12} readOnly value={review.content} />
              </>
            )}
            {review && (
              <p>
                Check your description and the report. Only <strong>Send report</strong> sends them.
              </p>
            )}
          </>
        )}
        {receipt && (
          <p role="status">
            {receipt.status === 'submitted'
              ? 'Your report was sent.'
              : receipt.status === 'partial'
                ? 'Your report was sent, but its attachment is incomplete.'
                : receipt.status === 'rejected'
                  ? receipt.message || 'The report was rejected. You can edit it and try again.'
                  : 'The send result is unknown. Check its status before sending another report.'}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="startup-feedback-actions">
          <Button type="button" variant="outline" disabled={busy} onClick={close}>
            Close
          </Button>
          {!context && !busy && (
            <Button
              type="button"
              onClick={() =>
                void run(async () => {
                  const value = (await desktop.startupFeedback('context')) as Context;
                  if (active.current) {
                    setContext(value);
                    setReceipt(value.pending);
                  }
                })
              }
            >
              Try again
            </Button>
          )}
          {receipt?.status === 'unknown' && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const value = (await desktop.startupFeedback('status')) as FeedbackReceipt;
                  if (active.current) setReceipt(value);
                })
              }
            >
              Check status
            </Button>
          )}
          {receipt?.status === 'rejected' && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setReceipt(null);
                setReview(undefined);
              }}
            >
              Edit report
            </Button>
          )}
          {(receipt?.status === 'submitted' || receipt?.status === 'partial') && (
            <Button
              type="button"
              disabled={busy}
              onClick={() => {
                setReceipt(null);
                setReview(undefined);
                setFeedback('');
              }}
            >
              New report
            </Button>
          )}
          {!receipt && !review && (
            <Button
              type="button"
              disabled={busy || !context?.enabled || !feedback.trim()}
              onClick={() =>
                void run(async () => {
                  const value = (await desktop.startupFeedback('review', {
                    feedback,
                    includeReport,
                  })) as Review;
                  if (active.current) setReview(value);
                })
              }
            >
              {busy ? 'Preparing…' : 'Review'}
            </Button>
          )}
          {!receipt && review && (
            <Button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const value = (await desktop.startupFeedback(
                    'send',
                    review.reviewId,
                  )) as FeedbackReceipt;
                  if (active.current) setReceipt(value);
                })
              }
            >
              {busy ? 'Sending…' : 'Send report'}
            </Button>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
