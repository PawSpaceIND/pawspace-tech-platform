/**
 * Ordering for the Booking Command Center's list loads. Presentation state only: it never reads or
 * changes a booking.
 *
 * The page loads the list three ways: the first snapshot (shows "Loading…"), a ?q= search 350 ms after
 * the search box changes (silent), and a refresh on every "booking" stream event (silent). Before this:
 *   - `loading` was cleared only by the load that set it, so a search that answered in a second stayed
 *     hidden behind a first snapshot that took ~49 s on staging (master E2E run 36243387701 row 40);
 *   - whichever response arrived last won, so the late 150-row snapshot replaced the newer search
 *     result (run 36224833520 row 29: "Total bookings 150" with the searched booking still selected);
 *   - every stream event started another full snapshot, however many were already running.
 */
export type BookingLoadTicket = { readonly seq: number; readonly silent: boolean };

export type BookingLoadOutcome = {
  /** Put this response on screen: its bookings when it succeeded, its error when it failed. */
  apply: boolean;
  /** Clear `loading`: any applied success does, silent or not; an applied failure only for its own load. */
  endLoading: boolean;
  /** A stream refresh held back while loads were in flight, due now that none is: call it. */
  heldRefresh: (() => void) | null;
};

export type BookingLoadSequence = {
  /** Number a new load and count it as in flight. */
  begin(silent: boolean): BookingLoadTicket;
  /** Settle a load exactly once, successful or not. A response older than the newest applied success is dropped. */
  settle(ticket: BookingLoadTicket, succeeded: boolean): BookingLoadOutcome;
  /** A stream event: runs `refresh` now when no load is in flight, otherwise holds it (one, the latest) for settle. */
  streamRefresh(refresh: () => void): void;
};

export function createBookingLoadSequence(): BookingLoadSequence {
  let issued = 0, applied = 0, inFlight = 0, held: (() => void) | null = null;
  return {
    begin(silent) {
      issued += 1;
      inFlight += 1;
      return { seq: issued, silent };
    },
    settle(ticket, succeeded) {
      inFlight = Math.max(0, inFlight - 1);
      // A failure never hides data that is newer than it, and never blocks an older success that
      // arrives after it: only a success moves the applied mark.
      const apply = ticket.seq > applied;
      if (apply && succeeded) applied = ticket.seq;
      const heldRefresh = inFlight === 0 ? held : null;
      if (heldRefresh) held = null;
      return { apply, endLoading: apply && (succeeded || !ticket.silent), heldRefresh };
    },
    streamRefresh(refresh) {
      if (inFlight === 0) refresh();
      else held = refresh;
    },
  };
}
