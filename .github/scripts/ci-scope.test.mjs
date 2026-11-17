import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parse } from 'yaml';
import { selectChecks, selectDesktopTests } from './ci-scope.mjs';
import { readTimings, shardTests } from './ci-tests.mjs';

const ciWorkflow = parse(await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
const requireChecks = (needs) =>
  new Function('process', ciWorkflow.jobs.checks.steps[0].run)({
    env: { CI_NEEDS: JSON.stringify(needs) },
  });

const enabled = (paths) =>
  Object.entries(selectChecks(paths))
    .filter(([, value]) => value === true)
    .map(([name]) => name)
    .sort();

test('text and media changes do not select application tests or native checks', () => {
  assert.deepEqual(enabled(['README.md', 'AGENTS.md', 'docs/src/content/docs/use/chat.md']), []);
  assert.deepEqual(enabled(['public/logos/nod.svg', 'src/web/styles.css']), ['build', 'types']);
  assert.deepEqual(enabled(['src/web/components/message.tsx']), ['build', 'integration', 'types']);
  assert.equal(selectChecks(['src/web/components/message.tsx']).testMode, 'all');
});

test('test-only changes select those files without image or platform checks', () => {
  const paths = ['tests/pi.test.ts', 'tests/thread.test.ts'];
  assert.deepEqual(enabled(paths), ['integration', 'types']);
  assert.deepEqual(selectChecks(paths).testFiles, paths);
  assert.equal(selectChecks(paths).testMode, 'changed');
  assert.equal(selectChecks(['tests/fixtures/composio-defaults.mts']).testMode, 'all');
});

test('server changes select affected Linux tests without native checks', () => {
  assert.deepEqual(enabled(['src/server/thread.ts']), ['evals', 'integration', 'types']);
  assert.equal(selectChecks(['src/server/thread.ts', 'tests/pi.test.ts']).testMode, 'affected');
  assert.equal(selectChecks(['src/web/app.tsx', 'src/server/thread.ts']).testMode, 'all');
  assert.equal(selectChecks(['src/server/thread.ts', 'src/web/app.tsx']).testMode, 'all');
});

test('container and native checks follow their inputs', () => {
  assert.equal(selectChecks(['src/providers/docker/index.ts']).images, true);
  assert.equal(selectChecks(['src/providers/agent-browser/index.ts']).images, true);
  assert.equal(selectChecks(['src/providers/composio/identity.ts']).macos, true);
  assert.equal(selectChecks(['src/server/vault-crypto.ts']).windows, true);
  assert.equal(selectChecks(['desktop/main/settings.mjs']).macos, true);
  assert.equal(selectChecks(['desktop/main/settings.mjs']).windows, true);
  assert.equal(selectChecks(['desktop/ui/setup.tsx']).macos, false);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).network, true);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).desktop, true);
  assert.equal(selectChecks(['desktop/runtime/index.mjs']).integration, false);
  for (const name of ['worker.ts', 'audio-codec-worker.ts', 'phonemizer-worker.ts'])
    assert.equal(selectChecks([`src/providers/synthetic/${name}`]).testMode, 'all');
  for (const name of ['workerpool.ts', 'workerless.ts', 'networkworker.ts'])
    assert.equal(selectChecks([`src/providers/synthetic/${name}`]).testMode, 'affected');
  assert.equal(selectChecks(['deployment/n8n/install.ps1']).windows, true);
  assert.deepEqual(enabled(['evals/src/cli.ts']), ['evals']);
});

test('application changes do not select desktop release and runtime fixtures', () => {
  const files = [
    'desktop/test/settings.test.mjs',
    'desktop/test/notifications.test.mjs',
    'desktop/test/runtime-assets.test.mjs',
    'desktop/test/linux-release.test.mjs',
  ];
  assert.deepEqual(
    selectDesktopTests(['src/shared/model.ts', 'tests/pi.test.ts'], files),
    files.slice(0, 2),
  );
  assert.deepEqual(
    selectDesktopTests(['src/web/app.tsx', 'src/shared/model.ts'], files),
    files.slice(0, 2),
  );
  for (const path of [
    'desktop/main/app.mjs',
    'desktop/preload/index.mjs',
    'deployment/self-host/docker-proxy.mjs',
  ]) {
    assert.equal(selectChecks([path]).integration, true);
    assert.equal(selectChecks([path]).testMode, 'all');
  }
  for (const paths of [
    null,
    ['desktop/runtime/index.mjs'],
    ['src/providers/docker/index.ts'],
    ['.github/workflows/ci.yml'],
    ['package.json'],
  ])
    assert.deepEqual(selectDesktopTests(paths, files), files);
});

