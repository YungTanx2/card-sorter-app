/**
 * Thrown when recognition can't reach a decision — a genuine failure, distinct from a
 * low-confidence match. Per plan Decision #12: never guess-route on this, stall the session
 * instead. The physical card is still sitting on the machine holding for a tone that we're
 * intentionally not sending, so nothing is lost — server.ts turns this into a 503 and the
 * frontend shows a retry banner instead of arming for the next card.
 *
 * Lives in its own module (rather than session.ts, where it started) so both scan pipelines —
 * the price-sorter's and Set Builder's — throw the same type and server.ts needs one catch.
 */
export class StallError extends Error {}
