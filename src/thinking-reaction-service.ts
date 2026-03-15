import axios from "axios";
import { getAccessToken } from "./auth";
import type { DingTalkConfig } from "./types";
import { formatDingTalkErrorPayloadLog, getProxyBypassOption } from "./utils";

const THINKING_EMOTION_NAME = "🤔思考中";
const THINKING_EMOTION_ID = "2659900";
const THINKING_EMOTION_BACKGROUND_ID = "im_bg_1";
const THINKING_REACTION_RECALL_DELAYS_MS = [0, 1500, 5000] as const;

type ThinkingReactionLogger = {
  debug?: (msg: string) => void;
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
};

type ThinkingReactionTarget = {
  msgId: string;
  conversationId: string;
  robotCode?: string;
};

export async function addThinkingEmotionReply(
  config: DingTalkConfig,
  data: ThinkingReactionTarget,
  log?: ThinkingReactionLogger,
): Promise<boolean> {
  const robotCode = (data.robotCode || config.robotCode || config.clientId || "").trim();
  if (!robotCode || !data.msgId || !data.conversationId) {
    return false;
  }

  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/emotion/reply",
      {
        robotCode,
        openMsgId: data.msgId,
        openConversationId: data.conversationId,
        emotionType: 2,
        emotionName: THINKING_EMOTION_NAME,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: THINKING_EMOTION_NAME,
          text: THINKING_EMOTION_NAME,
          backgroundId: THINKING_EMOTION_BACKGROUND_ID,
        },
      },
      {
        headers: {
          "x-acs-dingtalk-access-token": token,
          "Content-Type": "application/json",
        },
        ...getProxyBypassOption(config),
      },
    );
    log?.info?.("[DingTalk] Thinking reaction attach succeeded");
    return true;
  } catch (err: any) {
    log?.warn?.(`[DingTalk] Thinking reaction attach failed: ${err.message}`);
    if (err?.response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog("inbound.thinkingReactionAttach", err.response.data));
    }
    return false;
  }
}

async function recallThinkingEmotionReply(
  config: DingTalkConfig,
  data: ThinkingReactionTarget,
  log?: ThinkingReactionLogger,
): Promise<boolean> {
  const robotCode = (data.robotCode || config.robotCode || config.clientId || "").trim();
  if (!robotCode || !data.msgId || !data.conversationId) {
    return false;
  }

  try {
    const token = await getAccessToken(config, log as any);
    await axios.post(
      "https://api.dingtalk.com/v1.0/robot/emotion/recall",
      {
        robotCode,
        openMsgId: data.msgId,
        openConversationId: data.conversationId,
        emotionType: 2,
        emotionName: THINKING_EMOTION_NAME,
        textEmotion: {
          emotionId: THINKING_EMOTION_ID,
          emotionName: THINKING_EMOTION_NAME,
          text: THINKING_EMOTION_NAME,
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
    log?.info?.("[DingTalk] Thinking reaction recall succeeded");
    return true;
  } catch (err: any) {
    log?.warn?.(`[DingTalk] Thinking reaction recall failed: ${err.message}`);
    if (err?.response?.data !== undefined) {
      log?.warn?.(formatDingTalkErrorPayloadLog("inbound.thinkingReactionRecall", err.response.data));
    }
    return false;
  }
}

export async function recallThinkingEmotionReplyWithRetry(
  config: DingTalkConfig,
  data: ThinkingReactionTarget,
  log?: ThinkingReactionLogger,
): Promise<void> {
  for (const delayMs of THINKING_REACTION_RECALL_DELAYS_MS) {
    if (delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
    if (await recallThinkingEmotionReply(config, data, log)) {
      return;
    }
  }
}
