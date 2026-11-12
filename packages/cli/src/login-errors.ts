/** The stored login is missing, or AuthKit says it can never be renewed again. `afterRejection`: UI Verify had
 *  just answered 401 to it, so the renewal was forced by our server, not by the token's age. */
export class LoginGoneError extends Error {
  constructor(
    message: string,
    readonly afterRejection = false,
  ) {
    super(message);
  }
}

/** How a login that never signed in ended; `expired_unwatched` is a code that died while no run was polling it,
 *  found by a later run, and `start_failed` is a start that never got a code. */
export type LoginEnding =
  | "start_failed"
  | "denied"
  | "expired"
  | "expired_unwatched"
  | "code_used"
  | "account_not_ready"
  | "rejected"
  | "refresh_refused";
