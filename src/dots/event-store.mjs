import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// Durable state for event subscriptions, the replay journal and the delivery
// outbox. Registration ownership is deliberately NOT persisted: that stays
// process-specific so a crashed adapter cannot hand its bridge route to a
// replacement. Message cursors and subscriptions are persisted precisely so
// replay survives a restart.

const FILE_VERSION = 1;
const DEFAULT_MAX_JOURNAL = 500;
const DEFAULT_MAX_OUTBOX = 5000;

export class EventStateError extends Error {}

function emptyState() {
  return { version: FILE_VERSION, generation: randomUUID(), sequence: 0, subscriptions: {}, journal: [], outbox: {} };
}

function atomicWrite(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
  renameSync(temporary, path);
  // rename preserves the temp file's mode, but an existing target that was
  // created with a looser umask is tightened here as well.
  try { chmodSync(path, 0o600); } catch { /* The file was just written by this process. */ }
}

// Signing secrets must never reach a manifest, a log line, a health body or an
// MCP result. Every outward-facing view goes through this projection.
export function redactSubscription(subscription) {
  const { secret, secretKey, previousSecret, ...safe } = subscription;
  return { ...safe, secretStored: Boolean(secret || secretKey), rotatingSecret: Boolean(previousSecret) };
}

function loadState(path) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    // Only an absent file is a fresh start. A permission or I/O error must not
    // be mistaken for "no state yet" and silently replaced.
    if (error && error.code === "ENOENT") {
      return { state: emptyState(), fresh: true };
    }
    throw new EventStateError(`cannot read event state at ${path}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    // Fail closed. Overwriting here would destroy the live subscriptions and
    // the generation that issued every outstanding cursor.
    throw new EventStateError(`event state at ${path} is corrupt and was left untouched: ${error.message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new EventStateError(`event state at ${path} is not an object; left untouched`);
  }
  if (parsed.version !== FILE_VERSION) {
    throw new EventStateError(`event state at ${path} has unsupported version ${parsed.version}; left untouched`);
  }
  if (typeof parsed.generation !== "string" || !parsed.generation) {
    throw new EventStateError(`event state at ${path} has no generation; left untouched`);
  }
  return {
    state: {
      ...emptyState(),
      ...parsed,
      generation: parsed.generation,
      sequence: Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0,
      subscriptions: parsed.subscriptions && typeof parsed.subscriptions === "object" ? parsed.subscriptions : {},
      journal: Array.isArray(parsed.journal) ? parsed.journal : [],
      outbox: parsed.outbox && typeof parsed.outbox === "object" ? parsed.outbox : {},
    },
    fresh: false,
  };
}

