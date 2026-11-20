import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { deserialize, serialize } from 'node:v8';
import type { Pool } from 'pg';
import { logRepeatedFailure } from '../../ports/failure-log.ts';
import type { CredentialKeyStore } from '../../ports/key-store.ts';
import { MessagingConnectionError } from '../../ports/messaging.ts';

export function createSlackIntake<T>(pool: Pool, owner: string, keyStore: CredentialKeyStore) {
  let ready: Promise<unknown> | undefined;
  const initialize = () =>
    (ready ??= pool
      .query(
        `
      CREATE TABLE IF NOT EXISTS channel_slack_intake (
        owner_id text NOT NULL, installation text NOT NULL, message_ts text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(), ciphertext bytea NOT NULL,
        PRIMARY KEY (owner_id, installation, message_ts)
      )
    `,
      )
      .catch((cause) => {
        ready = undefined;
        throw cause;
      }));
  const binding = (installation: string, ts: string) =>
    Buffer.from(JSON.stringify(['nod', 'slack-intake', owner, installation, ts]));
  return {
    async prune() {
      await initialize();
      await pool.query(
        "DELETE FROM channel_slack_intake WHERE owner_id=$1 AND created_at < now()-interval '24 hours'",
        [owner],
      );
    },
    async known(installation: string, ts: string, sourceId: string) {
      await initialize();
      return Boolean(
        (
          await pool.query(
            `SELECT 1 FROM channel_slack_intake WHERE owner_id=$1 AND installation=$2 AND message_ts=$3
           UNION ALL SELECT 1 FROM channel_inbox WHERE owner_id=$1 AND source_id=$4 LIMIT 1`,
            [owner, installation, ts, sourceId],
          )
        ).rowCount,
      );
    },
    async save(installation: string, ts: string, value: T, signal: AbortSignal) {
      await initialize();
      const key = await keyStore.getKey();
      signal.throwIfAborted();
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(binding(installation, ts));
      const bytes = Buffer.concat([cipher.update(serialize(value)), cipher.final()]);
      const ciphertext = Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
      const client = await pool.connect();
      try {
        signal.throwIfAborted();
        await client.query("BEGIN; SET LOCAL synchronous_commit=on; SET LOCAL lock_timeout='2s'");
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `slack-intake:${owner}`,
        ]);
        const inserted = await client.query(
          `INSERT INTO channel_slack_intake(owner_id,installation,message_ts,ciphertext)
           SELECT $1,$2,$3,$4 WHERE (SELECT
              count(*) < 8 AND coalesce(sum(octet_length(ciphertext)),0)+octet_length($4::bytea) <= 104857600
              FROM channel_slack_intake WHERE owner_id=$1)
           ON CONFLICT DO NOTHING`,
          [owner, installation, ts, ciphertext],
        );
        if (
          !inserted.rowCount &&
          !(
            await client.query(
              'SELECT 1 FROM channel_slack_intake WHERE owner_id=$1 AND installation=$2 AND message_ts=$3',
              [owner, installation, ts],
            )
          ).rowCount
        )
          throw new MessagingConnectionError('Slack attachment intake is full.');
        signal.throwIfAborted();
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async next(installation: string, before?: string) {
      await initialize();
      let key: Buffer | undefined;
      for (;;) {
        const row = (
          await pool.query<{ message_ts: string; ciphertext: Buffer }>(
            `SELECT message_ts,ciphertext FROM channel_slack_intake
           WHERE owner_id=$1 AND installation=$2
             AND created_at >= now()-interval '24 hours'
             AND ($3::numeric IS NULL OR message_ts::numeric < $3::numeric)
           ORDER BY message_ts::numeric LIMIT 1`,
            [owner, installation, before ?? null],
          )
        ).rows[0];
        if (!row) return;
        key ??= await keyStore.getKey();
        if (key.length !== 32) throw new MessagingConnectionError('Slack intake key is invalid.');
        const bytes = row.ciphertext;
        try {
          const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
          decipher.setAAD(binding(installation, row.message_ts));
          decipher.setAuthTag(bytes.subarray(12, 28));
          return {
            ts: row.message_ts,
            value: deserialize(
              Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]),
            ) as T,
          };
        } catch {
          await pool.query(
            `DELETE FROM channel_slack_intake
             WHERE owner_id=$1 AND installation=$2 AND message_ts=$3 AND ciphertext=$4`,
            [owner, installation, row.message_ts, bytes],
          );
          logRepeatedFailure(
            'slack_attachment_unreadable',
            'slack_attachment_unreadable',
            undefined,
          );
        }
      }
    },
    async complete(installation: string, ts: string, sourceId: string) {
      return Boolean(
        (
          await pool.query(
            `DELETE FROM channel_slack_intake
         WHERE owner_id=$1 AND installation=$2 AND message_ts=$3
         AND EXISTS (SELECT 1 FROM channel_inbox WHERE owner_id=$1 AND source_id=$4)`,
            [owner, installation, ts, sourceId],
          )
        ).rowCount,
      );
    },
  };
}
