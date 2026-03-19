import { randomUUID } from "node:crypto";
import {
  readNamespaceJson,
  withNamespaceFileLock,
  writeNamespaceJsonAtomic,
} from "./persistence-store";

const MESSAGE_CONTEXT_NAMESPACE = "messages.context";
const MESSAGE_CONTEXT_VERSION = 1;
export const DEFAULT_MESSAGE_CONTEXT_TTL_DAYS = 7;

type ChatType = "direct" | "group";

export interface MessageRecord {
  msgId: string;
  direction: "inbound" | "outbound";
  accountId: string;
  conversationId: string | null;
  createdAt: number;
  updatedAt: number;
  expiresAt?: number;
  messageType?: string;
  text?: string;
  senderId?: string;
  senderName?: string;
  mentions?: string[];
  chatType?: ChatType;
  quotedMessageId?: string;
  delivery?: {
    messageId?: string;
    processQueryKey?: string;
    outTrackId?: string;
    cardInstanceId?: string;
    kind?: "session" | "proactive-text" | "proactive-card" | "proactive-media";
  };
}

interface PersistedMessageContextState {
  version: number;
  updatedAt: number;
  records: Record<string, MessageRecord>;
}

interface ScopeParams {
  storePath?: string;
  accountId: string;
  conversationId: string | null;
}

interface BaseUpsertParams extends ScopeParams {
  createdAt: number;
  ttlMs?: number;
  ttlReferenceMs?: number;
  messageType?: string;
  text?: string;
  senderId?: string;
  senderName?: string;
  mentions?: string[];
  chatType?: ChatType;
  quotedMessageId?: string;
}

export interface UpsertInboundMessageContextParams extends BaseUpsertParams {
  msgId: string;
}

export interface UpsertOutboundMessageContextParams extends BaseUpsertParams {
  msgId?: string;
  delivery?: MessageRecord["delivery"];
}

function fallbackState(): PersistedMessageContextState {
  return {
    version: MESSAGE_CONTEXT_VERSION,
    updatedAt: 0,
    records: {},
  };
}

function normalizeMentions(mentions: string[] | undefined): string[] | undefined {
  if (!Array.isArray(mentions)) {
    return undefined;
  }
  const normalized = [...new Set(mentions.map((item) => item.trim().toLowerCase()).filter(Boolean))];
  return normalized.length > 0 ? normalized : undefined;
}

function sanitizeRecord(record: MessageRecord, nowMs: number): MessageRecord | null {
  if (!record.msgId || !record.accountId || !Number.isFinite(record.createdAt)) {
    return null;
  }
  if (typeof record.expiresAt === "number" && Number.isFinite(record.expiresAt) && record.expiresAt <= nowMs) {
    return null;
  }
  return {
    ...record,
    conversationId: record.conversationId?.trim() || null,
    text: typeof record.text === "string" && record.text.trim() ? record.text.trim() : undefined,
    senderId: typeof record.senderId === "string" && record.senderId.trim() ? record.senderId.trim() : undefined,
    senderName:
      typeof record.senderName === "string" && record.senderName.trim() ? record.senderName.trim() : undefined,
    mentions: normalizeMentions(record.mentions),
    quotedMessageId:
      typeof record.quotedMessageId === "string" && record.quotedMessageId.trim()
        ? record.quotedMessageId.trim()
        : undefined,
  };
}

function normalizeState(state: PersistedMessageContextState, nowMs: number): PersistedMessageContextState {
  const records = Object.fromEntries(
    Object.entries(state.records || {})
      .map(([key, value]) => [key, sanitizeRecord(value, nowMs)] as const)
      .filter((entry): entry is [string, MessageRecord] => entry[1] !== null),
  );
  return {
    version: MESSAGE_CONTEXT_VERSION,
    updatedAt: state.updatedAt || nowMs,
    records,
  };
}

function readState(params: ScopeParams): PersistedMessageContextState {
  if (!params.storePath) {
    return fallbackState();
  }
  const state = readNamespaceJson<PersistedMessageContextState>(MESSAGE_CONTEXT_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId || undefined },
    fallback: fallbackState(),
  });
  return normalizeState(state, Date.now());
}

async function withStateLock<T>(params: ScopeParams, fn: () => Promise<T> | T): Promise<T> {
  if (!params.storePath) {
    return await fn();
  }
  return withNamespaceFileLock(
    MESSAGE_CONTEXT_NAMESPACE,
    {
      storePath: params.storePath,
      scope: { accountId: params.accountId, conversationId: params.conversationId || undefined },
      format: "json",
    },
    fn,
  );
}

function writeState(params: ScopeParams, state: PersistedMessageContextState): void {
  if (!params.storePath) {
    return;
  }
  writeNamespaceJsonAtomic(MESSAGE_CONTEXT_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId, conversationId: params.conversationId || undefined },
    format: "json",
    data: normalizeState(state, Date.now()),
  });
}

async function upsertRecord(
  params: ScopeParams,
  nextRecord: MessageRecord,
): Promise<void> {
  await withStateLock(params, () => {
    const state = readState(params);
    state.records[nextRecord.msgId] = nextRecord;
    state.updatedAt = Date.now();
    writeState(params, state);
  });
}

export function upsertInboundMessageContext(params: UpsertInboundMessageContextParams): void {
  const createdAt = params.createdAt;
  const updatedAt = Date.now();
  const ttlBase = params.ttlReferenceMs ?? createdAt;
  const expiresAt =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? ttlBase + params.ttlMs
      : undefined;
  void upsertRecord(
    {
      storePath: params.storePath,
      accountId: params.accountId,
      conversationId: params.conversationId,
    },
    {
      msgId: params.msgId,
      direction: "inbound",
      accountId: params.accountId,
      conversationId: params.conversationId,
      createdAt,
      updatedAt,
      expiresAt,
      messageType: params.messageType,
      text: params.text,
      senderId: params.senderId,
      senderName: params.senderName,
      mentions: normalizeMentions(params.mentions),
      chatType: params.chatType,
      quotedMessageId: params.quotedMessageId,
    },
  ).catch(() => {});
}

export function upsertOutboundMessageContext(params: UpsertOutboundMessageContextParams): void {
  const msgId = params.msgId?.trim() || params.delivery?.messageId?.trim() || randomUUID();
  const createdAt = params.createdAt;
  const updatedAt = Date.now();
  const ttlBase = params.ttlReferenceMs ?? createdAt;
  const expiresAt =
    typeof params.ttlMs === "number" && Number.isFinite(params.ttlMs) && params.ttlMs > 0
      ? ttlBase + params.ttlMs
      : undefined;
  void upsertRecord(
    {
      storePath: params.storePath,
      accountId: params.accountId,
      conversationId: params.conversationId,
    },
    {
      msgId,
      direction: "outbound",
      accountId: params.accountId,
      conversationId: params.conversationId,
      createdAt,
      updatedAt,
      expiresAt,
      messageType: params.messageType,
      text: params.text,
      senderId: params.senderId,
      senderName: params.senderName,
      mentions: normalizeMentions(params.mentions),
      chatType: params.chatType,
      quotedMessageId: params.quotedMessageId,
      delivery: params.delivery,
    },
  ).catch(() => {});
}

export function listMessageContexts(params: ScopeParams): MessageRecord[] {
  if (!params.storePath) {
    return [];
  }
  return Object.values(readState(params).records)
    .filter((record) => record.conversationId === (params.conversationId || null))
    .toSorted((left, right) => left.createdAt - right.createdAt);
}