test('unknown inputs, dependency changes and CI selection changes run all checks', () => {
  const full = enabled(null);
  for (const path of [
    'unknown/file',
    'package.json',
    'pnpm-lock.yaml',
    'patches/new.patch',
    '.github/workflows/ci.yml',
    '.github/scripts/ci-scope.mjs',
  ])
    assert.deepEqual(enabled([path]), full);
});

function results(paths) {
  const scope = selectChecks(paths);
  const outputs = Object.fromEntries(
    Object.entries(scope)
      .filter(([, value]) => typeof value === 'boolean')
      .map(([name, value]) => [name, String(value)]),
  );
  return {
    scope: { result: 'success', outputs },
    quality: { result: 'success' },
    secrets: { result: 'success' },
    ...Object.fromEntries(
      ['integration', 'desktop', 'macos', 'windows', 'n8n', 'evals', 'images'].map((name) => [
        name,
        { result: scope[name] ? 'success' : 'skipped' },
      ]),
    ),
  };
}

test('the required result accepts only valid scopes and successful selected jobs', () => {
  for (const paths of [[], ['src/web/app.tsx'], ['src/server/thread.ts'], null])
    assert.doesNotThrow(() => requireChecks(results(paths)));
  for (const name of [
    'scope',
    'quality',
    'secrets',
    'integration',
    'desktop',
    'macos',
    'windows',
    'n8n',
    'evals',
    'images',
  ]) {
    for (const result of ['failure', 'cancelled', 'skipped']) {
      const needs = results(null);
      needs[name].result = result;
      assert.throws(() => requireChecks(needs), /did not pass|could not select/);
    }
    const needs = results(null);
    delete needs[name];
    assert.throws(() => requireChecks(needs), /missing|could not select/);
  }
  const missing = results([]);
  delete missing.scope.outputs.windows;
  assert.throws(() => requireChecks(missing), /windows scope is missing/);
});

test('every selected job is part of the required result and can run in parallel', async () => {
  const workflow = parse(await readFile(new URL('../workflows/ci.yml', import.meta.url), 'utf8'));
  const jobs = workflow.jobs;
  for (const name of [
    'quality',
    'secrets',
    'integration',
    'desktop',
    'macos',
    'windows',
    'n8n',
    'evals',
    'images',
  ]) {
    assert.ok(jobs.checks.needs.includes(name), `${name} must be required.`);
    if (!['quality', 'secrets'].includes(name)) {
      assert.equal(jobs[name].needs, 'scope');
      assert.equal(jobs[name].if, `needs.scope.outputs.${name} == 'true'`);
    }
  }
  for (const name of enabled(null))
    assert.equal(jobs.scope.outputs[name], '${{ steps.scope.outputs.' + name + ' }}');
  assert.equal(jobs.checks.name, 'Checks, tests and build');
  assert.ok(jobs.checks.if.includes('!cancelled()'));
  assert.ok(workflow.on.schedule.length);
  assert.ok(workflow.on.merge_group);
  assert.equal(jobs.integration.strategy['fail-fast'], false);
  assert.equal(
    jobs.integration.strategy.matrix,
    '${{ fromJSON(needs.scope.outputs.test_matrix) }}',
  );
  assert.equal(jobs.quality.strategy['fail-fast'], false);
  assert.ok(jobs.quality.strategy.matrix.check.includes('quality_checks'));
  const bundle = parse(
    await readFile(new URL('../workflows/self-host-bundle.yml', import.meta.url), 'utf8'),
  );
  assert.equal(bundle.on.pull_request, undefined);
  const titles = parse(
    await readFile(new URL('../workflows/pr-title.yml', import.meta.url), 'utf8'),
  );
  assert.ok(titles.on.merge_group);
});

