import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FeedbackDelivery, FeedbackEnvelope } from '../ports/feedback.ts';
import type { FeedbackContext, FeedbackReceipt } from '../shared/feedback.ts';
import { feedbackLimits } from '../shared/feedback.ts';
import { feedbackTechnicalContext } from './feedback-context.ts';
import { createFeedbackRedactor } from './feedback-redaction.ts';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const uuid = z.uuidv4();
const pendingSchema = z
  .object({
    submissionId: uuid,
    payloadHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const reviewSchema = z
  .object({
    feedback: z.string().trim().min(1).max(feedbackLimits.text),
    includeReport: z.boolean(),
  })
  .strict();

export function createStartupFeedback(options: {
  dataRoot: string;
  delivery: FeedbackDelivery;
  context: Omit<FeedbackContext, 'enabled' | 'recipient'>;
  secrets: string[];
  names: string[];
  status: unknown;
}) {
  const context = feedbackTechnicalContext(options.context);
  const pendingPath = join(options.dataRoot, 'startup-feedback.json');
  let reviewed:
    { envelope: FeedbackEnvelope; content: string | null; expiresAt: number } | undefined;
  let sending: Promise<FeedbackReceipt> | undefined;
  let receipt: FeedbackReceipt | undefined;
  let pending: z.infer<typeof pendingSchema> | undefined;
  const restored = open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW)
    .then(async (file) => {
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1 || info.size > 1024)
          throw new Error('The saved report status is invalid.');
        pending = pendingSchema.parse(JSON.parse(await file.readFile('utf8')));
      } finally {
        await file.close();
      }
    })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT')
        throw new Error('The saved report status could not be read.', { cause: error });
    });
  restored.catch(() => {});

  async function syncStatusDirectory() {
    if (process.platform === 'win32') return;
    const directory = await open(options.dataRoot, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  }

  async function savePending(
    value: z.infer<typeof pendingSchema> | undefined,
    published = () => {},
  ) {
    if (!value) {
      await rm(pendingPath, { force: true });
      await syncStatusDirectory();
      return;
    }
    const temporary = `${pendingPath}.${randomUUID()}.tmp`;
    try {
      await mkdir(options.dataRoot, { recursive: true, mode: 0o700 });
      const file = await open(temporary, 'wx', 0o600);
      try {
        await file.writeFile(JSON.stringify(value));
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, pendingPath);
      published();
      await syncStatusDirectory();
    } finally {
      await rm(temporary, { force: true }).catch(() => {});
    }
  }

  async function report() {
    const redact = createFeedbackRedactor({
      secrets: options.secrets,
      profile: { names: options.names },
    });
    if (!redact.isReady()) throw new Error('The startup report could not be redacted.');
    let startupLog: unknown[] = [];
    let collected = false;
    let truncated = false;
    try {
      const file = await open(
        join(options.dataRoot, 'logs', 'startup.log'),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const info = await file.stat();
        if (!info.isFile() || info.nlink !== 1) throw new Error();
        const bytes = Buffer.alloc(Math.min(info.size, 48_000));
        await file.read(bytes, 0, bytes.length, info.size - bytes.length);
        const lines = bytes
          .toString('utf8')
          .split('\n')
          .slice(info.size > bytes.length ? 1 : 0)
          .filter(Boolean);
        truncated = info.size > bytes.length || lines.length > 100;
        const now = Date.now();
        startupLog = lines.slice(-100).map((line) => {
          const stamp = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) /.exec(line);
          const age = stamp ? now - Date.parse(stamp[1]) : NaN;
          return {
            ageMs: Number.isFinite(age)
              ? Math.min(31_536_000_000, Math.max(0, Math.round(age)))
              : null,
            line: redact.text(line.slice(stamp?.[0].length ?? 0)).slice(0, 4000),
          };
        });
        collected = true;
      } finally {
        await file.close();
      }
    } catch (error) {
      collected = (error as NodeJS.ErrnoException).code === 'ENOENT';
    }
    return JSON.stringify(
      {
        schema: 'nod-desktop-startup-report-v1',
        context,
        startup: redact.value(options.status),
        startupLog: {
          status: collected ? 'collected' : 'unavailable',
          truncated,
          entries: startupLog,
        },
        coverage:
          'Desktop startup only. Chat, app content, settings, and database records are not collected.',
      },
      null,
      2,
    );
  }

  async function status() {
    await restored;
    if (sending) return sending;
    if (!pending) return null;
    if (!receipt || receipt.status === 'unknown')
      receipt = await options.delivery.status(pending.submissionId, pending.payloadHash);
    return receipt;
  }

  return {
    async context() {
      return {
        ...context,
        enabled: options.delivery.configured,
        recipient: options.delivery.recipient,
        pending: await status(),
      };
    },
    async review(input: unknown) {
      await restored;
      const value = reviewSchema.parse(input);
      if (!options.delivery.configured) throw new Error('Bug reports are turned off.');
      if (sending || (pending && (!receipt || receipt.status === 'unknown')))
        throw new Error('Check the previous report status before starting another report.');
      const content = value.includeReport ? await report() : null;
      if (content && Buffer.byteLength(content) > feedbackLimits.reportBytes)
        throw new Error('The startup report is too large. Continue without the report.');
      const attachment = content
        ? {
            name: 'nod-diagnostic-report.json',
            mimeType: 'application/json',
            data: Buffer.from(content).toString('base64'),
            sha256: hash(content),
          }
        : undefined;
      const canonical = {
        schemaVersion: 1 as const,
        submissionId: randomUUID(),
        category: 'bug' as const,
        feedback: value.feedback,
        computerName: null,
        ...context,
        report: attachment ?? null,
        attachments: [],
      };
      reviewed = {
        envelope: {
          ...canonical,
          report: attachment,
          payloadHash: hash(JSON.stringify(canonical)),
        },
        content,
        expiresAt: Date.now() + 3_600_000,
      };
      return {
        reviewId: canonical.submissionId,
        feedback: value.feedback,
        content,
        recipient: options.delivery.recipient,
      };
    },
    async send(input: unknown) {
      await restored;
      const id = uuid.parse(input);
      if (pending?.submissionId === id) return (await status())!;
      if (!reviewed || reviewed.envelope.submissionId !== id || reviewed.expiresAt <= Date.now())
        throw new Error('Review the report again before sending it.');
      if (sending || (pending && (!receipt || receipt.status === 'unknown')))
        throw new Error('Check the previous report status before sending another report.');
      const envelope = reviewed.envelope;
      const previousPending = pending;
      const previousReceipt = receipt;
      pending = { submissionId: id, payloadHash: envelope.payloadHash };
      receipt = undefined;
      sending = (async () => {
        let published = false;
        try {
          await savePending(pending, () => {
            published = true;
          });
        } catch (error) {
          try {
            if (published) await savePending(previousPending);
          } catch (rollback) {
            throw new AggregateError(
              [error, rollback],
              'The report was not sent. The previous saved report status could not be restored.',
            );
          } finally {
            pending = previousPending;
            receipt = previousReceipt;
          }
          throw error;
        }
        receipt = await options.delivery.submit(envelope);
        return receipt;
      })().finally(() => {
        sending = undefined;
      });
      return sending;
    },
    status,
  };
}
