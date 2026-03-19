import { randomUUID } from "node:crypto";

import {
  listMessageContexts,
  type MessageRecord,
} from "../message-context-store";
import { readNamespaceJson, withNamespaceFileLock, writeNamespaceJsonAtomic } from "../persistence-store";

const CONVERSATION_HISTORY_INDEX_NAMESPACE = "conversation.history-index";
const MAX_HISTORY_ENTRIES = 200;
const ROLLUP_CHUNK_SIZE = 20;
const MAX_SUMMARY_SEGMENTS = 90;
const MAX_SEGMENT_CHARS = 1600;
const MAX_CONVERSATIONS = 1000;
const INDEX_WRITE_INTERVAL_MS = 30_000;

interface ConversationIndexWriteCacheEntry {
  title?: string;
  updatedAt: number;
}

const conversationIndexWriteCache = new Map<string, ConversationIndexWriteCacheEntry>();

export interface GroupHistoryEntry {
  sender: string;
  senderId?: string;
  mentions?: string[];
  body: string;
  timestamp?: number;
  messageId?: string;
  quotedMessageId?: string;
}

export interface ConversationHistoryIndexEntry {
  conversationId: string;
  chatType: "direct" | "group";
  title?: string;
  updatedAt: number;
}

export interface ConversationHistoryQuery {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
  conversationIds?: string[];
  senderIds?: string[];
  mentionNames?: string[];
  sinceTs?: number;
  historyRetainLimit?: number;
  recentLimitPerConversation?: number;
}

export interface GroupHistorySummarySegment {
  id: string;
  fromTs: number;
  toTs: number;
  createdAt: number;
  messageCount: number;
  summary: string;
}

export interface ConversationHistorySlice {
  conversation: ConversationHistoryIndexEntry;
  recentEntries: GroupHistoryEntry[];
  summarySegments: GroupHistorySummarySegment[];
}

interface ConversationHistoryIndexBucket {
  updatedAt: number;
  conversations: Record<string, ConversationHistoryIndexEntry>;
}

function normalizeEntry(entry: GroupHistoryEntry): GroupHistoryEntry | null {
  const sender = entry.sender.trim();
  const body = entry.body.trim();
  if (!sender || !body) {
    return null;
  }
  return {
    sender,
    senderId: entry.senderId?.trim() || undefined,
    mentions: entry.mentions?.map((item) => item.trim().toLowerCase()).filter(Boolean),
    body,
    timestamp: entry.timestamp,
    messageId: entry.messageId?.trim() || undefined,
    quotedMessageId: entry.quotedMessageId?.trim() || undefined,
  };
}

function formatSender(record: MessageRecord): string {
  if (record.senderName && record.senderId) {
    return `${record.senderName} (${record.senderId})`;
  }
  if (record.senderName) {
    return record.senderName;
  }
  if (record.senderId) {
    return record.senderId;
  }
  return record.direction === "outbound" ? "OpenClaw (bot)" : "unknown-sender";
}

function toGroupHistoryEntry(record: MessageRecord): GroupHistoryEntry | null {
  return normalizeEntry({
    sender: formatSender(record),
    senderId: record.senderId,
    mentions: record.mentions,
    body: record.text || "",
    timestamp: record.createdAt,
    messageId: record.msgId,
    quotedMessageId: record.quotedMessageId,
  });
}

function listConversationSourceEntries(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
}): GroupHistoryEntry[] {
  return listMessageContexts(params)
    .map((record) => toGroupHistoryEntry(record))
    .filter((entry): entry is GroupHistoryEntry => entry !== null);
}

function summarizeEntries(entries: GroupHistoryEntry[]): GroupHistorySummarySegment | null {
  if (entries.length === 0) {
    return null;
  }
  const createdAt = Date.now();
  const timestamps = entries
    .map((entry) => entry.timestamp)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const fromTs = timestamps.length > 0 ? Math.min(...timestamps) : createdAt;
  const toTs = timestamps.length > 0 ? Math.max(...timestamps) : createdAt;
  const lines: string[] = [];
  let usedChars = 0;

  for (const entry of entries) {
    const ts = entry.timestamp ? new Date(entry.timestamp).toISOString() : "unknown-time";
    const quoteSuffix = entry.quotedMessageId ? ` [replying to msg:${entry.quotedMessageId}]` : "";
    const line = `[${ts}] ${entry.sender}: ${entry.body}${quoteSuffix}`;
    const next = line.length + (lines.length > 0 ? 1 : 0);
    if (usedChars + next > MAX_SEGMENT_CHARS) {
      lines.push("...");
      break;
    }
    lines.push(line);
    usedChars += next;
  }

  return {
    id: randomUUID(),
    fromTs,
    toTs,
    createdAt,
    messageCount: entries.length,
    summary: lines.join("\n"),
  };
}

function rollupEntriesToLimit(entries: GroupHistoryEntry[], retainLimit: number): GroupHistorySummarySegment[] {
  let remainingEntries = entries.slice();
  const nextSegments: GroupHistorySummarySegment[] = [];
  while (remainingEntries.length > retainLimit) {
    const chunk = remainingEntries.slice(0, ROLLUP_CHUNK_SIZE);
    remainingEntries = remainingEntries.slice(ROLLUP_CHUNK_SIZE);
    const segment = summarizeEntries(chunk);
    if (segment) {
      nextSegments.push(segment);
    }
  }
  return nextSegments.slice(-MAX_SUMMARY_SEGMENTS);
}

export function listRecentGroupHistory(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  limit: number;
}): GroupHistoryEntry[] {
  if (params.limit <= 0) {
    return [];
  }
  return listConversationSourceEntries(params).slice(-Math.min(params.limit, MAX_HISTORY_ENTRIES));
}