export function createEventStore({ dir, maxJournal = DEFAULT_MAX_JOURNAL, maxOutbox = DEFAULT_MAX_OUTBOX } = {}) {
  const path = join(dir, "events.json");
  const { state, fresh } = loadState(path);
  const flush = () => atomicWrite(path, state);
  // Materialize a brand-new store immediately so a restart before the first
  // event reuses this generation rather than invalidating issued cursors. An
  // existing store is never rewritten just for being opened.
  if (fresh) {
    flush();
  }

  const cursorOf = (sequence) => `${state.generation}:${sequence}`;

  function parseCursor(cursor) {
    if (cursor === undefined || cursor === null) {
      return { sequence: null, foreign: false };
    }
    if (typeof cursor !== "string") {
      throw new Error("cursor must be a string");
    }
    const match = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):(\d+)$/.exec(cursor);
    if (!match || !Number.isSafeInteger(Number(match[2]))) {
      throw new Error("invalid event cursor");
    }
    return { sequence: Number(match[2]), foreign: match[1] !== state.generation };
  }

  function evictTerminalDeliveries() {
    const keys = Object.keys(state.outbox);
    if (keys.length <= maxOutbox) {
      return;
    }
    // Only settled entries are evictable. A queued delivery is never dropped
    // to make room, because dropping it would lose the event silently.
    const terminal = keys.filter((key) => state.outbox[key].state !== "queued");
    for (const key of terminal.slice(0, keys.length - maxOutbox)) {
      delete state.outbox[key];
    }
  }

  return {
    get path() { return path; },
    get generation() { return state.generation; },
    get sequence() { return state.sequence; },
    cursor: cursorOf,
    parseCursor,

    listSubscriptions() {
      return Object.values(state.subscriptions);
    },
    getSubscription(id) {
      return state.subscriptions[id];
    },
    putSubscription(subscription) {
      state.subscriptions[subscription.id] = subscription;
      flush();
      return subscription;
    },
    deleteSubscription(id) {
      if (!state.subscriptions[id]) {
        return false;
      }
      delete state.subscriptions[id];
      for (const key of Object.keys(state.outbox)) {
        if (state.outbox[key].subscriptionId === id) {
          delete state.outbox[key];
        }
      }
      flush();
      return true;
    },

    // Appends to the replay journal and returns the stable identifiers. The
    // caller persists before acknowledging the inbound message so a crash
    // after the acknowledgement cannot lose the event.
    appendEvent(event) {
      return this.appendEventWithDeliveries(event, []);
    },

    // One flush covers the journal append and the outbox rows together. Two
    // separate writes could leave a journaled event with no delivery queued if
    // the process died between them.
    appendEventWithDeliveries(event, subscriptionIds) {
      const sequence = state.sequence + 1;
      const record = { ...event, sequence, cursor: cursorOf(sequence) };
      const journal = [...state.journal, record];
      if (journal.length > maxJournal) {
        journal.splice(0, journal.length - maxJournal);
      }
      const outbox = { ...state.outbox };
      for (const subscriptionId of subscriptionIds) {
        const key = `${subscriptionId}:${record.eventId}`;
        if (outbox[key]) {
          continue;
        }
        outbox[key] = {
          key, subscriptionId, eventId: record.eventId, cursor: record.cursor,
          event: { eventId: record.eventId, name: record.name, timestamp: record.timestamp, data: record.data, cursor: record.cursor },
          state: "queued", attempts: 0, nextAttemptAt: 0,
          lastStatus: null, lastError: null, terminalReason: null,
          deliveryAcknowledgedAt: null,
        };
      }
      const next = { ...state, sequence, journal, outbox };
      // Write first; only adopt the new state once it is durable, so a failed
      // flush leaves the store exactly as it was and the caller can refuse to
      // acknowledge the message.
      atomicWrite(path, next);
      state.sequence = sequence;
      state.journal = journal;
      state.outbox = outbox;
      evictTerminalDeliveries();
      return record;
    },

    // truncated is true when the caller asked to resume from a point this
    // journal no longer retains, or from a different generation.
    eventsAfter(cursor) {
      const { sequence, foreign } = parseCursor(cursor);
      if (sequence === null) {
        return { events: [], truncated: false };
      }
      if (foreign) {
        return { events: [], truncated: true };
      }
      // A cursor beyond what this store ever issued is not thin history, it is
      // an invalid cursor, and reporting it as "nothing new" would hide that.
      if (sequence > state.sequence) {
        throw new Error("cursor is ahead of this event store");
      }
      const oldest = state.journal.length ? state.journal[0].sequence : state.sequence + 1;
      const truncated = sequence + 1 < oldest;
      return { events: state.journal.filter((entry) => entry.sequence > sequence), truncated };
    },

    // The full envelope is stored with the delivery, so a pending retry never
    // depends on the bounded journal still retaining its event.
    enqueueDelivery(subscriptionId, event) {
      const key = `${subscriptionId}:${event.eventId}`;
      if (state.outbox[key]) {
        return state.outbox[key];
      }
      state.outbox[key] = {
        key, subscriptionId, eventId: event.eventId, cursor: event.cursor,
        event: { eventId: event.eventId, name: event.name, timestamp: event.timestamp, data: event.data, cursor: event.cursor },
        state: "queued", attempts: 0, nextAttemptAt: 0,
        lastStatus: null, lastError: null, terminalReason: null,
        // HTTP receipt only. This is never a claim that the recipient
        // processed, read, or completed anything.
        deliveryAcknowledgedAt: null,
      };
      evictTerminalDeliveries();
      flush();
      return state.outbox[key];
    },
    listDeliveries() {
      return Object.values(state.outbox);
    },
    getDelivery(key) {
      return state.outbox[key];
    },
    updateDelivery(key, patch) {
      if (!state.outbox[key]) {
        return undefined;
      }
      state.outbox[key] = { ...state.outbox[key], ...patch };
      flush();
      return state.outbox[key];
    },
    journalEvent(eventId) {
      return state.journal.find((entry) => entry.eventId === eventId);
    },

    // The authoritative durable read of accepted messages. Deliberately not
    // expressed through eventsAfter: that method implements the replay
    // contract, where a null cursor means "start from now" and correctly
    // returns nothing. Restart restore needs the retained window instead.
    allAccepted() {
      return {
        generation: state.generation,
        cursor: cursorOf(state.sequence),
        oldestCursor: state.journal.length ? cursorOf(state.journal[0].sequence) : null,
        // True when the journal no longer holds every message ever accepted.
        truncated: state.journal.length < state.sequence,
        records: [...state.journal],
      };
    },

    // Counts only. /health is unauthenticated, so it must not disclose
    // callback destinations or subscription ids, which are themselves a
    // delivery header value.
    publicSnapshot() {
      const counts = { queued: 0, delivered: 0, failed: 0 };
      for (const delivery of Object.values(state.outbox)) {
        if (counts[delivery.state] !== undefined) {
          counts[delivery.state] += 1;
        }
      }
      return {
        generation: state.generation,
        journal: state.journal.length,
        subscriptions: Object.keys(state.subscriptions).length,
        deliveries: counts,
      };
    },

    snapshot() {
      const deliveries = Object.values(state.outbox);
      const counts = { queued: 0, delivered: 0, failed: 0 };
      for (const delivery of deliveries) {
        if (counts[delivery.state] !== undefined) {
          counts[delivery.state] += 1;
        }
      }
      return {
        generation: state.generation,
        cursor: cursorOf(state.sequence),
        oldestCursor: state.journal.length ? cursorOf(state.journal[0].sequence) : null,
        journal: state.journal.length,
        subscriptions: Object.values(state.subscriptions).map(redactSubscription),
        deliveries: counts,
      };
    },
  };
}
