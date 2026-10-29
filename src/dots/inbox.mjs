import { randomUUID } from "node:crypto";

export function createInbox(maxMessages) {
  const generation = randomUUID();
  const messages = [];
  let sequence = 0;
  const cursor = (offset) => `${generation}:${offset}`;
  return {
    get size() { return messages.length; },
    enqueue(message) {
      // A supplied receivedAt is the real acceptance time and is preserved, so
      // a message restored from durable state keeps when it was accepted
      // rather than when this process read it back.
      const received = {
        ...message,
        cursor: cursor(++sequence),
        receivedAt: typeof message.receivedAt === "string" ? message.receivedAt : new Date().toISOString(),
      };
      messages.push(received);
      if (messages.length > maxMessages) {
        messages.splice(0, messages.length - maxMessages);
      }
      return received;
    },
    read(after) {
      let offset = 0;
      let reset = false;
      if (after !== undefined) {
        if (typeof after !== "string") {
          throw new Error("after must be a cursor string");
        }
        if (/^\d+$/.test(after)) {
          // Old clients' numeric cursors have no generation. Replay the retained
          // window explicitly rather than silently dropping new-instance replies.
          if (!Number.isSafeInteger(Number(after))) {
            throw new Error("invalid cursor offset");
          }
          reset = true;
        } else {
          const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/.exec(after);
          if (!match || !Number.isSafeInteger(Number(match[2]))) {
            throw new Error("invalid inbox cursor");
          }
          reset = match[1] !== generation;
          offset = reset ? 0 : Number(match[2]);
          if (offset > sequence) {
            throw new Error("cursor is ahead of this inbox");
          }
        }
      }
      const oldest = sequence - messages.length + 1;
      return {
        generation,
        cursor: cursor(sequence),
        oldestCursor: messages.length ? cursor(oldest) : null,
        reset,
        gap: after !== undefined && !reset && offset < oldest - 1,
        messages: messages.filter((message) => Number(message.cursor.split(":")[1]) > offset),
      };
    },
  };
}
