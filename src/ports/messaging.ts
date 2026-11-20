import type { ChannelLinkStatus } from '../shared/contracts.ts';

export class MessagingConnectionError extends Error {}

export class MessagingDeliveryError extends MessagingConnectionError {
  constructor(
    message: string,
    readonly ids: string[],
  ) {
    super(message);
  }
}

export class MessagingAttachmentError extends Error {
  constructor(readonly maxBytes: number) {
    super('The channel file is too large.');
  }
}

export const messagingAttachmentServiceCodes = [
  'rate_limited',
  'file_not_found',
  'missing_scope',
  'file_deleted',
] as const;

export class MessagingAttachmentReadError extends Error {
  readonly httpStatus?: number;
  readonly serviceCode?: (typeof messagingAttachmentServiceCodes)[number];

  constructor(
    readonly reason:
      | 'metadata_unavailable'
      | 'download_url_rejected'
      | 'download_failed'
      | 'download_http_error'
      | 'download_timeout',
    httpStatus?: number,
    serviceCode?: string,
  ) {
    super(reason);
    if (
      typeof httpStatus === 'number' &&
      Number.isInteger(httpStatus) &&
      httpStatus >= 100 &&
      httpStatus <= 599
    )
      this.httpStatus = httpStatus;
    this.serviceCode = messagingAttachmentServiceCodes.find((code) => code === serviceCode);
  }
}

export interface MessagingChannel {
  id: string;
  status: 'disabled' | 'setup_required' | 'configured';
  missing: string[];
  accountId?: string;
  allowedSenderIds: string[];
  replyWindowMs?: number;
  supportsAttachments?: boolean;
  available?: boolean;
  error?: string;
  presenceMs?: number;
  rich?: boolean;
  richError?: string;
  installationId?: string;
}

export interface MessagingAttachment {
  name: string;
  mimeType: string;
  size: number;
  voice?: boolean;
  source?: 'sticker' | 'sticker-preview' | 'location' | 'contact';
  read(signal?: AbortSignal): Promise<Uint8Array>;
}

export interface InboundMessage {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  threadId: string;
  text: string;
  attachments?: MessagingAttachment[];
  replyToMessageId?: string;
  conversationRootMessageId?: string;
  mediaIntakeThreadId?: string;
  installationId?: string;
  sentAt: Date;
}

export interface InboundReaction {
  channelId: string;
  accountId: string;
  senderId: string;
  messageId: string;
  reaction: string | null;
  displayOnly?: boolean;
}

export interface MessagingControl {
  channelId: string;
  accountId: string;
  senderId: string;
  threadId: string;
  eventId: string;
  rootMessageId: string;
  action: 'stop' | 'status';
  nonce?: string;
  messageId?: string;
  streamIds?: string[];
  installationId?: string;
}

export interface MessagingConversation {
  ownerId: string;
  channelId: string;
  accountId: string;
  threadId: string;
  sessionId: string;
  turnId: string;
  rootMessageId: string;
  status: 'processing' | 'active' | 'suspended' | 'closed';
  title: string;
  text: string;
  activity?: string;
  control?: { stop: string; status: string };
  task?: {
    state: string;
    steps: string[];
    stepIndex: number;
    plan?:
      | { kind: 'legacy'; state: 'unknown' }
      | {
          kind: 'structured';
          planRevision: number;
          progressRevision: number;
          activity: 'current' | 'historical';
          steps: ReadonlyArray<{ key: string; ordinal: number; intent: 'pending' | 'started' }>;
        };
  };
  outcome?: 'failed' | 'cancelled';
  signal: AbortSignal;
  current?(): Promise<boolean>;
}

export interface InboundApproval {
  channelId: string;
  accountId: string;
  senderId: string;
  threadId: string;
  messageId: string;
  approved: boolean;
  acknowledge(result: 'recorded' | 'unavailable' | 'retry'): Promise<void>;
}

export interface ChannelPairingRequest {
  channelId: string;
  accountId: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;
  messageId: string;
  threadId: string;
  code: string;
  sentAt: Date;
}

interface MessagingWebhook {
  channelId: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  query: unknown;
  body: Uint8Array;
}

export interface MessagingWebhookResult {
  status: number;
  body: string | Record<string, unknown>;
  contentType?: string;
  messages?: InboundMessage[];
  reactions?: InboundReaction[];
  approvals?: InboundApproval[];
  pairing?: ChannelPairingRequest;
}

export interface MessagingTransport {
  channels: MessagingChannel[];
  controls?(accept: (control: MessagingControl) => Promise<void>): () => void;
  conversation?(input: MessagingConversation): Promise<{ id?: string }>;
  canDeliverLiteral?(input: { channelId: string; text: string; literal: string }): boolean;
  pairing?(): Promise<ChannelLinkStatus>;
  cancelPairing?(pairingId: string, restart?: boolean): Promise<boolean>;
  unlink?(): Promise<void>;
  poll?(
    accept: (message: InboundMessage) => Promise<void>,
    pair?: (request: ChannelPairingRequest) => Promise<void>,
    react?: (reaction: InboundReaction) => Promise<void>,
    approve?: (approval: InboundApproval) => Promise<void>,
  ): Promise<void>;
  receive(request: MessagingWebhook): Promise<MessagingWebhookResult>;
  post(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    text: string;
    approval?: true;
    attachments?: MessagingAttachment[];
    replyToMessageId?: string;
    replyToText?: string;
    attachmentFailure?: (names: string[]) => Promise<string | undefined>;
    rootMessageId?: string;
    deliveryId?: string;
    stream?: {
      status?(): Promise<MessagingConversation['status']>;
      record(input: {
        part: number;
        state:
          | 'starting'
          | 'dispatching'
          | 'open'
          | 'appending'
          | 'finalizing'
          | 'finalized'
          | 'uncertain';
        id?: string;
        confirmedChars?: number;
      }): Promise<void>;
    };
    signal?: AbortSignal;
  }): Promise<{ id: string; ids?: string[]; approvalButtons?: true }>;
  react?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    reaction: string | null;
    signal?: AbortSignal;
  }): Promise<'sent' | 'unsupported'>;
  presence?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    status?: string;
    signal?: AbortSignal;
  }): Promise<void>;
  progress?(input: {
    channelId: string;
    accountId: string;
    threadId: string;
    messageId: string;
    text: string;
    status: string | null;
    signal: AbortSignal;
  }): Promise<void>;
  close(): Promise<void>;
}
