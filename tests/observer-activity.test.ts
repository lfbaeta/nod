import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import pg from 'pg';

test(
  'observer activity identity deduplicates pending quiet-hour work without changing occurrence replay',
  { skip: !process.env.TEST_DATABASE_URL, timeout: 30_000 },
  async (t) => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const schema = `test_activity_identity_${suffix}`;
    const bossSchema = `test_activity_identity_boss_${suffix}`;
    const root = await mkdtemp(join(tmpdir(), 'activity-identity-test-'));
    const admin = new pg.Pool({ connectionString: process.env.TEST_DATABASE_URL });
    await admin.query(`CREATE SCHEMA ${schema}`);
    const previous = {
      DATABASE_URL: process.env.DATABASE_URL,
      PGBOSS_SCHEMA: process.env.PGBOSS_SCHEMA,
      NOD_DATA_ROOT: process.env.NOD_DATA_ROOT,
    };
    const url = new URL(process.env.TEST_DATABASE_URL!);
    url.searchParams.set('options', `-c search_path=${schema}`);
    process.env.DATABASE_URL = url.href;
    process.env.PGBOSS_SCHEMA = bossSchema;
    process.env.NOD_DATA_ROOT = root;
    const db = await import('../src/server/db.ts');
    const thread = await import('../src/server/thread.ts');
    const { createTasks } = await import('../src/server/tasks.ts');
    const ownerId = 'local-development';
    const otherOwner = 'activity-identity-other-owner';
    const activity = {
      objective: 'Read the synthetic source and report changes',
      sourceIds: ['synthetic-source'],
      connectionIds: [],
    };
    const threadId = randomUUID();
    const tasks = createTasks({ pool: db.pool, ownerId });
    const start = async (key: string, identity?: typeof activity) => {
      const turnId = randomUUID();
      await db.pool.query(
        `INSERT INTO threads(id,owner_id) VALUES($1,$2)
         ON CONFLICT (id) DO NOTHING`,
        [threadId, ownerId],
      );
      await db.pool.query(
        `INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,background,proactive)
         VALUES($1,$2,$3,$1,'event','Synthetic observer','running',true,true)`,
        [turnId, ownerId, threadId],
      );
      return (await tasks.execute(
        { threadId, turnId },
        {
          action: 'start',
          title: 'Synthetic monitoring task',
          key,
          ...(identity ? { activity: identity } : {}),
          message: 'Read the synthetic source.',
          doneWhen: 'The synthetic change is reported.',
          now: 'Waiting for quiet hours to end.',
        },
        null,
      )) as { id: string };
    };
    try {
      await db.initializeDatabase();
      await thread.initializeThreads();
      await tasks.initialize();
      await db.pool.query(
        'CREATE TABLE schedules (id uuid PRIMARY KEY, owner_id text NOT NULL, model jsonb)',
      );
      const utcMinute = new Date();
      const asTime = (offset: number) => {
        const time = new Date(utcMinute.getTime() + offset * 60_000);
        return `${String(time.getUTCHours()).padStart(2, '0')}:${String(time.getUTCMinutes()).padStart(2, '0')}`;
      };
      await db.pool.query(
        `INSERT INTO preferences(owner_id,quiet_hours_enabled,quiet_start,quiet_end,time_zone,proactive_paused)
         VALUES($1,true,$2,$3,'UTC',false)`,
        [ownerId, asTime(-10), asTime(10)],
      );

      await t.test('different occurrence keys share one open deferred task', async () => {
        const [first, second] = await Promise.all([
          start('change-a', activity),
          start('change-b', activity),
        ]);
        assert.equal(first.id, second.id);
        assert.equal(
          (await db.pool.query("SELECT count(*)::int AS count FROM tasks WHERE state='open'"))
            .rows[0].count,
          1,
        );
        assert.equal(
          (
            await db.pool.query(
              'SELECT count(*)::int AS count FROM turns WHERE session_id=$1 AND start_after IS NOT NULL',
              [first.id],
            )
          ).rows[0].count,
          1,
        );
        await db.pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
          first.id,
        ]);
      });

      await t.test(
        'reopening an older completed task cannot collide with a new open watch',
        async () => {
          const earlier = await start('reopen-original', activity);
          await db.pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
            earlier.id,
          ]);
          const replacement = await start('reopen-replacement', activity);
          assert.notEqual(replacement.id, earlier.id);
          const sourceTurnId = randomUUID();
          const replyTurnId = randomUUID();
          const replyMessageId = randomUUID();
          await db.pool.query(
            `INSERT INTO turns(id,owner_id,thread_id,session_id,source,prompt,status,task_id)
           VALUES($1,$3,$4,$1,'task','Synthetic task origin','done',$5),
                 ($2,$3,$4,$2,'task','Synthetic reply','running',NULL)`,
            [sourceTurnId, replyTurnId, ownerId, threadId, earlier.id],
          );
          await db.pool.query(
            `INSERT INTO messages(id,owner_id,thread_id,turn_id,role,text)
           VALUES($1,$2,$3,$4,'user','Reply to earlier task')`,
            [replyMessageId, ownerId, threadId, sourceTurnId],
          );
          const client = await db.pool.connect();
          try {
            const resolved = await tasks.resolveReply(client, threadId, replyMessageId);
            assert.ok(resolved);
            await assert.rejects(
              () => resolved.record(replyTurnId),
              (error: unknown) => (error as { statusCode?: number }).statusCode === 409,
            );
          } finally {
            client.release();
          }
          assert.equal(
            (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [earlier.id])).rows[0]
              .state,
            'done',
          );
          assert.equal(
            (await db.pool.query('SELECT state FROM tasks WHERE id=$1', [replacement.id])).rows[0]
              .state,
            'open',
          );
          await db.pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
            replacement.id,
          ]);
        },
      );

      await t.test('completed occurrence replay remains unchanged', async () => {
        const first = await start('completed-key', activity);
        await db.pool.query("UPDATE tasks SET state='done',closed_at=now() WHERE id=$1", [
          first.id,
        ]);
        assert.equal((await start('completed-key', activity)).id, first.id);
        const next = await start('new-key', activity);
        assert.notEqual(next.id, first.id);
      });

      await t.test(
        'missing or different identities remain independent and owner-scoped',
        async () => {
          const noIdentity = await start('legacy-key');
          const unrelated = await start('unrelated-key', {
            ...activity,
            objective: 'Handle a different synthetic need',
          });
          const ownerScopedKey = 'activity:owner-scope-test';
          assert.notEqual(noIdentity.id, unrelated.id);
          await db.pool.query(
            `INSERT INTO tasks(id,owner_id,title,done_when,now_text,activity_identity_key)
             VALUES($1,$2,'Foreign task','Foreign task is complete','Waiting',$3),
                   ($4,$5,'Local task','Local task is complete','Waiting',$3)`,
            [randomUUID(), otherOwner, ownerScopedKey, randomUUID(), ownerId],
          );
          assert.equal(
            (
              await db.pool.query(
                "SELECT count(*)::int AS count FROM tasks WHERE activity_identity_key=$1 AND state='open'",
                [ownerScopedKey],
              )
            ).rows[0].count,
            2,
          );
        },
      );
    } finally {
      await thread.stopThreadWorkers();
      await db.pool.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${bossSchema} CASCADE`);
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.end();
      for (const [key, value] of Object.entries(previous))
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      await rm(root, { recursive: true, force: true });
    }
  },
);
