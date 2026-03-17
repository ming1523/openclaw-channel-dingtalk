import axios from "axios";
import { getAccessToken } from "./auth";
import type { DingTalkConfig } from "./types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";

// DingTalk currently exposes a dedicated native "thinking" reaction flow rather than
// a generic arbitrary-emoji reaction API for this plugin path.
const DINGTALK_NATIVE_ACK_REACTION = "🤔思考中";
const THINKING_EMOTION_ID = "2659900";
const THINKING_EMOTION_BACKGROUND_ID = "im_bg_1";
const THINKING_REACTION_ATTACH_DELAYS_MS = [0, 400, 1200] as const;
const THINKING_REACTION_RECALL_DELAYS_MS = [0, 1500, 5000] as const;

type AckReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type AckReactionTarget = {
  msgId: string;
  conversationId: string;
  robotCode?: string;
  reactionName?: string;
};

function formatAckReactionTarget(data: AckReactionTarget): string {
  return `msgId=${data.msgId || "-"} conversationId=${data.conversationId || "-"} reactionName=${data.reactionName || DINGTALK_NATIVE_ACK_REACTION}`;
}

function resolveAckReactionPayload(config: DingTalkConfig, data: AckReactionTarget): {
  robotCode: string;
  reactionName: string;
} | null {
  const robotCode = (data.robotCode || config.robotCode || config.clientId || "").trim();
  const reactionName =
    (data.reactionName || DINGTALK_NATIVE_ACK_REACTION).trim() || DINGTALK_NATIVE_ACK_REACTION;
  if (!robotCode || !data.msgId || !data.conversationId) {
    return null;
  }
  return { robotCode, reactionName };
}

async function callEmotionApi(
  config: DingTalkConfig,
  data: AckReactionTarget,
  endpoint: "reply" | "recall",
  successLog: string,
  errorLogPrefix: string,
  errorPayloadKey: "inbound.ackReactionAttach" | "inbound.ackReactionRecall",
  log?: AckReactionLogger,
): Promise<{ ok: boolean; error?: any }> {
  const payload = resolveAckReactionPayload(config, data);
  if (!payload) {
    return { ok: false };
  }

  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      `https://api.dingtalk.com/v1.0/robot/emotion/${endpoint}`,
      {
        robotCode: payload.robotCode,
        openMsgId: data.msgId,
        openConversationId: data.conversationId,
        emotionType: 2,
        emotionName: payload.reactionName,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: payload.reactionName,
          text: payload.reactionName,
          backgroundId: THINKING_EMOTION_BACKGROUND_ID,
        },
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        timeout: 5000,
        ...getProxyBypassOption(config),
      },
    );
    log?.info?.(successLog);
    return { ok: true };
  } catch (err: any) {
    log?.warn?.(`${errorLogPrefix}: ${err.message}`);
    if (err?.response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog(errorPayloadKey, err.response.data));
    }
    return { ok: false, error: err };
  }
}

function isRetryableEmotionApiError(err: any): boolean {
  const status = Number(err?.response?.status ?? 0);
  const errorCode = String(err?.response?.data?.code || "").trim().toLowerCase();
  if (!err?.response) {
    return true;
  }
  if (status >= 500) {
    return true;
  }
  return errorCode === "system.err";
}

export async function attachNativeAckReaction(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<boolean> {
  for (let index = 0; index < THINKING_REACTION_ATTACH_DELAYS_MS.length; index += 1) {
    const delayMs = THINKING_REACTION_ATTACH_DELAYS_MS[index];
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    const attempt = index + 1;
    const attemptLabel = `${attempt}/${THINKING_REACTION_ATTACH_DELAYS_MS.length}`;
    const result = await callEmotionApi(
      config,
      data,
      "reply",
      `[DingTalk] Native ack reaction attach succeeded (${formatAckReactionTarget(data)} attempt=${attemptLabel})`,
      `[DingTalk] Native ack reaction attach failed (${formatAckReactionTarget(data)} attempt=${attemptLabel})`,
      "inbound.ackReactionAttach",
      log,
    );
    if (result.ok) {
      return true;
    }
    const shouldRetry = isRetryableEmotionApiError(result.error);
    if (!shouldRetry || attempt === THINKING_REACTION_ATTACH_DELAYS_MS.length) {
      break;
    }
    log?.debug?.(
      `[DingTalk] Retrying native ack reaction attach (${formatAckReactionTarget(data)} nextAttempt=${attempt + 1}/${THINKING_REACTION_ATTACH_DELAYS_MS.length})`,
    );
  }
  return false;
}

async function recallNativeAckReaction(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<boolean> {
  const result = await callEmotionApi(
    config,
    data,
    "recall",
    "[DingTalk] Native ack reaction recall succeeded",
    "[DingTalk] Native ack reaction recall failed",
    "inbound.ackReactionRecall",
    log,
  );
  return result.ok;
}

export async function recallNativeAckReactionWithRetry(
  config: DingTalkConfig,
  data: AckReactionTarget,
  log?: AckReactionLogger,
): Promise<void> {
  for (const delayMs of THINKING_REACTION_RECALL_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (await recallNativeAckReaction(config, data, log)) {
      return;
    }
  }
}
