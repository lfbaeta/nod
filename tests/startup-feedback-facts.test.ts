import assert from 'node:assert/strict';
import test from 'node:test';
import {
  startupErrorFacts,
  startupStatusFacts,
  startupEventFacts,
  startupLogFacts,
  startupFailureMessage,
  startupReceiptFacts,
  StartupFeedbackError,
} from '../src/shared/startup-feedback-facts.mjs';

test('startup facts omit every prose shape without pattern matching or code inference', () => {
  const values = [
    '/Applications/Synthetic Owner/profile/workspaces/synthetic-private-contract.docx',
    String.raw`C:\Synthetic Owner\profile\synthetic-private-contract.docx`,
    '<profile>[redacted]workspaces[redacted]synthetic-private-contract.docx',
    'https:[redacted][redacted]private.example.test[redacted]synthetic-private-url',
    'synthetic-private-local[redacted]example.test',
    'synthetic-private-local@example.test',
    '@synthetic-private-handle',
    '+34 600 123 456',
    '%2FUsers%2Fsynthetic-private-owner%2Fcontract',
    '{"name":"synthetic-private-owner","message":"HTTP 503 EIO"}',
    'prefixABCsynthetic-private-cross-tail',
    'prefixABCsynthetic-private-middleXYZtail',
  ];
  for (const value of values) {
    const status = startupStatusFacts({
      phase: 'error',
      stage: value,
      error: value,
      details: value,
      failure: { name: value, code: value, syscall: value, status: '503' },
    });
    const event = startupEventFacts(value, {
      error: value,
      durationMs: value,
      path: value,
      line: value,
    });
    const log = startupLogFacts({
      entries: [{ ageMs: 5, line: value, event: value }],
      truncated: false,
    });
    const encoded = JSON.stringify({ status, event, log });
    assert.ok(!encoded.includes(value));
    assert.equal(status.stage, 'unknown');
    assert.equal(status.failure?.httpStatus, undefined);
    assert.equal(status.failure?.errno, undefined);
    assert.equal(event.event, 'diagnostic_text_omitted');
    assert.equal(log.entries[0].textOmitted, true);
  }
});

test('startup facts keep only structured bounded codes and do not call getters or serializers', () => {
  let calls = 0;
  const error = Object.assign(new TypeError('synthetic-private-error'), {
    code: 'EACCES',
    syscall: 'open',
    status: 503,
    signal: 'SIGTERM',
    exitCode: 1,
    toJSON() {
      calls++;
      throw new Error('No serialization.');
    },
  });
  Object.defineProperty(error, 'stack', {
    get() {
      calls++;
      throw new Error('No stack read.');
    },
  });
  const facts = startupErrorFacts(error);
  assert.deepEqual(facts, {
    detailsOmitted: true,
    class: 'TypeError',
    errno: 'EACCES',
    syscall: 'open',
    httpStatus: 503,
    exitCode: 1,
    signal: 'SIGTERM',
  });
  const poisoned = Object.defineProperties(
    {},
    Object.fromEntries(
      [
        'name',
        'code',
        'syscall',
        'status',
        'phase',
        'stage',
        'runtime',
        'error',
        'failure',
        'message',
      ].map((key) => [
        key,
        {
          get() {
            calls++;
            throw new Error('No getter read.');
          },
        },
      ]),
    ),
  );
  JSON.stringify(startupStatusFacts(poisoned));
  JSON.stringify(startupErrorFacts(poisoned));
  JSON.stringify(startupEventFacts('runtime_failed', poisoned));
  const receipt = startupReceiptFacts(
    { status: 'rejected', message: 'synthetic-private-receipt', httpStatus: 400 },
    'synthetic-owned-id',
  );
  assert.deepEqual(receipt, {
    submissionId: 'synthetic-owned-id',
    status: 'rejected',
    httpStatus: 400,
    messageOmitted: true,
  });
  assert.ok(!startupFailureMessage(error).includes('synthetic-private'));
  assert.match(startupFailureMessage(error), /EACCES.*open.*HTTP 503/);
  assert.match(
    startupFailureMessage(new StartupFeedbackError('review_required')),
    /Review the report again/,
  );
  assert.equal(calls, 0);
  for (const value of [-1, 1.5, Infinity, NaN, 86400001])
    assert.equal(startupEventFacts('update', { durationMs: value }).durationMs, undefined);
  assert.equal(
    startupErrorFacts({ code: 'synthetic-private-code', status: 600 }).httpStatus,
    undefined,
  );
});
