import { register } from 'tsx/esm/api';
import { basename } from 'node:path';
import { homedir, hostname, userInfo } from 'node:os';
import { trustSystemCertificates } from './system-certificates.mjs';

trustSystemCertificates();
register();
const { createFeedbackDelivery } = await import('../../src/server/composition.ts');
const { createStartupFeedback } = await import('../../src/server/startup-feedback.ts');
const { createFeedbackRedactor } = await import('../../src/server/feedback-redaction.ts');
let feedback;
let configuration;
process.parentPort.on('message', async ({ data }) => {
  const { id, action, input } = data;
  try {
    if (action === 'initialize') {
      if (feedback) throw new Error('The report helper is already open.');
      configuration = {
        ...input,
        names: [userInfo().username, basename(homedir()), hostname()].filter(Boolean),
        delivery: createFeedbackDelivery(process.env),
      };
      feedback = createStartupFeedback(configuration);
    } else if (action === 'snapshot' && feedback) {
      configuration.status = input.status;
      configuration.secrets = input.secrets;
    } else if (!feedback || !['context', 'review', 'send', 'status'].includes(action)) {
      throw new Error('This report action is unavailable.');
    }
    const value = ['initialize', 'snapshot'].includes(action)
      ? null
      : await feedback[action](input);
    process.parentPort.postMessage({ id, value });
  } catch (error) {
    const redact = createFeedbackRedactor({
      secrets: configuration?.secrets ?? [],
      profile: { names: configuration?.names ?? [] },
    });
    process.parentPort.postMessage({
      id,
      error:
        error?.name === 'ZodError'
          ? 'The report input is invalid. Review the report again.'
          : redact.text(String(error?.message || 'The report action failed.')).slice(0, 2000),
    });
  }
});
process.parentPort.postMessage({ ready: true });
