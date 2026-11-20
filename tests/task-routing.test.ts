import assert from 'node:assert/strict';
import test from 'node:test';

import { taskRouting, toolDefinitions } from '../src/runtime/tools.ts';

test('tracked work requires a persisted task identity', () => {
  assert.equal(toolDefinitions.task.eager, true);
  assert.ok(taskRouting.includes('call the task tool with action: "start"'));
  assert.ok(taskRouting.includes('Whenever work qualifies for a saved task'));
  assert.ok(taskRouting.includes('substantial work that must run alongside another job'));
  assert.ok(
    toolDefinitions.task.description.includes(
      'Before beginning any work that qualifies for a saved task',
    ),
  );
  assert.ok(toolDefinitions.task.description.includes('wait for its returned ID'));
  assert.ok(
    toolDefinitions.task.description.includes(
      'substantial work that must run alongside another job',
    ),
  );
  assert.ok(taskRouting.includes('nod_tool_search to find task'));
  assert.ok(taskRouting.includes('returned task ID'));
  assert.ok(taskRouting.includes('action: "finish" succeeds for that same ID'));
  assert.ok(taskRouting.includes('not a saved task'));
});
