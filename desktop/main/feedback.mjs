import { register } from 'tsx/esm/api';
import { basename } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { trustSystemCertificates } from './system-certificates.mjs';
import { environmentSecrets } from '../../src/shared/environment-secrets.mjs';

trustSystemCertificates();
register();
const { createFeedbackDelivery } = await import('../../src/server/feedback-delivery.ts');
const { createStartupFeedback } = await import('../../src/server/startup-feedback.ts');
const { createFeedbackRedactor } = await import('../../src/server/feedback-redaction.ts');
const helperSecrets = environmentSecrets(process.env);
let feedback;
let configuration;
process.parentPort.on('message', async ({ data }) => {
  const { id, action, input } = data;
  try {
    if (action === 'initialize') {
      if (feedback) throw new Error('The report helper is already open.');
      configuration = {
        ...input,
        secrets: [...input.secrets, ...helperSecrets],
        names: [userInfo().username, basename(homedir()), hostname()].filter(Boolean),
        delivery: createFeedbackDelivery(process.env),
      };
      feedback = createStartupFeedback(configuration);
    } else if (action === 'snapshot' && feedback) {
      configuration.status = input.status;
      configuration.secrets = [...input.secrets, ...helperSecrets];
      configuration.startupLog = input.startupLog;
    } else if (!feedback || !['context', 'review', 'send', 'status'].includes(action)) {
      throw new Error('This report action is unavailable.');
    }
    const value = ['initialize', 'snapshot'].includes(action)
      ? null
      : await feedback[action](input);
    process.parentPort.postMessage({ id, value });
  } catch (error) {
    const redact = createFeedbackRedactor({
      secrets: configuration?.secrets ?? helperSecrets,
      profile: { names: configuration?.names ?? [] },
    });
    process.parentPort.postMessage({
      id,
      error:
        error?.name === 'ZodError'
          ? redact
              .text(
                `${error.issues?.[0]?.path?.join('.') || 'report'}: ${error.issues?.[0]?.message || 'The report input is invalid.'}`,
              )
              .slice(0, 2000)
          : redact
              .text(
                [
                  error?.message || 'The report action failed.',
                  ...(Array.isArray(error?.errors)
                    ? error.errors.slice(0, 2).map((cause) => cause?.message)
                    : []),
                ]
                  .filter((value) => typeof value === 'string')
                  .join(' '),
              )
              .slice(0, 2000),
    });
  }
});
process.parentPort.postMessage({ ready: true });
