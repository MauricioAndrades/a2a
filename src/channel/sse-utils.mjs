/**
 * SSE helpers: one event frame may contain multiple `data:` lines (one per source line).
 */

export function sseFrameFromText(text) {
    return text.split("\n").map((l) => `data: ${l}\n`).join("") + "\n";
}

/**
 * Fan-out to all listeners. One dead client must not take down the rest of the mirror.
 * Removes listeners whose callback throws (typically EPIPE / write after end).
 *
 * @param {Set<(chunk: string) => void>} listeners
 * @param {string} chunk
 */
export function broadcastSseChunk(listeners, chunk) {
    for (const emit of [...listeners]) {
        try {
            emit(chunk);
        } catch {
            listeners.delete(emit);
        }
    }
}
