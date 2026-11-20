import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type {
  MessagingControl,
  MessagingConversation,
  MessagingTransport,
} from '../ports/messaging.ts';
import { transaction } from './transaction.ts';
import { logFailure } from './failure-log.ts';
import { laterSupersedingTurnSql, waitingTurnSql, workOriginSql } from './turn-chain.ts';
import { z } from 'zod';

interface Root {
  owner_id: string;
  account_id: string;
  sender_id: string;
  dm: string;
  session_id: string;
  thread_id: string;
  turn_id: string;
  channel: string;
  root_id: string | null;
  target_id: string | null;
  nonce: string | null;
  status_nonce: string | null;
  expires_at: Date | null;
  control_message_id: string | null;
  state: string;
  last_status: string | null;
  lifecycle_revision: string;
  current?: boolean;
  installation_id?: string;
}

type AnswerScope =
  | { kind: 'legacy' }
  | { kind: 'refused' }
  | { kind: 'fresh'; conversationId: string; threadId: string }
  | {
      kind: 'main';
      conversationId: string | null;
      turnId: string;
      messageId: string;
      requestId: string | null;
    };

export async function createChannelRich(
  pool: Pool,
  options: {
    ownerId: string;
    transport(): MessagingTransport;
    permitted(identity: { provider: string; account_id: string; sender_id: string }): boolean;
    safe(text: string): { text: string; secureAction: boolean; artifact: boolean };
    lock?(client: PoolClient): Promise<unknown>;
    cancel?<T>(work: (client: PoolClient) => Promise<T>): Promise<T>;
    control?(
      client: PoolClient,
      target: { threadId: string; sessionId: string; turnId: string; channel: string },
    ): Promise<() => Promise<void>>;
  },
) {
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_roots (
    owner_id text NOT NULL,account_id text NOT NULL,sender_id text NOT NULL,dm text NOT NULL,
    session_id uuid NOT NULL,thread_id uuid NOT NULL,turn_id uuid NOT NULL,channel text NOT NULL,
    root_id text,target_id uuid,nonce uuid,status_nonce uuid,expires_at timestamptz,control_message_id text,state text NOT NULL DEFAULT 'preparing',last_status text,lifecycle_revision bigint NOT NULL DEFAULT 0,
    PRIMARY KEY(owner_id,account_id,sender_id,dm,session_id));
    CREATE TABLE IF NOT EXISTS channel_controls(owner_id text NOT NULL,event_id text NOT NULL,PRIMARY KEY(owner_id,event_id));
    ALTER TABLE channel_controls ADD COLUMN IF NOT EXISTS kind text;
    ALTER TABLE channel_controls ADD COLUMN IF NOT EXISTS turn_id uuid;
    ALTER TABLE channel_controls ADD COLUMN IF NOT EXISTS connection_revision uuid;
    ALTER TABLE channel_controls ADD COLUMN IF NOT EXISTS expires_at timestamptz;
    ALTER TABLE channel_controls ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
    CREATE INDEX IF NOT EXISTS channel_controls_bound ON channel_controls(owner_id,turn_id) WHERE turn_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS channel_control_intents(
      owner_id text NOT NULL,installation_id text NOT NULL,event_id text NOT NULL,
      seq bigserial NOT NULL,connection_revision uuid NOT NULL,control jsonb NOT NULL,
      state text NOT NULL DEFAULT 'pending',outcome text,received_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz,
      PRIMARY KEY(owner_id,installation_id,event_id),CHECK ((state='pending') = (settled_at IS NULL)));
    CREATE INDEX IF NOT EXISTS channel_control_intents_pending ON channel_control_intents(owner_id,seq) WHERE state='pending';
    CREATE INDEX IF NOT EXISTS channel_control_intents_settled ON channel_control_intents(owner_id,settled_at) WHERE state<>'pending';
    CREATE TABLE IF NOT EXISTS channel_streams(owner_id text NOT NULL,message_id uuid NOT NULL,part integer NOT NULL,
      account_id text NOT NULL,sender_id text NOT NULL,dm text NOT NULL,session_id uuid NOT NULL,turn_id uuid NOT NULL,
      root_id text NOT NULL,revision uuid NOT NULL,provider_id text,state text NOT NULL,confirmed_chars integer NOT NULL DEFAULT 0,
      PRIMARY KEY(owner_id,message_id,part));
    CREATE INDEX IF NOT EXISTS turns_rich_live ON turns(owner_id,session_id) WHERE status IN ('queued','running','waiting');
    CREATE INDEX IF NOT EXISTS turns_rich_session_time ON turns(owner_id,session_id,created_at,id);
    CREATE INDEX IF NOT EXISTS channel_roots_dirty ON channel_roots(owner_id,session_id)
      WHERE state='open' AND (last_status IS NULL OR last_status IN ('processing','suspended'));`);
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_main_conversations (
    id uuid PRIMARY KEY,owner_id text NOT NULL,installation_id text NOT NULL,account_id text NOT NULL,
    sender_id text NOT NULL,dm text NOT NULL,root_id text NOT NULL,thread_id uuid NOT NULL,session_id uuid NOT NULL,target_id uuid NOT NULL,
    UNIQUE(owner_id,installation_id,account_id,sender_id,dm,root_id));
    CREATE INDEX IF NOT EXISTS channel_main_root ON channel_main_conversations(owner_id,root_id);
    CREATE TABLE IF NOT EXISTS channel_main_work (
      owner_id text NOT NULL,turn_id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES channel_main_conversations(id),
      generation uuid NOT NULL,connection_revision uuid NOT NULL,nonce uuid,status_nonce uuid,expires_at timestamptz,
      control_message_id text,last_status text,lifecycle_revision bigint NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS channel_main_dirty ON channel_main_work(owner_id,turn_id)
      WHERE last_status IS NULL OR last_status IN ('processing','suspended');
    CREATE INDEX IF NOT EXISTS channel_main_conversation_work ON channel_main_work(owner_id,conversation_id,turn_id);`);
  await pool.query(`CREATE TABLE IF NOT EXISTS channel_main_turns (
    owner_id text NOT NULL,turn_id uuid PRIMARY KEY,conversation_id uuid NOT NULL REFERENCES channel_main_conversations(id),turn_created_at timestamptz NOT NULL);
    CREATE INDEX IF NOT EXISTS channel_main_answer_turn ON channel_main_turns(owner_id,conversation_id,turn_created_at DESC,turn_id DESC);
    CREATE INDEX IF NOT EXISTS messages_main_answer ON messages(owner_id,turn_id,created_at DESC,id DESC) WHERE role='assistant';
    CREATE INDEX IF NOT EXISTS turns_main_answer_started ON turns(owner_id,session_id,started_at) WHERE started_at IS NOT NULL;`);
  const hasApprovals = (await pool.query("SELECT to_regclass('approvals') AS name")).rows[0]?.name;
  if ((await pool.query("SELECT to_regclass('credential_requests') AS name")).rows[0]?.name)
    await pool.query(
      "CREATE INDEX IF NOT EXISTS credential_requests_reply_pending ON credential_requests(owner_id,turn_id) WHERE status='pending'",
    );
  await pool.query(
    "UPDATE channel_roots SET state='uncertain',nonce=NULL WHERE owner_id=$1 AND state='preparing'",
    [options.ownerId],
  );
  await pool.query('UPDATE channel_roots SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1', [
    options.ownerId,
  ]);
  await pool.query(
    "UPDATE channel_roots SET state='uncertain',nonce=NULL,status_nonce=NULL,control_message_id=NULL WHERE owner_id=$1 AND session_id=thread_id",
    [options.ownerId],
  );
  await pool.query(
    "UPDATE channel_streams s SET state='uncertain' WHERE s.owner_id=$1 AND EXISTS (SELECT 1 FROM turns u WHERE u.owner_id=s.owner_id AND u.session_id=s.session_id AND u.session_id=u.thread_id)",
    [options.ownerId],
  );
  if ((await pool.query("SELECT to_regclass('channel_retired_roots') AS name")).rows[0]?.name)
    await pool.query('DELETE FROM channel_retired_roots WHERE owner_id=$1', [options.ownerId]);
  let lifetime = new AbortController();
  let revision = randomUUID();
  await pool.query('UPDATE channel_main_work SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1', [
    options.ownerId,
  ]);
  await pool.query(
    "UPDATE channel_streams SET state='uncertain' WHERE owner_id=$1 AND state NOT IN ('finalized','uncertain')",
    [options.ownerId],
  );
  await pool.query(
    "UPDATE channel_control_intents SET state='expired',outcome='restart',settled_at=now() WHERE owner_id=$1 AND state='pending'",
    [options.ownerId],
  );
  let closed = false;
  let used = false;
  let running: Promise<void> | undefined;
  let preparing = 0;
  let release: (() => void) | undefined;
  const shown = new Map<string, string>();
  const permitted = (row: Root) =>
    options.permitted({ provider: 'slack', account_id: row.account_id, sender_id: row.sender_id });
  const rich = () =>
    options
      .transport()
      .channels.some((channel) => channel.id === 'slack' && channel.rich && channel.available);
  const installation = () =>
    options.transport().channels.find((channel) => channel.id === 'slack')?.installationId;
  let mainCursor: string | null = null;
  let taskCursor: string | null = null;
  let boundCursor: string | null = null;

  async function bindMain(
    client: PoolClient,
    receipt: {
      account_id: string;
      sender_id: string;
      thread_id: string;
      canonical_root_id: string | null;
      installation_id: string | null;
    },
    turnId: string,
    targetId: string,
  ) {
    if (
      !receipt.canonical_root_id ||
      !receipt.installation_id ||
      receipt.installation_id !== installation()
    )
      return;
    const turn = (
      await client.query(
        `SELECT u.thread_id,u.session_id,u.created_at::text AS created_at FROM turns u JOIN threads th ON th.owner_id=u.owner_id AND th.id=u.thread_id
       JOIN messages m ON m.id=$3 AND m.turn_id=u.id AND m.owner_id=u.owner_id AND m.role='user'
       WHERE u.id=$1 AND u.owner_id=$2 AND u.session_id=u.thread_id AND u.source IN ('user','resume') AND NOT u.proactive AND th.archived_at IS NULL`,
        [turnId, options.ownerId, targetId],
      )
    ).rows[0];
    if (!turn) return;
    await client.query(
      `INSERT INTO channel_main_conversations(id,owner_id,installation_id,account_id,sender_id,dm,root_id,thread_id,session_id,target_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT DO NOTHING`,
      [
        randomUUID(),
        options.ownerId,
        receipt.installation_id,
        receipt.account_id,
        receipt.sender_id,
        receipt.thread_id,
        receipt.canonical_root_id,
        turn.thread_id,
        turn.session_id,
        targetId,
      ],
    );
    const conversation = (
      await client.query(
        `SELECT id FROM channel_main_conversations WHERE owner_id=$1 AND installation_id=$2 AND account_id=$3 AND sender_id=$4
       AND dm=$5 AND root_id=$6 AND thread_id=$7 AND session_id=$8`,
        [
          options.ownerId,
          receipt.installation_id,
          receipt.account_id,
          receipt.sender_id,
          receipt.thread_id,
          receipt.canonical_root_id,
          turn.thread_id,
          turn.session_id,
        ],
      )
    ).rows[0];
    if (!conversation) throw new Error('The Slack conversation binding has changed.');
    await client.query(
      `INSERT INTO channel_main_turns(owner_id,turn_id,conversation_id,turn_created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
      [options.ownerId, turnId, conversation.id, turn.created_at],
    );
    if (
      !(
        await client.query(
          'SELECT 1 FROM channel_main_turns WHERE owner_id=$1 AND turn_id=$2 AND conversation_id=$3',
          [options.ownerId, turnId, conversation.id],
        )
      ).rowCount
    )
      throw new Error('The Slack answer binding has changed.');
    if (!rich()) return;
    used = true;
    await client.query(
      `INSERT INTO channel_main_work(owner_id,turn_id,conversation_id,generation,connection_revision)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [options.ownerId, turnId, conversation.id, randomUUID(), revision],
    );
  }

  async function inheritMain(turnId: string) {
    await pool.query(
      `WITH RECURSIVE lineage AS (
         SELECT u.id,u.parent_turn_id,u.owner_id,u.thread_id,u.channel,0 AS depth FROM turns u
         WHERE u.id=$1 AND u.owner_id=$2 AND u.session_id=u.thread_id AND u.source='resume' AND NOT u.proactive
         UNION ALL SELECT p.id,p.parent_turn_id,p.owner_id,p.thread_id,p.channel,c.depth+1 FROM lineage c JOIN turns p
           ON p.id=c.parent_turn_id AND p.owner_id=c.owner_id AND p.thread_id=c.thread_id AND p.channel=c.channel WHERE c.depth<200)
       INSERT INTO channel_main_turns(owner_id,turn_id,conversation_id,turn_created_at)
       SELECT $2,$1,b.conversation_id,u.created_at FROM lineage l JOIN channel_main_turns b ON b.turn_id=l.id AND b.owner_id=$2
       JOIN turns u ON u.id=$1 AND u.owner_id=$2
       JOIN channel_main_conversations c ON c.id=b.conversation_id AND c.installation_id=$3 ORDER BY l.depth LIMIT 1 ON CONFLICT DO NOTHING`,
      [turnId, options.ownerId, installation() ?? null],
    );
    if (rich())
      await pool.query(
        `INSERT INTO channel_main_work(owner_id,turn_id,conversation_id,generation,connection_revision)
         SELECT owner_id,turn_id,conversation_id,$3,$4 FROM channel_main_turns WHERE owner_id=$1 AND turn_id=$2 ON CONFLICT DO NOTHING`,
        [options.ownerId, turnId, randomUUID(), revision],
      );
  }

  async function resolveAnswer(
    database: Pool | PoolClient,
    identity: { account_id: string; sender_id: string },
    dm: string,
    root: string,
    purpose: 'ordinary' | 'verification',
    exactMessageId?: string,
  ): Promise<AnswerScope> {
    if (!options.permitted({ ...identity, provider: 'slack' })) return { kind: 'refused' };
    const conversation = (
      await database.query(
        `SELECT c.id,c.thread_id,c.session_id,(c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.installation_id=$6 AND th.archived_at IS NULL) AS allowed
         FROM channel_main_conversations c JOIN threads th ON th.id=c.thread_id AND th.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND c.root_id=$5 ORDER BY (c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.installation_id=$6) DESC LIMIT 1`,
        [
          options.ownerId,
          identity.account_id,
          identity.sender_id,
          dm,
          root,
          installation() ?? null,
        ],
      )
    ).rows[0];
    if (conversation && !conversation.allowed) return { kind: 'refused' };
    const unanswered = (): AnswerScope =>
      purpose === 'ordinary' && conversation?.allowed
        ? { kind: 'fresh', conversationId: conversation.id, threadId: conversation.thread_id }
        : { kind: 'refused' };
    if (!conversation && !exactMessageId) return { kind: 'legacy' };
    const binding = conversation
      ? (
          await database.query(
            `SELECT turn_id FROM channel_main_turns WHERE owner_id=$1 AND conversation_id=$2 ORDER BY turn_created_at DESC,turn_id DESC LIMIT 1`,
            [options.ownerId, conversation.id],
          )
        ).rows[0]
      : undefined;
    if (conversation && !binding) return unanswered();
    const row = (
      await database.query(
        `WITH latest AS MATERIALIZED (
           SELECT m.* FROM messages m WHERE m.owner_id=$1 AND m.role='assistant' AND m.turn_id=COALESCE($2::uuid,
             (SELECT turn_id FROM messages WHERE owner_id=$1 AND id=$3::uuid)) ORDER BY m.created_at DESC,m.id DESC LIMIT 1)
         SELECT m.id,m.turn_id,m.hidden_at,u.status,u.waiting_reason,u.withdrawn,u.session_id,u.thread_id,u.channel,u.created_at::text AS created_at,u.started_at::text AS started_at,
           o.state,o.delivery_only,o.provider_message_ids,o.answer_conversation_id,o.dispatched_root_id,o.dispatched_installation_id,
           i.account_id,i.sender_id,i.thread_id AS dm,i.installation_id,i.channel AS receipt_channel,
           EXISTS(SELECT 1 FROM threads th WHERE th.id=u.thread_id AND th.owner_id=$1 AND th.archived_at IS NULL) AS active,
           ${hasApprovals ? 'EXISTS(SELECT 1 FROM approvals a WHERE a.owner_id=$1 AND a.confirmation_message_id=m.id)' : 'false'} AS approval
         FROM latest m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
         LEFT JOIN channel_outbox o ON o.message_id=m.id
         LEFT JOIN channel_inbox i ON i.source_id=o.source_id AND i.owner_id=m.owner_id AND i.provider='slack'`,
        [options.ownerId, binding?.turn_id ?? null, exactMessageId ?? null],
      )
    ).rows[0];
    if (
      !row ||
      row.hidden_at ||
      row.withdrawn ||
      !row.active ||
      row.session_id !== row.thread_id ||
      row.state !== 'sent' ||
      row.delivery_only ||
      !row.provider_message_ids?.length ||
      row.account_id !== identity.account_id ||
      row.sender_id !== identity.sender_id ||
      row.dm !== dm ||
      row.channel !== row.receipt_channel ||
      (conversation &&
        (row.thread_id !== conversation.thread_id ||
          row.session_id !== conversation.session_id ||
          row.answer_conversation_id !== conversation.id ||
          row.dispatched_root_id !== root ||
          row.dispatched_installation_id !== installation())) ||
      (!conversation &&
        (row.id !== exactMessageId ||
          !row.provider_message_ids.includes(root) ||
          row.dispatched_root_id !== null ||
          row.installation_id !== installation())) ||
      row.approval
    )
      return unanswered();
    const current = (
      await database.query(
        `SELECT NOT ${laterSupersedingTurnSql} AS question_current,(${waitingTurnSql('u', 'credentials')}) AS credentials_current
         FROM (SELECT $1::text AS owner_id,$2::uuid AS session_id,$3::timestamptz AS created_at,$4::uuid AS id,
           $5::timestamptz AS started_at,$6::text AS status,$7::text AS waiting_reason,$8::uuid AS thread_id) u`,
        [
          options.ownerId,
          row.session_id,
          row.created_at,
          row.turn_id,
          row.started_at,
          row.status,
          row.waiting_reason,
          row.thread_id,
        ],
      )
    ).rows[0];
    let requestId: string | null = null;
    if (purpose === 'verification') {
      if (!current.credentials_current) return { kind: 'refused' };
      const request = await database.query(
        `SELECT q.request_id FROM chat_verification_questions q JOIN credential_requests r ON r.id=q.request_id
           WHERE q.message_id=$1 AND r.owner_id=$2 AND r.turn_id=$3 AND r.thread_id=$4 AND r.status='pending' AND r.kind='otp' LIMIT 2`,
        [row.id, options.ownerId, row.turn_id, row.thread_id],
      );
      if (request.rowCount !== 1) return { kind: 'refused' };
      requestId = request.rows[0].request_id;
    } else if (!(
      row.status === 'succeeded' ||
      (row.status === 'waiting' && row.waiting_reason === 'question' && current.question_current)
    ))
      return unanswered();
    if (!conversation && row.status === 'succeeded' && !current.question_current)
      return { kind: 'refused' };
    return {
      kind: 'main',
      conversationId: conversation?.id ?? null,
      turnId: row.turn_id,
      messageId: row.id,
      requestId,
    };
  }

  async function mainRoot(turnId: string): Promise<Root | undefined> {
    if (!installation()) return;
    await inheritMain(turnId);
    return (
      await pool.query<Root>(
        `SELECT c.*,w.turn_id,w.nonce,w.status_nonce,w.expires_at,w.control_message_id,w.last_status,w.lifecycle_revision,
        u.channel,'open' AS state,
        u.id=COALESCE((SELECT live.id FROM turns live WHERE live.owner_id=u.owner_id AND live.session_id=u.session_id AND live.status='running'
          ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
          (SELECT latest.id FROM turns latest WHERE latest.owner_id=u.owner_id AND latest.session_id=u.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)) AS current
       FROM channel_main_work w JOIN channel_main_conversations c ON c.id=w.conversation_id AND c.owner_id=w.owner_id
       JOIN turns u ON u.id=w.turn_id AND u.owner_id=w.owner_id JOIN threads th ON th.id=c.thread_id AND th.owner_id=c.owner_id
       WHERE w.owner_id=$1 AND w.turn_id=$2 AND c.installation_id=$3 AND th.archived_at IS NULL`,
        [options.ownerId, turnId, installation() ?? null],
      )
    ).rows[0];
  }

  async function desiredStatus(
    identity: { account_id: string; sender_id: string; thread_id: string },
    root: string,
  ) {
    const row = (
      await pool.query<{ status: string; current: boolean }>(
        `SELECT u.status,u.id=COALESCE(
          (SELECT live.id FROM turns live WHERE live.owner_id=u.owner_id AND live.session_id=u.session_id AND live.status='running' ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
          (SELECT latest.id FROM turns latest WHERE latest.owner_id=u.owner_id AND latest.session_id=u.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1)) AS current
       FROM channel_main_conversations c JOIN channel_main_work w ON w.conversation_id=c.id AND w.owner_id=c.owner_id
       JOIN turns u ON u.id=w.turn_id AND u.owner_id=w.owner_id
       WHERE c.owner_id=$1 AND c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.root_id=$5 AND c.installation_id=$6
       ORDER BY u.status='running' DESC,u.created_at DESC,u.id DESC LIMIT 1`,
        [
          options.ownerId,
          identity.account_id,
          identity.sender_id,
          identity.thread_id,
          root,
          installation() ?? null,
        ],
      )
    ).rows[0];
    if (row && !row.current) return 'active' as const;
    if (row)
      return row.status === 'running' || row.status === 'queued'
        ? ('processing' as const)
        : row.status === 'waiting'
          ? ('suspended' as const)
          : ('active' as const);
    const task = (
      await pool.query<{ status: string; state: string }>(
        `SELECT u.status,t.state FROM channel_roots r JOIN tasks t ON t.session_id=r.session_id AND t.owner_id=r.owner_id
       JOIN turns u ON u.id=COALESCE(
         (SELECT live.id FROM turns live WHERE live.owner_id=r.owner_id AND live.session_id=r.session_id AND live.status='running' ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
         (SELECT latest.id FROM turns latest WHERE latest.owner_id=r.owner_id AND latest.session_id=r.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))
       WHERE r.owner_id=$1 AND r.account_id=$2 AND r.sender_id=$3 AND r.dm=$4 AND r.root_id=$5 AND r.session_id<>r.thread_id`,
        [options.ownerId, identity.account_id, identity.sender_id, identity.thread_id, root],
      )
    ).rows[0];
    return task?.status === 'running' || task?.status === 'queued'
      ? 'processing'
      : task?.status === 'waiting'
        ? 'suspended'
        : task && task.state !== 'open'
          ? 'closed'
          : 'active';
  }

  async function stepMain(targetTurnId?: string) {
    if (!installation()) return;
    const signal = lifetime.signal;
    const candidates = await pool.query<{ id: string }>(
      `WITH candidates AS MATERIALIZED (
         SELECT id FROM turns WHERE owner_id=$1 AND session_id=thread_id AND status IN ('queued','running','waiting') AND starts_with(channel,'slack:')
         UNION SELECT turn_id FROM channel_main_work WHERE owner_id=$1 AND (last_status IS NULL OR last_status IN ('processing','suspended')))
       SELECT id FROM candidates WHERE ($2::uuid IS NULL OR id=$2) AND ($2::uuid IS NOT NULL OR $3::uuid IS NULL OR id>$3)
       ORDER BY id LIMIT 100`,
      [options.ownerId, targetTurnId ?? null, mainCursor],
    );
    if (!targetTurnId)
      mainCursor = candidates.rows.length === 100 ? candidates.rows.at(-1)!.id : null;
    for (const candidate of candidates.rows) {
      if (closed || signal.aborted || (!targetTurnId && preparing)) break;
      const row = await mainRoot(candidate.id);
      if (!row || !permitted(row)) continue;
      const turn = (
        await pool.query<{ status: string }>(
          'SELECT status FROM turns WHERE id=$1 AND owner_id=$2',
          [row.turn_id, options.ownerId],
        )
      ).rows[0];
      if (!turn) continue;
      if (!row.current && turn.status === 'queued') continue;
      const desired = !row.current
        ? 'active'
        : turn.status === 'running' || turn.status === 'queued'
          ? 'processing'
          : turn.status === 'waiting'
            ? 'suspended'
            : 'active';
      const nonce =
        row.current && turn.status === 'running'
          ? row.nonce && row.expires_at && row.expires_at.getTime() > Date.now()
            ? row.nonce
            : randomUUID()
          : null;
      const activity = desired === 'processing' ? await activityLine(row.turn_id) : '';
      const signature = JSON.stringify([
        row.turn_id,
        desired,
        nonce,
        activity,
        desired === 'processing' ? Math.floor(Date.now() / (45 * 60_000)) : 0,
      ]);
      const key = `main:${row.turn_id}`;
      if (shown.get(key) === signature && row.last_status === desired) continue;
      if (
        !row.current &&
        (await desiredStatus({ ...row, thread_id: row.dm }, row.root_id!)) !== 'active'
      ) {
        await pool.query(
          "UPDATE channel_main_work SET nonce=NULL,status_nonce=NULL,last_status='active' WHERE owner_id=$1 AND turn_id=$2",
          [options.ownerId, row.turn_id],
        );
        continue;
      }
      const claim = (
        await pool.query<{ lifecycle_revision: string; status_nonce: string }>(
          `UPDATE channel_main_work SET nonce=$3,status_nonce=CASE WHEN nonce IS NOT DISTINCT FROM $3::uuid THEN status_nonce ELSE $4 END,
         expires_at=CASE WHEN nonce IS NOT DISTINCT FROM $3::uuid THEN expires_at ELSE now()+interval '15 minutes' END,
         connection_revision=$5,lifecycle_revision=lifecycle_revision+1 WHERE owner_id=$1 AND turn_id=$2 RETURNING lifecycle_revision,status_nonce`,
          [options.ownerId, row.turn_id, nonce, randomUUID(), revision],
        )
      ).rows[0];
      const current = async () => {
        if (closed || signal.aborted || !permitted(row) || row.installation_id !== installation())
          return false;
        const latest = await mainRoot(row.turn_id);
        if (!latest || latest.lifecycle_revision !== claim.lifecycle_revision) return false;
        if (row.current && !latest.current) return false;
        return (
          (await desiredStatus({ ...row, thread_id: row.dm }, row.root_id!)) === desired &&
          (desired !== 'processing' || (await activityLine(row.turn_id)) === activity)
        );
      };
      try {
        const view = await options.transport().conversation?.({
          ownerId: options.ownerId,
          channelId: 'slack',
          accountId: row.account_id,
          threadId: row.dm,
          sessionId: row.session_id,
          turnId: row.turn_id,
          rootMessageId: row.root_id!,
          status: desired,
          title: 'Nod',
          text: '',
          activity,
          control: nonce ? { stop: nonce, status: claim.status_nonce } : undefined,
          outcome:
            turn.status === 'failed' || turn.status === 'cancelled' ? turn.status : undefined,
          signal,
          current,
        });
        if (await current()) {
          await pool.query(
            `UPDATE channel_main_work SET last_status=$3,control_message_id=COALESCE($4,control_message_id)
             WHERE owner_id=$1 AND turn_id=$2 AND lifecycle_revision=$5 AND connection_revision=$6`,
            [
              options.ownerId,
              row.turn_id,
              desired,
              view?.id ?? null,
              claim.lifecycle_revision,
              revision,
            ],
          );
          shown.set(key, signature);
        }
      } catch (cause) {
        if (!signal.aborted) logFailure('channel_session_failed', cause);
      }
    }
  }

  async function activityLine(turnId: string) {
    const row = (
      await pool.query<{ summary: string }>(
        `SELECT e.summary FROM turns u JOIN turn_events e ON e.turn_id=u.id
         WHERE u.owner_id=$1 AND u.id=$2 AND u.status='running'
           AND u.started_at<now()-interval '3 seconds' AND e.type='step'
           AND NOT EXISTS (SELECT 1 FROM turn_events later WHERE later.turn_id=u.id
             AND later.type IN ('step','steered','final') AND (later.created_at,later.id)>(e.created_at,e.id))
         ORDER BY e.created_at DESC,e.id DESC LIMIT 1`,
        [options.ownerId, turnId],
      )
    ).rows[0];
    if (!row) return '';
    const safe = options.safe(row.summary);
    return safe.secureAction || safe.artifact
      ? ''
      : Array.from(safe.text.replace(/\s+/g, ' ').trim()).slice(0, 200).join('');
  }

  const controlSchema = z.object({
    channelId: z.literal('slack'),
    accountId: z.string().min(1).max(100),
    senderId: z.string().min(1).max(100),
    threadId: z.string().min(1).max(100),
    eventId: z.string().min(1).max(500),
    rootMessageId: z.string().min(1).max(100),
    action: z.enum(['stop', 'status']),
    nonce: z.uuid().optional(),
    messageId: z.string().max(100).optional(),
    streamIds: z.array(z.string().min(1).max(100)).max(50).optional(),
    installationId: z.string().min(1).max(100).optional(),
  });
  const attempted = new Set<string>();
  let draining: Promise<void> | undefined;
  let drainAgain = false;
  let nextCleanup = Date.now() + 600_000;

  async function intake(input: MessagingControl) {
    if (!controlSchema.safeParse(input).success) return;
    const recorded = revision;
    if (
      closed ||
      lifetime.signal.aborted ||
      !rich() ||
      !input.installationId ||
      input.installationId !== installation()
    )
      throw new Error('Slack control was not recorded: the Slack connection is not ready.');
    const key = [options.ownerId, input.installationId, input.eventId];
    const inserted = await pool.query(
      `INSERT INTO channel_control_intents(owner_id,installation_id,event_id,connection_revision,control)
       SELECT $1,$2,$3,$4,$5 WHERE (SELECT count(*) FROM channel_control_intents WHERE owner_id=$1 AND state='pending')<32
       ON CONFLICT DO NOTHING RETURNING seq`,
      [...key, recorded, input],
    );
    if (
      !inserted.rowCount &&
      !(
        await pool.query(
          'SELECT 1 FROM channel_control_intents WHERE owner_id=$1 AND installation_id=$2 AND event_id=$3',
          key,
        )
      ).rowCount
    )
      throw new Error('Slack control was not recorded: 32 controls are already waiting.');
    drainControls();
  }

  function drainControls() {
    if (draining) {
      drainAgain = true;
      return;
    }
    draining = (async () => {
      do {
        drainAgain = false;
        await drainPass();
      } while (drainAgain && !closed);
    })()
      .catch((cause) => logFailure('channel_control_failed', cause))
      .finally(() => {
        draining = undefined;
      });
  }

  async function drainPass() {
    for (;;) {
      if (closed) return;
      const pending = (
        await pool.query<{
          installation_id: string;
          event_id: string;
          connection_revision: string;
          control: unknown;
        }>(
          "SELECT installation_id,event_id,connection_revision,control FROM channel_control_intents WHERE owner_id=$1 AND state='pending' ORDER BY seq LIMIT 50",
          [options.ownerId],
        )
      ).rows.filter((intent) => !attempted.has(`${intent.installation_id}:${intent.event_id}`));
      if (!pending.length) break;
      for (const intent of pending.slice(0, 8)) await apply(intent);
    }
    if (Date.now() >= nextCleanup) {
      nextCleanup = Date.now() + 600_000;
      await cleanup();
    }
  }

  async function apply(intent: {
    installation_id: string;
    event_id: string;
    connection_revision: string;
    control: unknown;
  }) {
    const id = `${intent.installation_id}:${intent.event_id}`;
    const key = [options.ownerId, intent.installation_id, intent.event_id];
    const signal = lifetime.signal;
    attempted.add(id);
    const after = await (options.cancel ?? ((work) => transaction(work, pool)))(async (client) => {
      const settle = async (outcome: string, finish?: () => Promise<void>) => {
        await client.query(
          'UPDATE channel_control_intents SET state=$4,outcome=$5,settled_at=now() WHERE owner_id=$1 AND installation_id=$2 AND event_id=$3',
          [
            ...key,
            outcome === 'stop' || outcome === 'status'
              ? 'applied'
              : outcome === 'age'
                ? 'expired'
                : 'refused',
            outcome,
          ],
        );
        return finish;
      };
      const pending = (
        await client.query<{ old: boolean }>(
          "SELECT received_at<now()-interval '15 minutes' AS old FROM channel_control_intents WHERE owner_id=$1 AND installation_id=$2 AND event_id=$3 AND state='pending' FOR UPDATE",
          key,
        )
      ).rows[0];
      if (!pending) return;
      if (pending.old) return settle('age');
      if (intent.connection_revision !== revision) return settle('revision');
      const parsed = controlSchema.safeParse(intent.control);
      if (
        !parsed.success ||
        parsed.data.installationId !== intent.installation_id ||
        intent.installation_id !== installation()
      )
        return settle('installation');
      const input = parsed.data;
      if (closed || signal.aborted || !rich()) return settle('closed');
      await options.lock?.(client);
      let row = (
        await client.query<Root>(
          `SELECT r.* FROM channel_roots r JOIN threads th ON th.id=r.thread_id AND th.owner_id=r.owner_id
         WHERE r.owner_id=$1 AND r.account_id=$2 AND r.sender_id=$3 AND r.dm=$4 AND r.root_id=$5
           AND r.state='open' AND th.archived_at IS NULL
           AND r.session_id<>r.thread_id
           AND EXISTS(SELECT 1 FROM tasks t WHERE t.owner_id=r.owner_id AND t.session_id=r.session_id AND t.state='open') FOR UPDATE OF r`,
          [options.ownerId, input.accountId, input.senderId, input.threadId, input.rootMessageId],
        )
      ).rows[0];
      let main = false;
      if (!row && input.installationId && input.installationId === installation()) {
        row = (
          await client.query<Root>(
            `SELECT c.*,w.turn_id,w.nonce,w.status_nonce,w.expires_at,w.control_message_id,w.last_status,w.lifecycle_revision,u.channel,'open' AS state
           FROM channel_main_conversations c JOIN channel_main_work w ON w.conversation_id=c.id AND w.owner_id=c.owner_id
           JOIN turns u ON u.id=w.turn_id AND u.owner_id=w.owner_id JOIN threads th ON th.id=c.thread_id AND th.owner_id=c.owner_id
           WHERE c.owner_id=$1 AND c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.root_id=$5 AND c.installation_id=$6
             AND w.connection_revision=$7 AND u.status='running' AND th.archived_at IS NULL
             AND u.id=(SELECT n.id FROM turns n WHERE n.owner_id=u.owner_id AND n.session_id=u.session_id AND n.status='running' ORDER BY n.created_at DESC,n.id DESC LIMIT 1)
           FOR UPDATE OF w`,
            [
              options.ownerId,
              input.accountId,
              input.senderId,
              input.threadId,
              input.rootMessageId,
              input.installationId,
              revision,
            ],
          )
        ).rows[0];
        main = Boolean(row);
      }
      if (!row || !permitted(row) || closed || lifetime.signal.aborted)
        return settle('not_current');
      if (
        input.nonce
          ? input.nonce !== (input.action === 'stop' ? row.nonce : row.status_nonce) ||
            input.messageId !== row.control_message_id ||
            !row.expires_at ||
            row.expires_at.getTime() <= Date.now()
          : !input.streamIds?.length || input.action !== 'stop'
      )
        return settle(input.nonce ? 'stale_nonce' : 'stream');
      if (!input.nonce) {
        const streams = await client.query(
          `SELECT provider_id FROM channel_streams WHERE owner_id=$1 AND account_id=$2 AND sender_id=$3 AND dm=$4 AND root_id=$5
          AND session_id=$6 AND turn_id=$7 AND revision=$8 AND state='open' AND provider_id=ANY($9::text[]) FOR UPDATE`,
          [
            options.ownerId,
            row.account_id,
            row.sender_id,
            row.dm,
            row.root_id,
            row.session_id,
            row.turn_id,
            revision,
            input.streamIds,
          ],
        );
        if (streams.rowCount !== new Set(input.streamIds).size) return settle('stream');
      }
      const current = await client.query(
        "SELECT 1 FROM turns WHERE id=$1 AND owner_id=$2 AND session_id=$3 AND thread_id=$4 AND channel=$5 AND status='running'",
        [row.turn_id, options.ownerId, row.session_id, row.thread_id, row.channel],
      );
      if (!current.rowCount || signal.aborted) return settle('not_current');
      const claim = await client.query(
        `INSERT INTO channel_controls(owner_id,event_id,kind,turn_id,connection_revision,expires_at,claimed_at)
         VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT DO NOTHING RETURNING event_id`,
        [
          options.ownerId,
          input.eventId,
          input.nonce ? 'nonce' : 'stream',
          row.turn_id,
          revision,
          input.nonce ? row.expires_at : null,
        ],
      );
      if (!claim.rowCount) return settle('claimed');
      if (input.action === 'status') {
        shown.delete(row.session_id);
        if (main) shown.delete(`main:${row.turn_id}`);
        return settle('status');
      }
      if (!options.control) return settle('not_current');
      signal.throwIfAborted();
      const finish = await options.control(client, {
        threadId: row.thread_id,
        sessionId: row.session_id,
        turnId: row.turn_id,
        channel: row.channel,
      });
      await client.query(
        "UPDATE channel_streams SET state='uncertain' WHERE owner_id=$1 AND turn_id=$2 AND state<>'finalized'",
        [options.ownerId, row.turn_id],
      );
      await client.query(
        'UPDATE channel_roots SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1 AND session_id=$2',
        [options.ownerId, row.session_id],
      );
      if (main)
        await client.query(
          'UPDATE channel_main_work SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1 AND turn_id=$2',
          [options.ownerId, row.turn_id],
        );
      return settle('stop', finish);
    }).then(
      (finish) => {
        attempted.delete(id);
        return finish;
      },
      async (cause) => {
        logFailure('channel_control_failed', cause);
        await pool
          .query(
            "UPDATE channel_control_intents SET state='failed',outcome='error',settled_at=now() WHERE owner_id=$1 AND installation_id=$2 AND event_id=$3 AND state='pending'",
            key,
          )
          .then(() => attempted.delete(id))
          .catch((markCause) => logFailure('channel_control_failed', markCause));
        return undefined;
      },
    );
    if (after) void after().catch((cause) => logFailure('channel_control_failed', cause));
  }

  async function cleanup() {
    for (let batch = 0; batch < 10; batch++) {
      const claims = await pool.query(
        `DELETE FROM channel_controls c USING (
           SELECT owner_id,event_id FROM channel_controls x WHERE x.owner_id=$1 AND x.turn_id IS NOT NULL AND (
             x.connection_revision IS DISTINCT FROM $2::uuid
             OR (x.kind='nonce' AND x.expires_at<=now())
             OR NOT EXISTS(SELECT 1 FROM turns u WHERE u.id=x.turn_id AND u.owner_id=x.owner_id AND u.status='running'))
           LIMIT 500) d WHERE c.owner_id=d.owner_id AND c.event_id=d.event_id`,
        [options.ownerId, revision],
      );
      const intents = await pool.query(
        `DELETE FROM channel_control_intents i USING (
           SELECT owner_id,installation_id,event_id FROM channel_control_intents WHERE owner_id=$1 AND state<>'pending'
             AND settled_at<now()-interval '1 hour' LIMIT 500) d
         WHERE i.owner_id=d.owner_id AND i.installation_id=d.installation_id AND i.event_id=d.event_id`,
        [options.ownerId],
      );
      if ((claims.rowCount ?? 0) < 500 && (intents.rowCount ?? 0) < 500) return;
    }
  }

  function listen() {
    release?.();
    release = options.transport().controls?.((input) =>
      intake(input).catch((cause) => {
        logFailure('channel_control_failed', cause);
        throw cause;
      }),
    );
  }

  async function step(targetSessionId?: string, targetTurnId?: string) {
    if (closed || !rich() || lifetime.signal.aborted) return;
    used = true;
    const signal = lifetime.signal;
    await stepMain(targetTurnId);
    const selected = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM (
         SELECT session_id FROM turns WHERE owner_id=$1 AND session_id<>thread_id AND status IN ('queued','running','waiting') AND starts_with(channel,'slack:')
         UNION SELECT session_id FROM channel_roots WHERE owner_id=$1 AND session_id<>thread_id AND state='open' AND (last_status IS NULL OR last_status IN ('processing','suspended'))
       ) candidates WHERE ($2::uuid IS NULL OR session_id=$2) AND ($2::uuid IS NOT NULL OR $3::uuid IS NULL OR session_id>$3) ORDER BY session_id LIMIT 100`,
      [options.ownerId, targetSessionId ?? null, taskCursor],
    );
    if (!targetSessionId)
      taskCursor = selected.rows.length === 100 ? selected.rows.at(-1)!.session_id : null;
    const bound = await pool.query<{ session_id: string }>(
      `SELECT session_id FROM channel_roots WHERE owner_id=$1 AND session_id<>thread_id AND state='open'
       AND (last_status IS NULL OR last_status IN ('processing','suspended')) AND ($2::uuid IS NULL OR session_id=$2)
       AND ($2::uuid IS NOT NULL OR $3::uuid IS NULL OR session_id>$3) ORDER BY session_id LIMIT 100`,
      [options.ownerId, targetSessionId ?? null, boundCursor],
    );
    if (!targetSessionId)
      boundCursor = bound.rows.length === 100 ? bound.rows.at(-1)!.session_id : null;
    const retired = await pool.query<Root>(
      `WITH bound AS MATERIALIZED (
        SELECT * FROM channel_roots WHERE owner_id=$1 AND session_id<>thread_id AND state='open' AND (last_status IS NULL OR last_status IN ('processing','suspended'))
          AND session_id=ANY($2::uuid[]) ORDER BY session_id LIMIT 100)
      SELECT r.* FROM bound r JOIN threads th ON th.id=r.thread_id AND th.owner_id=r.owner_id AND th.archived_at IS NULL
      JOIN LATERAL (SELECT n.channel FROM turns n WHERE n.owner_id=r.owner_id AND n.session_id=r.session_id ORDER BY n.created_at DESC,n.id DESC LIMIT 1) latest ON latest.channel<>r.channel
      WHERE NOT EXISTS(SELECT 1 FROM turns live WHERE live.owner_id=r.owner_id AND live.session_id=r.session_id AND live.channel=r.channel AND live.status='running')
      `,
      [options.ownerId, bound.rows.map((row) => row.session_id)],
    );
    for (const row of retired.rows) {
      if (!targetSessionId && preparing) break;
      if (signal.aborted || !permitted(row) || !row.root_id) continue;
      await pool.query(
        'UPDATE channel_roots SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1 AND session_id=$2 AND dm=$3',
        [options.ownerId, row.session_id, row.dm],
      );
      try {
        await options.transport().conversation?.({
          ownerId: options.ownerId,
          channelId: 'slack',
          accountId: row.account_id,
          threadId: row.dm,
          sessionId: row.session_id,
          turnId: row.turn_id,
          rootMessageId: row.root_id,
          status: 'active',
          title: 'Nod',
          text: '',
          signal,
        });
        if (!signal.aborted)
          await pool.query(
            "UPDATE channel_roots SET last_status='active' WHERE owner_id=$1 AND session_id=$2 AND dm=$3 AND lifecycle_revision=$4",
            [options.ownerId, row.session_id, row.dm, row.lifecycle_revision],
          );
        shown.delete(row.session_id);
      } catch (cause) {
        if (!signal.aborted) logFailure('channel_session_failed', cause);
      }
    }
    const { rows } = await pool.query<
      Root & {
        title: string;
        text: string;
        status: string;
        task_state: string | null;
        steps: string[];
        step_index: number;
        task_id: string;
        task_turn_id: string;
        revision: number;
        applied_revision: number;
        task_revision: number | null;
        plan_steps: unknown;
        plan_revision: number;
        progress_revision: number;
        waiting_for: unknown[];
      }
    >(
      `WITH candidates AS MATERIALIZED (
         SELECT session_id FROM (
           SELECT unnest($4::uuid[]) AS session_id WHERE $2::uuid IS NULL
           UNION SELECT $2::uuid WHERE $2::uuid IS NOT NULL
         ) sessions ORDER BY session_id LIMIT 100
       ), current AS MATERIALIZED (
         SELECT u.* FROM candidates c JOIN turns u ON u.id=COALESCE(
           (SELECT live.id FROM turns live WHERE live.owner_id=$1 AND live.session_id=c.session_id AND live.status='running' ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
           (SELECT latest.id FROM turns latest WHERE latest.owner_id=$1 AND latest.session_id=c.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))
         WHERE ($3::uuid IS NULL OR u.id=$3)
       ) SELECT DISTINCT ON (u.session_id) $1::text AS owner_id,i.account_id,i.sender_id,i.thread_id AS dm,
       u.session_id,u.thread_id,u.id AS turn_id,u.channel,COALESCE(t.message_id,i.message_id) AS target_id,
       COALESCE(t.title,'Nod') AS title,COALESCE(t.now_text,'') AS text,u.status,t.state AS task_state,t.steps,t.step_index,
       t.id AS task_id,t.turn_id AS task_turn_id,t.revision,t.applied_revision,u.task_revision,
       t.plan_steps,t.plan_revision,t.progress_revision,t.waiting_for,
       NULL::text AS root_id
       FROM current u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id AND th.archived_at IS NULL
       JOIN LATERAL (
         WITH RECURSIVE lineage AS (
           SELECT u.id,u.parent_turn_id,0 AS depth WHERE u.channel_source_id IS NULL
           UNION ALL SELECT p.id,p.parent_turn_id,c.depth+1 FROM lineage c JOIN turns p ON p.id=c.parent_turn_id
             AND p.owner_id=u.owner_id AND p.thread_id=u.thread_id AND p.channel=u.channel WHERE c.depth<200)
         SELECT receipt.*,-1 AS depth FROM channel_inbox receipt WHERE receipt.source_id=u.channel_source_id
           AND receipt.owner_id=u.owner_id AND receipt.channel=u.channel AND receipt.state='submitted'
         UNION ALL
         SELECT receipt.*,c.depth FROM lineage c JOIN channel_inbox receipt ON receipt.owner_id=u.owner_id AND receipt.channel=u.channel AND receipt.state='submitted'
           AND receipt.turn_id=c.id
         ORDER BY depth LIMIT 1
       ) i ON true
       LEFT JOIN tasks t ON t.owner_id=u.owner_id AND t.session_id=u.session_id
       ${workOriginSql('u')}
       WHERE u.owner_id=$1 AND i.provider='slack' AND u.source IN ('user','task','resume') AND NOT u.proactive
         AND u.session_id<>u.thread_id AND t.id IS NOT NULL
         AND work_origin.source='user' AND work_task.activity_key IS NULL
       ORDER BY u.session_id,i.received_at DESC`,
      [
        options.ownerId,
        targetSessionId ?? null,
        targetTurnId ?? null,
        selected.rows.map((row) => row.session_id),
      ],
    );
    for (const row of rows) {
      if (!targetSessionId && preparing) break;
      try {
        if (closed || signal.aborted || !permitted(row)) continue;
        let existing = (
          await pool.query<Root>(
            'SELECT * FROM channel_roots WHERE owner_id=$1 AND account_id=$2 AND sender_id=$3 AND session_id=$4 AND dm=$5',
            [row.owner_id, row.account_id, row.sender_id, row.session_id, row.dm],
          )
        ).rows[0];
        if (existing && ['uncertain', 'preparing'].includes(existing.state)) continue;
        if (existing && (existing.thread_id !== row.thread_id || existing.dm !== row.dm)) continue;
        const status =
          row.status === 'running' || row.status === 'queued'
            ? 'processing'
            : row.status === 'waiting'
              ? 'suspended'
              : row.task_state && row.task_state !== 'open'
                ? 'closed'
                : 'active';
        if (!existing && status !== 'processing' && !targetSessionId) continue;
        if (!existing && ['failed', 'cancelled'].includes(row.status)) continue;
        const root = existing?.root_id ?? row.root_id;
        const claim = randomUUID();
        if (!existing) {
          const created = await pool.query(
            `INSERT INTO channel_roots(owner_id,account_id,sender_id,dm,session_id,thread_id,turn_id,channel,root_id,target_id,nonce,state)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'preparing') ON CONFLICT DO NOTHING RETURNING session_id`,
            [
              row.owner_id,
              row.account_id,
              row.sender_id,
              row.dm,
              row.session_id,
              row.thread_id,
              row.turn_id,
              row.channel,
              root,
              row.target_id,
              claim,
            ],
          );
          if (!created.rowCount) continue;
          try {
            const sent = root
              ? { id: root }
              : await options.transport().post({
                  channelId: 'slack',
                  accountId: row.account_id,
                  threadId: row.dm,
                  text: options.safe(row.title).text.slice(0, 200) || 'Nod',
                  signal,
                });
            await pool.query(
              "UPDATE channel_roots SET root_id=$3,state='open' WHERE owner_id=$1 AND session_id=$2 AND nonce=$4",
              [row.owner_id, row.session_id, sent.id, claim],
            );
            row.root_id = sent.id;
          } catch (cause) {
            await pool.query(
              "UPDATE channel_roots SET state='uncertain',nonce=NULL WHERE owner_id=$1 AND session_id=$2 AND dm=$3",
              [row.owner_id, row.session_id, row.dm],
            );
            throw cause;
          }
        } else row.root_id = existing.root_id;
        if (!row.root_id || signal.aborted) continue;
        const nonce =
          row.status === 'running'
            ? existing?.turn_id === row.turn_id &&
              existing.nonce &&
              existing.expires_at &&
              existing.expires_at.getTime() > Date.now()
              ? existing.nonce
              : randomUUID()
            : null;
        const binding = await pool.query<{ status_nonce: string }>(
          `UPDATE channel_roots SET turn_id=$3,nonce=$4,status_nonce=CASE WHEN nonce IS NOT DISTINCT FROM $4::uuid THEN status_nonce ELSE $6::uuid END,
         expires_at=CASE WHEN nonce IS NOT DISTINCT FROM $4::uuid THEN expires_at ELSE now()+interval '15 minutes' END,target_id=COALESCE(target_id,$5) WHERE owner_id=$1 AND session_id=$2 AND dm=$7 RETURNING status_nonce`,
          [row.owner_id, row.session_id, row.turn_id, nonce, row.target_id, randomUUID(), row.dm],
        );
        const safe = options.safe(row.text);
        const text = safe.secureAction || safe.artifact ? '' : safe.text.slice(0, 1000);
        const metadata = z
          .object({
            planRevision: z.number().int().nonnegative().max(2147483647),
            progressRevision: z.number().int().nonnegative().max(2147483647),
            steps: z
              .array(
                z
                  .object({
                    id: z.uuid(),
                    title: z
                      .string()
                      .min(1)
                      .refine((title) => title.length <= 200 && title === title.trim()),
                    state: z.enum(['pending', 'started']),
                  })
                  .strict(),
              )
              .max(50),
          })
          .safeParse({
            planRevision: row.plan_revision,
            progressRevision: row.progress_revision,
            steps: row.plan_steps,
          });
        const structured =
          metadata.success &&
          metadata.data.steps.length === row.steps?.length &&
          new Set(metadata.data.steps.map((step) => step.id)).size === metadata.data.steps.length &&
          metadata.data.steps.every((step, index) => step.title === row.steps[index]);
        const task: MessagingConversation['task'] = row.task_state
          ? {
              state: row.task_state,
              steps: (row.plan_steps === null &&
              row.plan_revision === 0 &&
              row.progress_revision === 0
                ? (row.steps ?? [])
                : []
              )
                .slice(0, 50)
                .map((step) => options.safe(step).text.slice(0, 200)),
              stepIndex: row.step_index ?? 0,
              plan: structured
                ? {
                    kind: 'structured',
                    planRevision: metadata.data.planRevision,
                    progressRevision: metadata.data.progressRevision,
                    activity:
                      row.status === 'running' &&
                      row.task_state === 'open' &&
                      row.task_turn_id === row.turn_id &&
                      row.revision === row.applied_revision &&
                      row.task_revision === row.revision &&
                      row.waiting_for.length === 0
                        ? 'current'
                        : 'historical',
                    steps: metadata.data.steps.map((step, index) => ({
                      key: `p${row.plan_revision}_s${index + 1}`,
                      ordinal: index + 1,
                      intent: step.state,
                    })),
                  }
                : { kind: 'legacy', state: 'unknown' },
            }
          : undefined;
        const activity = status === 'processing' ? await activityLine(row.turn_id) : '';
        const generation = revision;
        const signature = JSON.stringify([
          row.turn_id,
          status,
          text,
          activity,
          nonce,
          task,
          row.revision,
          row.applied_revision,
          row.task_revision,
          row.plan_revision,
          row.progress_revision,
          status === 'processing' ? Math.floor(Date.now() / (45 * 60_000)) : 0,
        ]);
        if (shown.get(row.session_id) === signature && existing?.last_status === status) continue;
        let isCurrent: (() => Promise<boolean>) | undefined;
        const view = await options.transport().conversation?.({
          ownerId: row.owner_id,
          channelId: 'slack',
          accountId: row.account_id,
          threadId: row.dm,
          sessionId: row.session_id,
          turnId: row.turn_id,
          rootMessageId: row.root_id,
          status,
          title: options.safe(row.title).text.slice(0, 200) || 'Nod',
          text,
          activity,
          control:
            nonce && binding.rows[0]?.status_nonce
              ? {
                  stop: nonce,
                  status: binding.rows[0].status_nonce,
                }
              : undefined,
          task,
          outcome: row.status === 'failed' || row.status === 'cancelled' ? row.status : undefined,
          signal,
          current: (isCurrent = async () => {
            if (closed || signal.aborted || !permitted(row) || !rich() || revision !== generation)
              return false;
            if (status === 'processing' && (await activityLine(row.turn_id)) !== activity)
              return false;
            const current = await pool.query(
              `SELECT 1 FROM channel_roots r JOIN tasks t ON t.owner_id=r.owner_id AND t.session_id=r.session_id
               JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
               JOIN threads th ON th.id=r.thread_id AND th.owner_id=r.owner_id AND th.archived_at IS NULL
               WHERE r.owner_id=$1 AND r.session_id=$2 AND r.turn_id=$3 AND r.root_id=$4 AND r.state='open'
               AND r.lifecycle_revision=$5 AND r.account_id=$6 AND r.sender_id=$7 AND r.dm=$8 AND r.thread_id=$9
               AND t.id=$10 AND t.turn_id=$11 AND t.revision=$12 AND t.applied_revision=$13
               AND t.plan_revision=$14 AND t.progress_revision=$15 AND t.state=$16 AND u.status=$17
               AND u.task_revision IS NOT DISTINCT FROM $18::integer AND t.waiting_for=$19::jsonb
               AND r.nonce IS NOT DISTINCT FROM $20::uuid AND r.status_nonce IS NOT DISTINCT FROM $21::uuid
               AND (r.nonce IS NULL OR r.expires_at>now())
               AND r.turn_id=COALESCE(
                 (SELECT live.id FROM turns live WHERE live.owner_id=r.owner_id AND live.session_id=r.session_id AND live.status='running' ORDER BY live.created_at DESC,live.id DESC LIMIT 1),
                 (SELECT latest.id FROM turns latest WHERE latest.owner_id=r.owner_id AND latest.session_id=r.session_id ORDER BY latest.created_at DESC,latest.id DESC LIMIT 1))`,
              [
                options.ownerId,
                row.session_id,
                row.turn_id,
                row.root_id,
                existing?.lifecycle_revision ?? '0',
                row.account_id,
                row.sender_id,
                row.dm,
                row.thread_id,
                row.task_id,
                row.task_turn_id,
                row.revision,
                row.applied_revision,
                row.plan_revision,
                row.progress_revision,
                row.task_state,
                row.status,
                row.task_revision,
                JSON.stringify(row.waiting_for),
                nonce,
                binding.rows[0]?.status_nonce ?? null,
              ],
            );
            return (
              Boolean(current.rowCount) &&
              (await desiredStatus({ ...row, thread_id: row.dm }, row.root_id!)) === status
            );
          }),
        });
        if (!view?.id || !(await isCurrent?.())) continue;
        if (view?.id && !signal.aborted)
          await pool.query(
            'UPDATE channel_roots SET control_message_id=$3 WHERE owner_id=$1 AND session_id=$2 AND turn_id=$4 AND dm=$5',
            [row.owner_id, row.session_id, view.id, row.turn_id, row.dm],
          );
        if (!signal.aborted) {
          const saved = await pool.query(
            `UPDATE channel_roots r SET last_status=$4 WHERE r.owner_id=$1 AND r.session_id=$2 AND r.dm=$3 AND r.lifecycle_revision=$5
             AND r.turn_id=$6 AND r.root_id=$7 AND r.state='open'
             AND EXISTS(SELECT 1 FROM tasks t JOIN turns u ON u.id=r.turn_id AND u.owner_id=r.owner_id
               WHERE t.owner_id=r.owner_id AND t.session_id=r.session_id AND t.id=$8 AND t.turn_id=$9
               AND t.revision=$10 AND t.applied_revision=$11 AND t.plan_revision=$12 AND t.progress_revision=$13
               AND t.state=$14 AND u.status=$15 AND u.task_revision IS NOT DISTINCT FROM $16::integer
               AND t.waiting_for=$17::jsonb)
             AND r.nonce IS NOT DISTINCT FROM $18::uuid AND r.status_nonce IS NOT DISTINCT FROM $19::uuid
             AND (r.nonce IS NULL OR r.expires_at>now())`,
            [
              options.ownerId,
              row.session_id,
              row.dm,
              status,
              existing?.lifecycle_revision ?? '0',
              row.turn_id,
              row.root_id,
              row.task_id,
              row.task_turn_id,
              row.revision,
              row.applied_revision,
              row.plan_revision,
              row.progress_revision,
              row.task_state,
              row.status,
              row.task_revision,
              JSON.stringify(row.waiting_for),
              nonce,
              binding.rows[0]?.status_nonce ?? null,
            ],
          );
          if (saved.rowCount) shown.set(row.session_id, signature);
        }
      } catch (cause) {
        if (!signal.aborted) logFailure('channel_session_failed', cause);
      }
    }
  }
  function refresh() {
    if (running || closed) return;
    const pass = step()
      .catch((cause) => logFailure('channel_session_failed', cause))
      .finally(() => {
        if (running === pass) running = undefined;
      });
    running = pass;
  }
  await cleanup();
  listen();
  const timer = setInterval(() => {
    refresh();
    drainControls();
  }, 2000);
  timer.unref();
  return {
    bindMain,
    resolveAnswer,
    status: desiredStatus,
    async resolveMain(
      identity: { account_id: string; sender_id: string },
      dm: string,
      root: string,
      database: Pick<Pool, 'query'> = pool,
    ) {
      const result = (
        await database.query<{ target_id: string; allowed: boolean }>(
          `SELECT c.target_id,(c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.installation_id=$6 AND th.archived_at IS NULL) AS allowed
         FROM channel_main_conversations c JOIN threads th ON th.id=c.thread_id AND th.owner_id=c.owner_id
         WHERE c.owner_id=$1 AND c.root_id=$5 ORDER BY (c.account_id=$2 AND c.sender_id=$3 AND c.dm=$4 AND c.installation_id=$6) DESC LIMIT 1`,
          [
            options.ownerId,
            identity.account_id,
            identity.sender_id,
            dm,
            root,
            installation() ?? null,
          ],
        )
      ).rows[0];
      return { known: Boolean(result), target: result?.allowed ? result.target_id : undefined };
    },
    refresh,
    async prepare(sessionId: string, turnId?: string) {
      preparing++;
      const pass = (running ?? Promise.resolve())
        .then(() => step(sessionId, turnId))
        .catch((cause) => logFailure('channel_session_failed', cause))
        .finally(() => {
          preparing--;
          if (running === pass) running = undefined;
        });
      running = pass;
      await pass;
    },
    invalidate() {
      shown.clear();
      refresh();
    },
    async root(
      identity: { account_id: string; sender_id: string; thread_id: string },
      sessionId: string,
      turnId?: string,
    ) {
      if (turnId) {
        const main = await mainRoot(turnId);
        if (
          main &&
          main.session_id === sessionId &&
          main.account_id === identity.account_id &&
          main.sender_id === identity.sender_id &&
          main.dm === identity.thread_id
        )
          return main;
      }
      return (
        await pool.query<Root>(
          `SELECT * FROM channel_roots r WHERE owner_id=$1 AND account_id=$2 AND sender_id=$3 AND session_id=$4 AND dm=$5 AND state='open'
            AND session_id<>thread_id`,
          [options.ownerId, identity.account_id, identity.sender_id, sessionId, identity.thread_id],
        )
      ).rows[0];
    },
    async resolve(
      identity: { account_id: string; sender_id: string },
      dm: string,
      root: string,
      database: Pick<Pool, 'query'> = pool,
    ) {
      const row = (
        await database.query<{ target_id: string; allowed: boolean }>(
          `SELECT r.target_id,(r.account_id=$2 AND r.sender_id=$3 AND r.dm=$4 AND r.state='open' AND th.archived_at IS NULL
            AND r.session_id<>r.thread_id AND t.state='open') AS allowed
           FROM channel_roots r JOIN threads th ON th.id=r.thread_id AND th.owner_id=r.owner_id
           LEFT JOIN tasks t ON t.session_id=r.session_id AND t.owner_id=r.owner_id
           WHERE r.owner_id=$1 AND r.session_id<>r.thread_id AND r.root_id=$5 ORDER BY (r.account_id=$2 AND r.sender_id=$3 AND r.dm=$4) DESC LIMIT 1`,
          [options.ownerId, identity.account_id, identity.sender_id, dm, root],
        )
      ).rows[0];
      return {
        known: Boolean(row),
        target: row?.allowed ? row.target_id : undefined,
      };
    },
    record(
      identity: { account_id: string; sender_id: string; thread_id: string },
      context: {
        messageId: string;
        sessionId: string;
        turnId: string;
        rootMessageId: string;
        channel: string;
      },
    ): NonNullable<Parameters<MessagingTransport['post']>[0]['stream']>['record'] {
      used = true;
      const signal = lifetime.signal;
      const generation = revision;
      return async (update) => {
        signal.throwIfAborted();
        if (
          closed ||
          revision !== generation ||
          !options.permitted({ provider: 'slack', ...identity })
        )
          throw new Error('The stream connection has changed.');
        const task = await pool.query(
          'SELECT 1 FROM turns u JOIN tasks t ON t.owner_id=u.owner_id AND t.session_id=u.session_id WHERE u.owner_id=$1 AND u.id=$2 AND u.session_id<>u.thread_id',
          [options.ownerId, context.turnId],
        );
        const main = !task.rowCount ? await mainRoot(context.turnId) : undefined;
        if (
          !task.rowCount &&
          (!main ||
            !main.current ||
            main.root_id !== context.rootMessageId ||
            main.account_id !== identity.account_id ||
            main.sender_id !== identity.sender_id ||
            main.dm !== identity.thread_id)
        )
          throw new Error('Rich Slack streams are available for task threads only.');
        if (update.state === 'starting') {
          const inserted = await pool.query(
            `INSERT INTO channel_streams(owner_id,message_id,part,account_id,sender_id,dm,session_id,turn_id,root_id,revision,state)
            SELECT $1,m.id,$3,$4,$5,$6,u.session_id,u.id,$9,$10,'starting' FROM messages m JOIN turns u ON u.id=m.turn_id AND u.owner_id=m.owner_id
            JOIN threads th ON th.id=m.thread_id AND th.owner_id=m.owner_id AND th.archived_at IS NULL
            WHERE m.owner_id=$1 AND m.id=$2 AND u.session_id=$7 AND u.id=$8 AND u.channel=$11 AND m.hidden_at IS NULL AND u.status NOT IN ('cancelled','failed')
              AND NOT EXISTS(SELECT 1 FROM approvals a WHERE a.owner_id=m.owner_id AND a.confirmation_message_id=m.id)
            ON CONFLICT DO NOTHING RETURNING part`,
            [
              options.ownerId,
              context.messageId,
              update.part,
              identity.account_id,
              identity.sender_id,
              identity.thread_id,
              context.sessionId,
              context.turnId,
              context.rootMessageId,
              generation,
              context.channel,
            ],
          );
          if (!inserted.rowCount)
            throw new Error('The stream message is unavailable or already claimed.');
        } else {
          const expected =
            update.state === 'dispatching'
              ? ['starting']
              : update.state === 'open'
                ? ['dispatching', 'appending']
                : update.state === 'appending' || update.state === 'finalizing'
                  ? ['open']
                  : update.state === 'finalized'
                    ? ['finalizing']
                    : ['starting', 'dispatching', 'open', 'appending', 'finalizing'];
          const changed = await pool.query(
            `UPDATE channel_streams SET state=$4,provider_id=COALESCE($5,provider_id),confirmed_chars=COALESCE($6,confirmed_chars)
            WHERE owner_id=$1 AND message_id=$2 AND part=$3 AND revision=$7 AND state=ANY($8::text[])
              AND ($9 OR EXISTS(SELECT 1 FROM turns u JOIN threads th ON th.id=u.thread_id AND th.owner_id=u.owner_id AND th.archived_at IS NULL
                WHERE u.id=channel_streams.turn_id AND u.owner_id=channel_streams.owner_id AND u.status NOT IN ('cancelled','failed')))
            RETURNING part`,
            [
              options.ownerId,
              context.messageId,
              update.part,
              update.state,
              update.id ?? null,
              update.confirmedChars ?? null,
              generation,
              expected,
              !['dispatching', 'appending'].includes(update.state),
            ],
          );
          if (!changed.rowCount && update.state !== 'uncertain')
            throw new Error('The stream is no longer active.');
        }
        signal.throwIfAborted();
        if (
          update.state === 'finalized' ||
          update.state === 'uncertain' ||
          (update.state === 'open' && (update.confirmedChars ?? 0) <= 3000)
        ) {
          await pool.query(
            'UPDATE channel_roots SET last_status=NULL,lifecycle_revision=lifecycle_revision+1 WHERE owner_id=$1 AND session_id=$2 AND dm=$3 AND turn_id=$4 AND root_id=$5',
            [
              options.ownerId,
              context.sessionId,
              identity.thread_id,
              context.turnId,
              context.rootMessageId,
            ],
          );
        }
      };
    },
    async pause() {
      lifetime.abort();
      release?.();
      await running;
      shown.clear();
      if (!used) return;
      await pool.query(
        'UPDATE channel_main_work SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1',
        [options.ownerId],
      );
      await pool.query('UPDATE channel_roots SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1', [
        options.ownerId,
      ]);
      await pool.query(
        "UPDATE channel_streams SET state='uncertain' WHERE owner_id=$1 AND revision=$2 AND state<>'finalized'",
        [options.ownerId, revision],
      );
    },
    resume() {
      lifetime = new AbortController();
      revision = randomUUID();
      mainCursor = null;
      taskCursor = null;
      boundCursor = null;
      listen();
      refresh();
    },
    async close() {
      closed = true;
      clearInterval(timer);
      lifetime.abort();
      release?.();
      await running;
      if (!used) return;
      await pool.query(
        'UPDATE channel_main_work SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1',
        [options.ownerId],
      );
      await pool.query('UPDATE channel_roots SET nonce=NULL,status_nonce=NULL WHERE owner_id=$1', [
        options.ownerId,
      ]);
      await pool.query(
        "UPDATE channel_streams SET state='uncertain' WHERE owner_id=$1 AND revision=$2 AND state<>'finalized'",
        [options.ownerId, revision],
      );
    },
  };
}