export function listGroupHistorySummarySegments(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  sinceTs?: number;
  retainLimit?: number;
}): GroupHistorySummarySegment[] {
  const retainLimit = Math.max(1, Math.min(params.retainLimit ?? MAX_HISTORY_ENTRIES, MAX_HISTORY_ENTRIES));
  const sourceEntries = listConversationSourceEntries(params);
  const summarySegments = rollupEntriesToLimit(sourceEntries, retainLimit);
  if (typeof params.sinceTs !== "number" || !Number.isFinite(params.sinceTs)) {
    return summarySegments;
  }
  return summarySegments.filter((segment) => segment.toTs >= params.sinceTs!);
}

export async function upsertConversationHistoryIndex(params: {
  storePath?: string;
  accountId: string;
  conversationId: string;
  chatType: "direct" | "group";
  title?: string;
}): Promise<void> {
  const storePath = params.storePath;
  if (!storePath) {
    return;
  }
  const cacheKey = `${storePath}:${params.accountId}:${params.conversationId}`;
  const nextTitle = params.title?.trim() || undefined;
  const cached = conversationIndexWriteCache.get(cacheKey);
  const now = Date.now();
  if (cached && cached.title === nextTitle && now - cached.updatedAt < INDEX_WRITE_INTERVAL_MS) {
    return;
  }

  await withNamespaceFileLock(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
    storePath,
    scope: { accountId: params.accountId },
    format: "json",
  }, () => {
    const bucket = readNamespaceJson<ConversationHistoryIndexBucket>(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
      storePath,
      scope: { accountId: params.accountId },
      format: "json",
      fallback: { updatedAt: 0, conversations: {} },
    });
    const nextConversation: ConversationHistoryIndexEntry = {
      conversationId: params.conversationId,
      chatType: params.chatType,
      title: nextTitle,
      updatedAt: now,
    };
    const trimmedConversations = Object.fromEntries(
      Object.values({ ...bucket.conversations, [params.conversationId]: nextConversation })
        .toSorted((left, right) => right.updatedAt - left.updatedAt)
        .slice(0, MAX_CONVERSATIONS)
        .map((entry) => [entry.conversationId, entry] as const),
    );
    writeNamespaceJsonAtomic(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
      storePath,
      scope: { accountId: params.accountId },
      format: "json",
      data: {
        updatedAt: now,
        conversations: trimmedConversations,
      },
    });
  });

  conversationIndexWriteCache.set(cacheKey, {
    title: nextTitle,
    updatedAt: now,
  });
}

export function listConversationHistoryIndex(params: {
  storePath?: string;
  accountId: string;
  chatType?: "direct" | "group";
}): ConversationHistoryIndexEntry[] {
  if (!params.storePath) {
    return [];
  }
  const bucket = readNamespaceJson<ConversationHistoryIndexBucket>(CONVERSATION_HISTORY_INDEX_NAMESPACE, {
    storePath: params.storePath,
    scope: { accountId: params.accountId },
    format: "json",
    fallback: { updatedAt: 0, conversations: {} },
  });
  return Object.values(bucket.conversations)
    .filter((entry) => (params.chatType ? entry.chatType === params.chatType : true))
    .toSorted((left, right) => right.updatedAt - left.updatedAt);
}

export function queryConversationHistory(params: ConversationHistoryQuery): ConversationHistorySlice[] {
  const conversationIdSet =
    params.conversationIds?.length
      ? new Set(params.conversationIds.map((id) => id.trim()).filter(Boolean))
      : undefined;
  const senderIdSet =
    params.senderIds?.length
      ? new Set(params.senderIds.map((id) => id.trim()).filter(Boolean))
      : undefined;
  const mentionNameSet =
    params.mentionNames?.length
      ? new Set(params.mentionNames.map((name) => name.trim().toLowerCase()).filter(Boolean))
      : undefined;
  const recentLimit = Math.max(1, params.recentLimitPerConversation ?? 20);
  const requirePreciseRecentFiltering =
    Boolean(senderIdSet?.size)
    || Boolean(mentionNameSet?.size)
    || typeof params.sinceTs === "number";

  return listConversationHistoryIndex({
    storePath: params.storePath,
    accountId: params.accountId,
    chatType: params.chatType,
  })
    .filter((conversation) => (conversationIdSet ? conversationIdSet.has(conversation.conversationId) : true))
    .map((conversation) => {
      const candidateEntries = listRecentGroupHistory({
        storePath: params.storePath,
        accountId: params.accountId,
        conversationId: conversation.conversationId,
        limit: requirePreciseRecentFiltering ? MAX_HISTORY_ENTRIES : recentLimit,
      });
      const recentEntries = candidateEntries.filter((entry) => {
        const matchesTime =
          typeof params.sinceTs === "number" && Number.isFinite(params.sinceTs)
            ? (entry.timestamp ?? 0) >= params.sinceTs
            : true;
        const matchesSender = senderIdSet ? Boolean(entry.senderId && senderIdSet.has(entry.senderId)) : true;
        const matchesMention = mentionNameSet
          ? Boolean(entry.mentions?.some((mention) => mentionNameSet.has(mention)))
          : true;
        return matchesTime && matchesSender && matchesMention;
      }).slice(-recentLimit);
      const summarySegments =
        senderIdSet || mentionNameSet
          ? []
          : listGroupHistorySummarySegments({
            storePath: params.storePath,
            accountId: params.accountId,
            conversationId: conversation.conversationId,
            sinceTs: params.sinceTs,
            retainLimit: params.historyRetainLimit,
          });
      return {
        conversation,
        recentEntries,
        summarySegments,
      };
    })
    .filter((slice) => slice.recentEntries.length > 0 || slice.summarySegments.length > 0);
}
