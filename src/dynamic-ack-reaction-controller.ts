import { attachNativeAckReaction, recallNativeAckReactionWithRetry } from "./ack-reaction-service";
import type { DingTalkConfig } from "./types";

type DynamicAckReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type RuntimeAgentEvent = {
  stream?: string;
  runId?: string;
  sessionKey?: string;
  data?: {
    phase?: string;
    name?: string;
    args?: unknown;
    runId?: string;
    sessionKey?: string;
    toolCallId?: string;
    meta?: {
      runId?: string;
      sessionKey?: string;
    } | null;
  };
};

type RuntimeEventsSurface = {
  onAgentEvent?: (listener: (event: unknown) => void) => (() => void);
};

type DynamicAckReactionControllerParams = {
  enabled: boolean;
  initialReaction: string;
  initialAttached: boolean;
  initialAttachedAt: number;
  dingtalkConfig: DingTalkConfig;
  msgId: string;
  conversationId: string;
  sessionKey: string;
  log?: DynamicAckReactionLogger;
  runtimeEvents?: RuntimeEventsSurface;
};

const TOOL_REACTION_SILENCE_MS = 55_000;
const TOOL_REACTION_HEARTBEAT_INTERVAL_MS = 60_000;
const TOOL_HEARTBEAT_REACTION = "⏳";