test('workflow queues use supported values and do not cancel queued releases', async () => {
  const directory = new URL('../workflows/', import.meta.url);
  for (const name of await readdir(directory)) {
    if (!name.endsWith('.yml')) continue;
    const workflow = parse(await readFile(new URL(name, directory), 'utf8'));
    for (const concurrency of [
      workflow.concurrency,
      ...Object.values(workflow.jobs).map((job) => job.concurrency),
    ]) {
      if (!concurrency || typeof concurrency !== 'object' || !Object.hasOwn(concurrency, 'queue'))
        continue;
      assert.ok(['single', 'max'].includes(concurrency.queue), `${name} has an invalid queue.`);
      assert.ok(
        concurrency.queue !== 'max' || concurrency['cancel-in-progress'] !== true,
        `${name} cancels a release queue.`,
      );
    }
  }
});

test('Git diffs handle renamed files, removed tests, release metadata and missing bases', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-scope-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const commit = () => {
    git('add', '.');
    git(
      '-c',
      'user.name=Synthetic CI',
      '-c',
      'user.email=ci@example.test',
      '-c',
      'core.hooksPath=/dev/null',
      'commit',
      '--quiet',
      '-m',
      'Synthetic change',
    );
    return git('rev-parse', 'HEAD');
  };
  const script = new URL('./ci-scope.mjs', import.meta.url);
  const run = (base, event = 'pull_request') =>
    JSON.parse(
      execFileSync(process.execPath, [fileURLToPath(script)], {
        cwd: root,
        encoding: 'utf8',
        stdio: 'pipe',
        env: {
          PATH: process.env.PATH,
          CI_DIFF_BASE: base,
          GITHUB_EVENT_NAME: event,
          GITHUB_OUTPUT: join(root, '.git', 'scope-output'),
          GITHUB_STEP_SUMMARY: join(root, '.git', 'scope-summary'),
        },
      }),
    );
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  await mkdir(join(root, 'tests'));
  await mkdir(join(root, 'desktop'));
  await writeFile(join(root, 'README.md'), 'Synthetic text.\n');
  await writeFile(join(root, 'tests/a.test.ts'), "import '../src/web/app.tsx';\n");
  await writeFile(join(root, 'tests/b.test.ts'), 'Synthetic test.\n');
  await writeFile(
    join(root, 'desktop/package.json'),
    JSON.stringify({ version: '1.0.0', name: 'synthetic' }),
  );
  const base = commit();
  await writeFile(join(root, 'README.md'), 'Changed text.\n');
  commit();
  assert.equal(run(base).integration, false);
  assert.equal(run(base, 'push').integration, true);
  assert.equal(run(base, 'merge_group').integration, true);
  await writeFile(join(root, 'tests/b.test.ts'), 'Changed test.\n');
  const testChange = commit();
  assert.deepEqual(JSON.parse(run(base).test_files), ['tests/b.test.ts']);
  git('mv', 'tests/b.test.ts', 'tests/copy with space.test.ts');
  const renamed = commit();
  assert.deepEqual(JSON.parse(run(testChange).test_files), ['tests/copy with space.test.ts']);
  git('rm', 'tests/copy with space.test.ts');
  const removed = commit();
  assert.equal(run(renamed).integration, false);
  await writeFile(
    join(root, 'desktop/package.json'),
    JSON.stringify({ version: '1.1.0', name: 'synthetic' }),
  );
  const release = commit();
  assert.equal(run(removed).macos, false);
  await mkdir(join(root, 'src/web'), { recursive: true });
  await writeFile(join(root, 'src/web/app.tsx'), 'Synthetic web fixture.\n');
  commit();
  assert.deepEqual(JSON.parse(run(release).test_files), ['tests/a.test.ts']);
  await writeFile(join(root, 'tests/new.test.ts'), 'Synthetic new test.\n');
  commit();
  assert.deepEqual(JSON.parse(run(release).test_files), ['tests/a.test.ts', 'tests/new.test.ts']);
  assert.equal(run('').macos, true);
  assert.equal(run('0'.repeat(40)).macos, true);
  assert.equal(run('f'.repeat(40)).macos, true);
  assert.throws(() => run('not-a-commit'), /base revision is invalid/);
  assert.match(await readFile(join(root, '.git', 'scope-summary'), 'utf8'), /Selected checks/);
  const beforeLock = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic: true\n');
  commit();
  assert.ok(JSON.parse(run(beforeLock).quality_checks).includes('lint'));
});

