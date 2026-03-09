import { normalizeAllowFrom, isSenderOwner } from "./access-control";
import type { DingTalkConfig } from "./types";

export type ParsedLearningCommand =
  | { kind: "none" }
  | { kind: "whoami" }
  | { kind: "owner-status" }
  | { kind: "learn"; text: string };

export function parseLearningCommand(text: string | undefined): ParsedLearningCommand {
  const raw = String(text || "").trim();
  const normalized = raw.toLowerCase();
  if (!normalized) {
    return { kind: "none" };
  }
  if (
    normalized === "/learn whoami"
    || normalized === "/whoami"
    || normalized === "我是谁"
    || normalized === "我的信息"
  ) {
    return { kind: "whoami" };
  }
  if (
    normalized === "/learn owner status"
    || normalized === "/owner status"
    || normalized === "/owner-status"
  ) {
    return { kind: "owner-status" };
  }
  if (normalized.startsWith("/learn ")) {
    return { kind: "learn", text: raw };
  }
  return { kind: "none" };
}

export function isLearningOwner(params: {
  cfg?: { commands?: { ownerAllowFrom?: Array<string | number> } };
  config?: DingTalkConfig;
  senderId?: string;
  rawSenderId?: string;
}): boolean {
  const allow = normalizeAllowFrom(params.cfg?.commands?.ownerAllowFrom as string[] | undefined);
  return isSenderOwner({ allow, senderId: params.senderId, rawSenderId: params.rawSenderId });
}

export function formatWhoAmIReply(params: {
  senderId: string;
  rawSenderId?: string;
  senderStaffId?: string;
  isOwner?: boolean;
}): string {
  return [
    "这是你当前消息对应的身份信息：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- senderStaffId: \`${params.senderStaffId || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    "",
    "后续如果要配置 owner 或控制命令权限，就以这里返回的 senderId 为准。",
  ].join("\n");
}

export function formatOwnerStatusReply(params: {
  senderId: string;
  rawSenderId?: string;
  isOwner: boolean;
}): string {
  return [
    "当前 owner 控制状态：",
    "",
    `- senderId: \`${params.senderId || ""}\``,
    `- rawSenderId: \`${params.rawSenderId || ""}\``,
    `- isOwner: \`${params.isOwner ? "true" : "false"}\``,
    "",
    "如果需要变更 owner，请由宿主修改本机运行配置。",
  ].join("\n");
}

export function formatOwnerOnlyDeniedReply(): string {
  return "这条学习/控制命令仅允许 owner 使用。先发送“我是谁”确认你的 senderId，再由宿主将该 senderId 加入 commands.ownerAllowFrom。";
}
