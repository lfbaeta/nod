import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm, type FileHandle } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { FeedbackDelivery, FeedbackEnvelope } from '../ports/feedback.ts';
import type {
  FeedbackContext,
  FeedbackReceipt,
  StartupFeedbackContext,
} from '../shared/feedback.ts';
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
class SavedStatusError extends Error {
  readonly canPreserve: boolean;
  constructor(message: string, canPreserve = false) {
    super(message);
    this.canPreserve = canPreserve;
  }
}

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
  startupLog?: {
    entries: Array<{ ageMs: number; line: string }>;
    truncated: boolean;
  };
}) {
  const context = feedbackTechnicalContext(options.context);
  const pendingPath = join(options.dataRoot, 'startup-feedback.json');
  let reviewed: { envelope: FeedbackEnvelope; expiresAt: number } | undefined;
  let reviewTimer: ReturnType<typeof setTimeout> | undefined;
  let sending: Promise<FeedbackReceipt> | undefined;
  let receipt: FeedbackReceipt | undefined;
  let pending: z.infer<typeof pendingSchema> | undefined;
  let restored: Promise<void> | undefined;
  let restoredState = false;
  let restoreFailure: { message: string; canPreserve: boolean } | undefined;
  let recovering: Promise<void> | undefined;

  async function readBytes(file: FileHandle, limit: number) {
    const bytes = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    return bytes.subarray(0, length);
  }

  async function openStatus() {
    const before = await lstat(pendingPath);
    if (!before.isFile() || before.nlink !== 1)
      throw new SavedStatusError('The saved report status is not one regular file.');
    const file = await open(pendingPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1 || info.dev !== before.dev || info.ino !== before.ino)
        throw new SavedStatusError('The saved report status changed while it was opened.');
      return { file, info };
    } catch (error) {
      await file.close();
      throw error;
    }
  }

  function restore() {
    if (restoredState) return Promise.resolve();
    return (restored ??= (async () => {
      try {
        const { file, info } = await openStatus();
        let value;
        try {
          const bytes = await readBytes(file, 1024);
          if (bytes.length > 1024)
            throw new SavedStatusError(
              'The saved report status is larger than 1024 bytes.',
              info.size <= 65_536,
            );
          let parsed;
          try {
            parsed = JSON.parse(bytes.toString('utf8'));
          } catch {
            throw new SavedStatusError('The saved report status has invalid JSON.', true);
          }
          const checked = pendingSchema.safeParse(parsed);
          if (!checked.success)
            throw new SavedStatusError('The saved report status has invalid fields.', true);
          value = checked.data;
        } finally {
          await file.close();
        }
        pending = value;
        restoredState = true;
        restoreFailure = undefined;
      } catch (cause) {
        const error = cause as NodeJS.ErrnoException;
        if (error.code === 'ENOENT' && !restoreFailure) {
          restoredState = true;
          return;
        }
        const code =
          typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code)
            ? error.code
            : 'read failure';
        restoreFailure =
          cause instanceof SavedStatusError
            ? { message: cause.message, canPreserve: cause.canPreserve }
            : {
                message: `The saved report status could not be read (${code}).`,
                canPreserve: false,
              };
        throw new Error(restoreFailure.message, { cause });
      }
    })().finally(() => {
      restored = undefined;
    }));
  }

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
    const log = z
      .object({
        entries: z
          .array(
            z
              .object({
                ageMs: z.number().int().min(0).max(31_536_000_000),
                line: z.string().max(48_000),
              })
              .strict(),
          )
          .max(100),
        truncated: z.boolean(),
      })
      .strict()
      .safeParse(options.startupLog);
    return JSON.stringify(
      {
        schema: 'nod-desktop-startup-report-v1',
        context,
        startup: redact.value(options.status),
        startupLog: {
          status: log.success ? 'collected' : 'unavailable',
          scope: 'current-desktop-process',
          truncated: log.success && log.data.truncated,
          entries: log.success
            ? log.data.entries.map((row) => ({
                ageMs: row.ageMs,
                line: redact.text(row.line).slice(0, 4000),
              }))
            : [],
        },
        coverage:
          'Desktop startup only. Chat, app content, settings, and database records are not collected.',
      },
      null,
      2,
    );
  }

  function present(value: FeedbackReceipt) {
    if (reviewed && reviewed.expiresAt <= Date.now()) reviewed = undefined;
    const { message, ...fields } = value;
    const safeMessage = message
      ? createFeedbackRedactor({ secrets: options.secrets, profile: { names: options.names } })
          .text(message)
          .slice(0, 1000)
      : undefined;
    return {
      ...fields,
      ...(safeMessage && { message: safeMessage }),
      ...(value.status === 'partial' && {
        canRetryAttachments: Boolean(
          reviewed?.envelope.submissionId === value.submissionId &&
          reviewed.envelope.report &&
          reviewed.expiresAt > Date.now(),
        ),
      }),
    };
  }

  function recover(input: unknown) {
    z.object({ confirm: z.literal(true) })
      .strict()
      .parse(input);
    return (recovering ??= (async () => {
      await restore().catch(() => {});
      if (restoredState || !restoreFailure?.canPreserve)
        throw new Error('Check the saved report status again before starting a new report.');
      const { file, info } = await openStatus();
      let bytes;
      try {
        bytes = await readBytes(file, 65_536);
        const after = await file.stat();
        if (bytes.length > 65_536)
          throw new Error('The saved report status is too large to preserve automatically.');
        if (
          info.size !== bytes.length ||
          info.size !== after.size ||
          info.mtimeMs !== after.mtimeMs ||
          info.ctimeMs !== after.ctimeMs
        )
          throw new Error('The saved report status changed. Check it again.');
      } finally {
        await file.close();
      }
      const backupPath = join(options.dataRoot, `startup-feedback-recovered-${randomUUID()}.bin`);
      let created = false;
      let preserved = false;
      try {
        const backup = await open(backupPath, 'wx', 0o600);
        created = true;
        try {
          await backup.writeFile(bytes);
          await backup.sync();
        } finally {
          await backup.close();
        }
        await syncStatusDirectory();
        preserved = true;
        const current = await lstat(pendingPath);
        if (
          !current.isFile() ||
          current.nlink !== 1 ||
          current.dev !== info.dev ||
          current.ino !== info.ino ||
          current.size !== info.size ||
          current.mtimeMs !== info.mtimeMs ||
          current.ctimeMs !== info.ctimeMs
        )
          throw new Error('The saved report status changed. Check it again.');
        await rm(pendingPath);
        pending = undefined;
        receipt = undefined;
        reviewed = undefined;
        clearTimeout(reviewTimer);
        restoreFailure = undefined;
        restoredState = true;
        await syncStatusDirectory();
      } catch (error) {
        if (created && !preserved) await rm(backupPath, { force: true }).catch(() => {});
        throw error;
      }
    })().finally(() => {
      recovering = undefined;
    }));
  }

  async function status(refresh = false) {
    await restore();
    if (sending) return sending;
    if (!pending) return null;
    if (refresh || !receipt || receipt.status === 'unknown')
      receipt = await options.delivery.status(pending.submissionId, pending.payloadHash);
    return present(receipt);
  }

  return {
    async context(): Promise<StartupFeedbackContext> {
      const value = {
        ...context,
        enabled: options.delivery.configured,
        recipient: options.delivery.recipient,
      };
      try {
        await restore();
      } catch (error) {
        if (!restoreFailure) throw error;
        return { ...value, pending: null, recovery: { ...restoreFailure } };
      }
      return { ...value, pending: await status() };
    },
    async review(input: unknown) {
      await restore();
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
        expiresAt: Date.now() + 3_600_000,
      };
      clearTimeout(reviewTimer);
      const reviewId = canonical.submissionId;
      reviewTimer = setTimeout(() => {
        if (reviewed?.envelope.submissionId === reviewId) reviewed = undefined;
      }, 3_600_000);
      reviewTimer.unref();
      return {
        reviewId: canonical.submissionId,
        feedback: value.feedback,
        content,
        recipient: options.delivery.recipient,
      };
    },
    async send(input: unknown) {
      await restore();
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
        return present(receipt);
      })().finally(() => {
        sending = undefined;
      });
      return sending;
    },
    async repair(input: unknown) {
      await restore();
      const id = uuid.parse(input);
      if (!pending || pending.submissionId !== id)
        throw new Error('Check the original report before sending its attachment again.');
      if (sending) return sending;
      if (receipt?.status !== 'partial')
        throw new Error('Check the report status before sending its attachment again.');
      if (
        !reviewed ||
        reviewed.envelope.submissionId !== id ||
        !reviewed.envelope.report ||
        reviewed.expiresAt <= Date.now()
      )
        throw new Error(
          'The original report bytes are no longer available. Start a new report to review new bytes.',
        );
      const envelope = reviewed.envelope;
      receipt = undefined;
      sending = (async () => {
        receipt = await options.delivery.submit({ ...envelope, action: 'repair' });
        return present(receipt);
      })().finally(() => {
        sending = undefined;
      });
      return sending;
    },
    recover,
    status: () => status(true),
  };
}