test('test shards use recorded times and include each file once', async () => {
  const files = [
    'tests/slow.test.ts',
    'tests/medium.test.ts',
    'tests/short.test.ts',
    'tests/tiny.test.ts',
  ];
  const times = Object.fromEntries(files.map((file, index) => [file, [90, 50, 30, 10][index]]));
  const shards = await shardTests(files, times, 2);
  assert.deepEqual(
    shards.map(({ files }) => files),
    [[files[0]], files.slice(1)],
  );
  assert.deepEqual(shards.flatMap(({ files }) => files).sort(), [...files].sort());
  assert.equal((await shardTests(files, times, 8)).length, files.length);
  assert.deepEqual(await shardTests([], {}), []);
  const cold = await shardTests(['tests/accounts.test.ts', 'tests/pi.test.ts']);
  assert.equal(cold.length, 2);
});

test('new test times replace old values and keep files outside a partial run', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-times-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const old = join(root, 'old');
  const latest = join(root, 'latest');
  await mkdir(old);
  await mkdir(latest);
  await writeFile(
    join(old, 'timings.json'),
    JSON.stringify({ 'tests/a.test.ts': 10, 'tests/b.test.ts': 20 }),
  );
  await writeFile(
    join(latest, '1.json'),
    JSON.stringify({
      'tests/a.test.ts': 5,
      'tests/c.test.ts': 30,
      'tests/bad.test.ts': -1,
      'unrelated.txt': 100,
    }),
  );
  assert.deepEqual(await readTimings(old, latest), {
    'tests/a.test.ts': 5,
    'tests/b.test.ts': 20,
    'tests/c.test.ts': 30,
  });
  assert.deepEqual(await readTimings(join(root, 'absent')), {});
});

test('Vitest follows imports without running test files and reruns non-imported inputs', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'nod-ci-related-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', '/dev/null');
  for (const directory of ['src', 'tests']) await mkdir(join(root, directory));
  await writeFile(join(root, 'src/leaf.ts'), 'export const value = 1;\n');
  await writeFile(join(root, 'src/route.ts'), "export { value } from './leaf';\n");
  await writeFile(join(root, 'src/other.ts'), 'export const value = 2;\n');
  await writeFile(
    join(root, 'tests/route.test.ts'),
    "import '../src/route';\nthrow new Error('Test selection must not execute this file.');\n",
  );
  await writeFile(
    join(root, 'tests/other.test.ts'),
    "import '../src/other';\nthrow new Error('Test selection must not execute this file.');\n",
  );
  git('add', '.');
  git(
    '-c',
    'user.name=Synthetic CI',
    '-c',
    'user.email=ci@example.test',
    'commit',
    '--quiet',
    '-m',
    'Synthetic base',
  );
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'src/leaf.ts'), 'export const value = 3;\n');
  const helper = fileURLToPath(new URL('./ci-tests.mjs', import.meta.url));
  const files = ['tests/other.test.ts', 'tests/route.test.ts'];
  const select = () =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `import { affectedTests } from ${JSON.stringify('file://' + helper)}; console.log(JSON.stringify(affectedTests(${JSON.stringify(base)}, ${JSON.stringify(files)})));`,
        ],
        { cwd: root, encoding: 'utf8' },
      ),
    );
  assert.deepEqual(select(), ['tests/route.test.ts']);
  await writeFile(join(root, 'pnpm-lock.yaml'), 'synthetic: true\n');
  assert.deepEqual(select().sort(), files);
  await rm(join(root, 'pnpm-lock.yaml'));
  for (const path of [
    'desktop/main/engine.mjs',
    'deployment/self-host/docker-proxy.mjs',
    'src/providers/synthetic/worker.ts',
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(
      join(root, path),
      'throw new Error("This input must not execute during selection.");\n',
    );
    assert.deepEqual(select().sort(), files, path);
    await rm(join(root, path));
  }
  for (const path of [
    'desktop/runtime/index.mjs',
    'src/providers/synthetic/workerpool.ts',
    'src/providers/synthetic/workerless.ts',
  ]) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(
      join(root, path),
      'throw new Error("This input must not execute during selection.");\n',
    );
    assert.deepEqual(select(), ['tests/route.test.ts'], path);
    await rm(join(root, path));
  }
});
