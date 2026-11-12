import { type CredentialStore, UnreadableStoreError, loginKey } from "./credentials";
import type { ErrorClass } from "./failure-report";
import { type AuthDeps, type HeldToken, NOT_FINISHED, NOT_SIGNED_IN, loginToken } from "./login";
import { LoginGoneError } from "./login-errors";
import { holdSecret } from "./redact";

/**
 * What authenticates an ingest request. The ingest client asks `token()` before every request (register,
 * uploaded, each status poll) instead of baking one header in at start, so a login renewed by another
 * process, or one that expires during a long build, is picked up mid-poll.
 */
export interface Credential {
  /** A `uiverify login` rather than a project key: the MCP handoff then points at the browser-login MCP. */
  readonly signedIn: boolean;
  token(): Promise<string>;
  /** Present for a login: renew past `rejected`, a token the server just answered 401 to. */
  renew?: (rejected: string) => Promise<string>;
  /** Present for a login: the newest token this run was handed, while it has over 30 s left, for the failure
   *  report. Never reads the store and never renews: a renewal cut off by the exit could sign the person out. */
  heldToken?: () => string | null;
}

/** The report goes from a detached process with a 5 s timeout; a token that would expire in flight is left off. */
const HELD_MARGIN_MS = 30_000;

export function keyCredential(apiKey: string): Credential {
  holdSecret(apiKey);
  return { signedIn: false, token: async () => apiKey };
}

/** A run's login, pinned to the approval it resolved (`storedAt`): if another `login` replaces it mid-run,
 *  the run fails "not signed in" instead of continuing under a different, maybe unconfirmed, login. `stored` is
 *  that approval's token as `resolveCredential` read it, held until the run is handed a newer one. */
export function loginCredential(store: CredentialStore, key: string, deps: AuthDeps, pin: number, stored: HeldToken): Credential {
  let held: HeldToken | null = stored;
  // Once the run learns the login is gone (signed out, replaced by another approval, or refused for good by
  // AuthKit), its report goes without it.
  const hold = async (next: Promise<HeldToken>): Promise<string> => {
    try {
      held = await next;
    } catch (e) {
      if (e instanceof LoginGoneError) held = null;
      throw e;
    }
    return held.accessToken;
  };
  return {
    signedIn: true,
    token: () => hold(loginToken(store, key, deps, undefined, pin)),
    renew: (rejected) => {
      if (held?.accessToken === rejected) held = null;
      return hold(loginToken(store, key, deps, rejected, pin));
    },
    heldToken: () => (held !== null && deps.now() < held.expiresAt - HELD_MARGIN_MS ? held.accessToken : null),
  };
}

const DEFAULT_ORIGIN = "https://uiverify.ai";

/** A sign-in message, plus how to sign in to a server other than the default (`login` reads UIVERIFY_API_URL). */
function notSignedIn(key: string, message: string): string {
  return key === DEFAULT_ORIGIN ? message : `${message}\nTo sign in to ${key}, run: UIVERIFY_API_URL=${key} npx uiverify login`;
}

export type CredentialResolution = { ok: true; credential: Credential } | { ok: false; error: string; errorClass: ErrorClass };

/** A stored code this long past its expiry is an attempt long abandoned, not a sign-in in progress: AuthKit's codes
 *  live minutes, and an hour covers an agent that ran `login` and uploaded anyway while the person was slow. */
const ABANDONED_CODE_MS = 60 * 60_000;

/**
 * The credential an upload uses, first match wins: `UIVERIFY_API_KEY`; else the confirmed login stored for
 * this API URL. A stored login is used in CI too (a cloud agent's sandbox may set `CI`); a CI runner never
 * has one unless someone signed in on it.
 */
export function resolveCredential(env: NodeJS.ProcessEnv, apiUrl: string, store: CredentialStore, deps: AuthDeps): CredentialResolution {
  if (env.UIVERIFY_API_KEY) return { ok: true, credential: keyCredential(env.UIVERIFY_API_KEY) };
  let key: string;
  try {
    key = loginKey(apiUrl);
  } catch {
    return { ok: false, error: `the API URL is not a valid URL: ${apiUrl}`, errorClass: "invalid_args" };
  }
  let entry;
  try {
    entry = store.read().logins[key];
  } catch (e) {
    if (!(e instanceof UnreadableStoreError)) throw e;
    const error = e.kind === "corrupt" ? `${e.message} Run npx uiverify login to replace it, or set UIVERIFY_API_KEY.` : e.message;
    return { ok: false, error, errorClass: "login_unreadable" };
  }
  const active = entry?.active;
  if (!active) {
    const pending = entry?.pending;
    const inProgress = pending !== undefined && deps.now() < pending.expiresAt + ABANDONED_CODE_MS;
    return { ok: false, error: notSignedIn(key, NOT_SIGNED_IN), errorClass: inProgress ? "login_pending" : "missing_key" };
  }
  if (active.confirmedAt === null) return { ok: false, error: notSignedIn(key, NOT_FINISHED), errorClass: "login_unconfirmed" };
  return { ok: true, credential: loginCredential(store, key, deps, active.storedAt, { accessToken: active.accessToken, expiresAt: active.expiresAt }) };
}
