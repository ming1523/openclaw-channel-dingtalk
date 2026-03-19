import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listMessageContexts,
  upsertInboundMessageContext,
  upsertOutboundMessageContext,
} from "../../src/message-context-store";

describe("message-context-store", () => {
  it("stores inbound and outbound records for one conversation", async () => {
    const root = fs.mkdtempSync("/tmp/dt-message-context-");
    const storePath = path.join(root, "store.json");

    upsertInboundMessageContext({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
      msgId: "in_1",
      createdAt: 1000,
      messageType: "text",
      text: "@Alice hello",
      senderId: "u1",
      senderName: "Bob",
      mentions: ["Alice"],
      chatType: "group",
    });
    upsertOutboundMessageContext({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
      msgId: "out_1",
      createdAt: 2000,
      messageType: "outbound",
      text: "ack",
      senderId: "bot",
      senderName: "OpenClaw",
      chatType: "group",
      delivery: { messageId: "out_1", kind: "session" },
    });

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(listMessageContexts({
      storePath,
      accountId: "acc",
      conversationId: "cid_group_1",
    })).toEqual([
      expect.objectContaining({
        msgId: "in_1",
        direction: "inbound",
        senderId: "u1",
        senderName: "Bob",
        mentions: ["alice"],
      }),
      expect.objectContaining({
        msgId: "out_1",
        direction: "outbound",
        senderId: "bot",
        senderName: "OpenClaw",
      }),
    ]);
  });
});
