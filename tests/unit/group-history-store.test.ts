import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { queryConversationHistory, upsertConversationHistoryIndex } from "../../src/history/group-history-store";
import { upsertInboundMessageContext, upsertOutboundMessageContext } from "../../src/message-context-store";

describe("group-history-store", () => {
  it("filters summary slices by mention and sender", async () => {
    const root = fs.mkdtempSync("/tmp/dt-group-history-");
    const storePath = path.join(root, "store.json");

    await upsertConversationHistoryIndex({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
      chatType: "group",
      title: "研发群",
    });

    upsertInboundMessageContext({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
      msgId: "m1",
      createdAt: 1000,
      messageType: "text",
      text: "@Alice 今天上线吗",
      senderId: "u1",
      senderName: "Bob",
      mentions: ["Alice"],
      chatType: "group",
    });
    upsertOutboundMessageContext({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
      msgId: "m2",
      createdAt: 2000,
      messageType: "outbound",
      text: "今晚 8 点前发版",
      senderId: "bot",
      senderName: "OpenClaw",
      chatType: "group",
      delivery: { messageId: "m2", kind: "session" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    const mentionSlices = queryConversationHistory({
      storePath,
      accountId: "acc",
      mentionNames: ["alice"],
    });
    expect(mentionSlices).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries).toHaveLength(1);
    expect(mentionSlices[0]?.recentEntries[0]).toEqual(expect.objectContaining({
      senderId: "u1",
      body: "@Alice 今天上线吗",
    }));

    const senderSlices = queryConversationHistory({
      storePath,
      accountId: "acc",
      senderIds: ["bot"],
    });
    expect(senderSlices).toHaveLength(1);
    expect(senderSlices[0]?.recentEntries[0]).toEqual(expect.objectContaining({
      senderId: "bot",
      body: "今晚 8 点前发版",
    }));
  });
});