function readToolArgString(args: unknown, keys: string[]): string | undefined {
  if (!args || typeof args !== "object") {
    return undefined;
  }
  const record = args as Record<string, unknown>;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function resolveToolProgressReaction(toolName: unknown, args: unknown): string {
  const normalizedToolName = typeof toolName === "string" ? toolName.trim().toLowerCase() : "";
  switch (normalizedToolName) {
    case "bash":
    case "exec":
    case "process": {
      const command = readToolArgString(args, ["command", "cmd"]);
      if (!command) {
        return "🛠️";
      }
      if (/\bbrew\s+install\s+/i.test(command) || /\b(?:pnpm|npm|yarn)\s+(?:add|install)\s+/i.test(command)) {
        return "📦";
      }
      if (/\bwhich\s+/i.test(command)) {
        return "🔍";
      }
      return "🛠️";
    }
    case "read":
    case "view":
      return "📂";
    case "write":
    case "edit":
    case "patch":
      return "✍️";
    case "web_search":
    case "search":
    case "browser.search":
    case "browser_search":
      return "🌐";
    case "fetch":
    case "open":
    case "open_url":
    case "browser.open":
    case "browser_open":
      return "🔗";
    default:
      return "🛠️";
  }
}

function getEventRunId(event: RuntimeAgentEvent | undefined): string | undefined {
  const topLevelRunId = typeof event?.runId === "string" && event.runId.trim() ? event.runId.trim() : "";
  if (topLevelRunId) {
    return topLevelRunId;
  }
  const dataRunId = typeof event?.data?.runId === "string" && event.data.runId.trim() ? event.data.runId.trim() : "";
  if (dataRunId) {
    return dataRunId;
  }
  const metaRunId = typeof event?.data?.meta?.runId === "string" && event.data.meta.runId.trim()
    ? event.data.meta.runId.trim()
    : "";
  return metaRunId || undefined;
}

function getEventSessionKey(event: RuntimeAgentEvent | undefined): string | undefined {
  const topLevelSessionKey =
    typeof event?.sessionKey === "string" && event.sessionKey.trim() ? event.sessionKey.trim() : "";
  if (topLevelSessionKey) {
    return topLevelSessionKey;
  }
  const dataSessionKey =
    typeof event?.data?.sessionKey === "string" && event.data.sessionKey.trim() ? event.data.sessionKey.trim() : "";
  if (dataSessionKey) {
    return dataSessionKey;
  }
  const metaSessionKey =
    typeof event?.data?.meta?.sessionKey === "string" && event.data.meta.sessionKey.trim()
      ? event.data.meta.sessionKey.trim()
      : "";
  return metaSessionKey || undefined;
}

export function createDynamicAckReactionController(params: DynamicAckReactionControllerParams) {
  let dynamicReactionStartedAt = 0;
  let lastDynamicReactionAt = 0;
  let currentAckReaction = params.initialReaction;
  let ackReactionAttached = params.initialAttached;
  let ackReactionAttachedAt = params.initialAttachedAt;
  let progressHeartbeatInFlight = false;
  let progressHeartbeatTimer: NodeJS.Timeout | undefined;
  let dynamicReactionUpdatePromise: Promise<void> = Promise.resolve();
  let activeRunId: string | undefined;
  let correlationUnavailableLogged = false;
  let disposed = false;

  const describeEvent = (event: RuntimeAgentEvent | undefined): string => {
    const stream = typeof event?.stream === "string" && event.stream.trim() ? event.stream.trim() : "-";
    const phase = typeof event?.data?.phase === "string" && event.data.phase.trim() ? event.data.phase.trim() : "-";
    const toolName = typeof event?.data?.name === "string" && event.data.name.trim() ? event.data.name.trim() : "-";
    const toolCallId =
      typeof event?.data?.toolCallId === "string" && event.data.toolCallId.trim() ? event.data.toolCallId.trim() : "-";
    return `stream=${stream} phase=${phase} runId=${getEventRunId(event) || "-"} ` +
      `sessionKey=${getEventSessionKey(event) || "-"} toolCallId=${toolCallId} toolName=${toolName}`;
  };

  const updateDynamicAckReaction = async (nextReaction: string) => {
    const normalizedReaction = typeof nextReaction === "string" ? nextReaction.trim() : "";
    if (!normalizedReaction || !params.enabled || !ackReactionAttached) {
      params.log?.info?.(
        `[DingTalk] Dynamic ack reaction update skipped reaction=${normalizedReaction || "-"} ` +
        `enabled=${params.enabled} ackReactionAttached=${ackReactionAttached}`,
      );
      return;
    }
    if (normalizedReaction === currentAckReaction) {
      params.log?.info?.(
        `[DingTalk] Dynamic ack reaction update skipped because reaction is unchanged: ${normalizedReaction}`,
      );
      if (dynamicReactionStartedAt === 0) {
        dynamicReactionStartedAt = Date.now();
      }
      lastDynamicReactionAt = Date.now();
      return;
    }

    const previousReaction = currentAckReaction;
    ackReactionAttached = false;
    await recallNativeAckReactionWithRetry(
      params.dingtalkConfig,
      {
        msgId: params.msgId,
        conversationId: params.conversationId,
        reactionName: previousReaction,
      },
      params.log,
    );

    const attached = await attachNativeAckReaction(
      params.dingtalkConfig,
      {
        msgId: params.msgId,
        conversationId: params.conversationId,
        reactionName: normalizedReaction,
      },
      params.log,
    );
    if (!attached) {
      params.log?.debug?.(
        `[DingTalk] Dynamic ack reaction attach did not succeed for reaction=${normalizedReaction}; restoring previous reaction=${previousReaction}`,
      );
      const restored = await attachNativeAckReaction(
        params.dingtalkConfig,
        {
          msgId: params.msgId,
          conversationId: params.conversationId,
          reactionName: previousReaction,
        },
        params.log,
      );
      ackReactionAttached = restored;
      if (restored) {
        currentAckReaction = previousReaction;
        ackReactionAttachedAt = Date.now();
        if (dynamicReactionStartedAt === 0) {
          dynamicReactionStartedAt = ackReactionAttachedAt;
        }
        lastDynamicReactionAt = ackReactionAttachedAt;
      }
      return;
    }

    params.log?.debug?.(`[DingTalk] Dynamic ack reaction switched to ${normalizedReaction}`);
    ackReactionAttached = true;
    currentAckReaction = normalizedReaction;
    ackReactionAttachedAt = Date.now();
    if (dynamicReactionStartedAt === 0) {
      dynamicReactionStartedAt = ackReactionAttachedAt;
    }
    lastDynamicReactionAt = ackReactionAttachedAt;
  };

  const queueDynamicAckReactionUpdate = (nextReaction: string) => {
    params.log?.info?.(
      `[DingTalk] Queue dynamic ack reaction update ${currentAckReaction || "-"} -> ${nextReaction || "-"}`,
    );
    dynamicReactionUpdatePromise = dynamicReactionUpdatePromise
      .then(() => updateDynamicAckReaction(nextReaction))
      .catch((err: any) => {
        params.log?.warn?.(`[DingTalk] Dynamic ack reaction update failed: ${err.message}`);
      });
    return dynamicReactionUpdatePromise;
  };

  const isCorrelatedEvent = (event: RuntimeAgentEvent | undefined): boolean => {
    const eventRunId = getEventRunId(event);
    const eventSessionKey = getEventSessionKey(event);
    const eventPhase =
      typeof event?.data?.phase === "string" && event.data.phase.trim() ? event.data.phase.trim() : "";
    const eventStream = typeof event?.stream === "string" && event.stream.trim() ? event.stream.trim() : "";

    if (activeRunId) {
      const matched = eventRunId === activeRunId;
      params.log?.info?.(
        `[DingTalk] Dynamic reaction correlation by runId matched=${matched} activeRunId=${activeRunId} ` +
        `eventRunId=${eventRunId || "-"} eventSessionKey=${eventSessionKey || "-"}`,
      );
      return matched;
    }
    if (eventSessionKey === params.sessionKey) {
      if (eventRunId) {
        activeRunId = eventRunId;
        params.log?.info?.(
          `[DingTalk] Dynamic reaction captured active runId=${activeRunId} from sessionKey=${params.sessionKey}`,
        );
      } else {
        params.log?.info?.(
          `[DingTalk] Dynamic reaction correlated by sessionKey=${params.sessionKey} without runId`,
        );
      }
      return true;
    }
    if (eventStream === "lifecycle" && eventPhase === "start" && eventRunId && !eventSessionKey) {
      activeRunId = eventRunId;
      params.log?.info?.(
        `[DingTalk] Dynamic reaction optimistically captured active runId=${activeRunId} ` +
        `without sessionKey for current dispatch`,
      );
      return true;
    }
    if (!correlationUnavailableLogged && params.enabled) {
      correlationUnavailableLogged = true;
      params.log?.info?.(
        "[DingTalk] Dynamic reaction tracking ignored uncorrelated agent events; waiting for sessionKey/runId match",
      );
    }
    return false;
  };

  const handleAgentEvent = async (event: unknown) => {
    const agentEvent = event as RuntimeAgentEvent | undefined;
    if (!params.enabled) {
      return;
    }
    params.log?.info?.(`[DingTalk] Dynamic reaction observed agent event ${describeEvent(agentEvent)}`);
    if (agentEvent?.stream === "lifecycle" && agentEvent.data?.phase === "start") {
      void isCorrelatedEvent(agentEvent);
      return;
    }
    if (agentEvent?.stream !== "tool" || agentEvent.data?.phase !== "start") {
      return;
    }
    if (!isCorrelatedEvent(agentEvent)) {
      params.log?.info?.(
        `[DingTalk] Dynamic reaction ignored uncorrelated tool event ${describeEvent(agentEvent)}`,
      );
      return;
    }
    const toolCallId = typeof agentEvent.data?.toolCallId === "string" ? agentEvent.data.toolCallId : "-";
    params.log?.debug?.(
      `[DingTalk] Tool event received for dynamic ack reaction: name=${agentEvent.data?.name || "-"} toolCallId=${toolCallId}`,
    );
    await queueDynamicAckReactionUpdate(
      resolveToolProgressReaction(agentEvent.data?.name, agentEvent.data?.args),
    );
  };

  const unsubscribeAgentEvents = params.enabled && params.runtimeEvents?.onAgentEvent
    ? params.runtimeEvents.onAgentEvent((event: unknown) => {
        void handleAgentEvent(event).catch((err: any) => {
          params.log?.warn?.(`[DingTalk] Dynamic ack reaction event handling failed: ${err.message}`);
        });
      })
    : () => {};

  if (params.enabled && !params.runtimeEvents?.onAgentEvent) {
    params.log?.debug?.("[DingTalk] onAgentEvent not available, dynamic reaction tracking disabled");
  }

  if (params.enabled) {
    progressHeartbeatTimer = setInterval(() => {
      if (
        progressHeartbeatInFlight
        || dynamicReactionStartedAt === 0
        || lastDynamicReactionAt === 0
      ) {
        return;
      }
      if (Date.now() - lastDynamicReactionAt < TOOL_REACTION_SILENCE_MS) {
        return;
      }
      params.log?.info?.(
        `[DingTalk] Dynamic ack reaction heartbeat triggered currentReaction=${currentAckReaction} ` +
        `lastDynamicReactionAt=${lastDynamicReactionAt}`,
      );
      progressHeartbeatInFlight = true;
      void queueDynamicAckReactionUpdate(TOOL_HEARTBEAT_REACTION).finally(() => {
        progressHeartbeatInFlight = false;
      });
    }, TOOL_REACTION_HEARTBEAT_INTERVAL_MS);
  }

  return {
    async awaitDrain(): Promise<void> {
      await dynamicReactionUpdatePromise.catch(() => undefined);
    },
    dispose(): void {
      if (disposed) {
        return;
      }
      disposed = true;
      unsubscribeAgentEvents();
      if (progressHeartbeatTimer) {
        clearInterval(progressHeartbeatTimer);
        progressHeartbeatTimer = undefined;
      }
    },
    getAckReactionAttached(): boolean {
      return ackReactionAttached;
    },
    getAckReactionAttachedAt(): number {
      return ackReactionAttachedAt;
    },
    getCurrentReaction(): string {
      return currentAckReaction;
    },
  };
}
