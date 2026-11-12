import fs from "node:fs";
import { z } from "zod";
import {
  type ActiveLogin,
  type CredentialStore,
  type Credentials,
  type LoginEntry,
  type PendingLogin,
  UnreadableStoreError,
  loginKey,
  withEntry,
} from "./credentials";
import { isFetchFailure } from "./failure-report";
import { type LoginEnding, LoginGoneError } from "./login-errors";
import { holdSecret } from "./redact";
import { HttpStatusError, withRetry } from "./retry";

/**
 * `uiverify login` / `logout` / `whoami`, and renewing a stored login.
 *
 * A login is the AuthKit OAuth device flow (RFC 8628) against UI Verify's first-party public CLI app: the
 * control plane only says which client id and endpoints to use (`GET /api/cli/login`); the CLI then talks to
 * AuthKit directly, and confirms the account with `POST /api/cli/session` once the tokens arrive.
 *
 * Approved tokens are stored at once as an unconfirmed login, so a run cut off by an agent's timeout (or a
 * late sign-up webhook) never costs a second approval: the rerun confirms what is stored. Uploads use only a
 * confirmed login. Every write here is a compare-and-set under the store lock, so a second `login` process
 * never undoes another's work.
 */

export interface AuthDeps {
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface LoginDeps extends AuthDeps {
  apiUrl: string;
  store: CredentialStore;
  /** A person is watching the output as it comes (stdout is a terminal). */
  isTTY: boolean;
  /** A browser can plausibly be opened here (`shouldOpenBrowser`). */
  canOpenBrowser: boolean;
  /** Resolves whether an opener actually started (a missing `xdg-open` counts as no browser). */
  openBrowser: (url: string) => Promise<boolean>;
  log: (msg: string) => void;
  /** Which CLI is signing in, sent on the login config and confirmation requests; empty with
   *  `UIVERIFY_TELEMETRY=0`. */
  clientHeaders: Record<string, string>;
  /** Report how a login ended without signing in, at most once per code: a code's ending only by the run whose own
   *  store write ended it, after that write landed; `start_failed` (no code yet) by the run whose start failed. */
  reportEnded: (ending: LoginEnding) => void;
}

export const LOGIN_COMMAND = "npx uiverify login";
export const NOT_SIGNED_IN = `Not signed in. Run ${LOGIN_COMMAND}, or set UIVERIFY_API_KEY.`;
export const NOT_FINISHED = `Your UI Verify sign-in isn't finished yet. Run ${LOGIN_COMMAND} to finish.`;


const RENEW_MARGIN_MS = 60_000;
const REFRESH_TIMEOUT_MS = 10_000;
const OAUTH_TIMEOUT_MS = 30_000;
const SLOW_DOWN_STEP_S = 5;
const DEFAULT_INTERVAL_S = 5;
/** Without a terminal, a run returns after this long so an agent whose shell shows output only at exit
 *  sees it under the shortest common tool timeout (Claude Code's default is 120 s). */
const NO_TTY_WAIT_MS = 60_000;
/** How long a run whose code was already redeemed waits for the winner's write before calling the code dead. */
const LOSER_GRACE_MS = 2_000;
const CONFIRM_DELAYS_MS = [2_000, 4_000, 8_000, 16_000, 30_000];
/** A 403 from the session route this long after approval is an account that won't appear, not a late
 *  webhook (normally seconds). */
const CONFIRM_GIVE_UP_MS = 10 * 60_000;

const loginConfigSchema = z.object({
  clientId: z.string(),
  deviceAuthorizationEndpoint: z.string(),
  tokenEndpoint: z.string(),
  scopes: z.array(z.string()),
});

const deviceAuthorizationSchema = z.object({
  device_code: z.string(),
  user_code: z.string(),
  verification_uri: z.string(),
  verification_uri_complete: z.string().optional(),
  expires_in: z.number(),
  interval: z.number().optional(),
});

const tokenSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
});

const oauthErrorSchema = z.object({ error: z.string() });

const sessionSchema = z.object({
  user: z.object({ email: z.string(), name: z.string().nullable() }),
  teams: z.array(z.object({ slug: z.string(), name: z.string() })),
});
type CliSession = z.infer<typeof sessionSchema>;

interface Tokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

function apiBase(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The control plane's `{ error }` message when it sent one, else a status line. */
function serverError(label: string, status: number, body: unknown): HttpStatusError {
  const parsed = oauthErrorSchema.safeParse(body);
  return parsed.success
    ? new HttpStatusError(status, parsed.data.error, label, parsed.data.error)
    : new HttpStatusError(status, `${label} -> ${status}`, label, null);
}

async function postForm(deps: AuthDeps, url: string, form: Record<string, string>, timeoutMs: number) {
  const res = await deps.fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return { status: res.status, ok: res.ok, body: await readJson(res) };
}

function toTokens(raw: z.infer<typeof tokenSchema>, previousRefresh: string | undefined, now: number): Tokens {
  const refreshToken = raw.refresh_token ?? previousRefresh;
  if (!refreshToken) throw new Error("AuthKit returned no refresh token");
  holdSecret(raw.access_token);
  holdSecret(refreshToken);
  return { accessToken: raw.access_token, refreshToken, expiresAt: now + raw.expires_in * 1000 };
}

function entryOf(file: Credentials, key: string): LoginEntry {
  return file.logins[key] ?? {};
}

// ---------------------------------------------------------------------------------------------------------
// Renewal

/** One refresh-token grant. Bounded and never retried, so it can't outlive the lock it runs under. The
 *  refresh token rotates: the result carries the new one. */
async function refreshTokens(login: ActiveLogin, deps: AuthDeps): Promise<Tokens | "invalid_grant"> {
  const res = await postForm(
    deps,
    login.tokenEndpoint,
    { grant_type: "refresh_token", refresh_token: login.refreshToken, client_id: login.clientId },
    REFRESH_TIMEOUT_MS,
  );
  if (res.ok) return toTokens(tokenSchema.parse(res.body), login.refreshToken, deps.now());
  const err = oauthErrorSchema.safeParse(res.body);
  if (err.success && err.data.error === "invalid_grant") return "invalid_grant";
  throw new Error(`token endpoint -> ${res.status}${err.success ? ` (${err.data.error})` : ""}`);
}

/**
 * An access token for the login stored under `key`: the stored one while it has over a minute left, else a
 * renewed one. `rejected` is a token the server just answered 401 to (a clock running behind), which forces a
 * renewal unless another process already replaced it. `pin` is the approval (`storedAt`) a run resolved: a
 * different one stored since (another `login`, maybe another account) ends this run's login instead of being
 * picked up mid-build.
 *
 * Renewal runs under the store's lock and re-reads the store first, so parallel uploads renew once: the
 * others find the rotated tokens and use them. A login deleted meanwhile (a concurrent `logout`) is not
 * written back.
 */
export async function loginAccessToken(
  store: CredentialStore,
  key: string,
  deps: AuthDeps,
  rejected?: string,
  pin?: number,
): Promise<string> {
  return (await loginToken(store, key, deps, rejected, pin)).accessToken;
}

/** An access token and when it expires. */
export type HeldToken = Pick<Tokens, "accessToken" | "expiresAt">;

/** {@link loginAccessToken}, with the token's expiry. */
export async function loginToken(
  store: CredentialStore,
  key: string,
  deps: AuthDeps,
  rejected?: string,
  pin?: number,
): Promise<HeldToken> {
  const current = entryOf(store.read(), key).active;
  if (!current || (pin !== undefined && current.storedAt !== pin)) throw new LoginGoneError(NOT_SIGNED_IN);
  if (rejected === undefined && deps.now() < current.expiresAt - RENEW_MARGIN_MS) return held(current);

  return store.withLock(async () => {
    const login = entryOf(store.read(), key).active;
    if (!login || (pin !== undefined && login.storedAt !== pin)) throw new LoginGoneError(NOT_SIGNED_IN);
    const usable = rejected === undefined ? deps.now() < login.expiresAt - RENEW_MARGIN_MS : login.accessToken !== rejected;
    if (usable) return held(login);

    let renewed: Tokens | "invalid_grant" | { failed: unknown };
    try {
      renewed = await refreshTokens(login, deps);
    } catch (e) {
      renewed = { failed: e };
    }
    // A lock is stolen after 30s, so a holder suspended mid-refresh may find another process renewed meanwhile.
    // AuthKit rotates refresh tokens, so at most one of the two refreshes succeeded: stored tokens other than
    // the ones this process spent are that live login, whatever this refresh returned or threw.
    const latest = store.read();
    const entry = entryOf(latest, key);
    if (entry.active && entry.active.refreshToken !== login.refreshToken) {
      // The same approval renewed by the process that stole the lock is adopted; a new approval is not ours.
      if (entry.active.storedAt === login.storedAt) return held(entry.active);
      throw new LoginGoneError(NOT_SIGNED_IN);
    }
    // The dead login is left for the next `login` to replace: deleting it here could undo the renewal of a
    // process this one stole the lock from, which may still be about to store working tokens.
    if (renewed === "invalid_grant") throw new LoginGoneError(NOT_SIGNED_IN);
    if ("failed" in renewed) {
      if (rejected === undefined && deps.now() < login.expiresAt) return held(login);
      throw new Error(`could not renew your UI Verify login (${errorMessage(renewed.failed)}); if this keeps happening, run ${LOGIN_COMMAND}`);
    }
    if (!entry.active || entry.active.storedAt !== login.storedAt) throw new LoginGoneError(NOT_SIGNED_IN);
    try {
      store.write(withEntry(latest, key, { ...entry, active: { ...entry.active, ...renewed } }));
    } catch (e) {
      // The spent refresh token can't be recovered; this run can still finish with the new access token.
      console.error(`[uiverify] ⚠ could not save your renewed UI Verify login (${errorMessage(e)}); run ${LOGIN_COMMAND} after this run.`);
    }
    return held(renewed);
  });
}

function held(t: HeldToken): HeldToken {
  return { accessToken: t.accessToken, expiresAt: t.expiresAt };
}

// ---------------------------------------------------------------------------------------------------------
// The control plane's session route

type SessionResult = { kind: "ok"; session: CliSession } | { kind: "unauthorized" } | { kind: "forbidden"; message: string };

/** A transport failure names the server it couldn't reach; the server's own refusals pass through. */
async function reaching<T>(apiUrl: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (e) {
    if (e instanceof HttpStatusError || e instanceof z.ZodError || e instanceof LoginGoneError) throw e;
    throw new Error(`could not reach UI Verify at ${apiBase(apiUrl)} (${errorMessage(e)})`);
  }
}

async function sessionRequest(
  deps: AuthDeps,
  apiUrl: string,
  method: "GET" | "POST",
  accessToken: string,
  headers: Record<string, string>,
): Promise<SessionResult> {
  return reaching(apiUrl, () =>
    withRetry({ label: "session" }, async (signal) => {
      const res = await deps.fetch(`${apiBase(apiUrl)}/api/cli/session`, {
        method,
        headers: { ...headers, authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal,
      });
      if (res.status === 401) return { kind: "unauthorized" } as const;
      const body = await readJson(res);
      if (res.status === 403) {
        const err = oauthErrorSchema.safeParse(body);
        return { kind: "forbidden", message: err.success ? err.data.error : "UI Verify refused this login." } as const;
      }
      if (!res.ok) throw serverError(`${method} /api/cli/session`, res.status, body);
      return { kind: "ok", session: sessionSchema.parse(body) } as const;
    }),
  );
}

/** The session for the login stored under `key`, renewing it as needed and once more on a 401. `pin`: only
 *  the approval this run is confirming, never one another `login` stored meanwhile. A login that dies in the
 *  renewal a 401 forced is a `LoginGoneError` marked `afterRejection`. */
async function storedSession(
  deps: AuthDeps,
  store: CredentialStore,
  apiUrl: string,
  method: "GET" | "POST",
  opts: { pin?: number; headers?: Record<string, string> } = {},
): Promise<SessionResult> {
  const key = loginKey(apiUrl);
  const headers = opts.headers ?? {};
  const token = await loginAccessToken(store, key, deps, undefined, opts.pin);
  const first = await sessionRequest(deps, apiUrl, method, token, headers);
  if (first.kind !== "unauthorized") return first;
  let renewed: string;
  try {
    renewed = await loginAccessToken(store, key, deps, token, opts.pin);
  } catch (e) {
    if (e instanceof LoginGoneError) throw new LoginGoneError(e.message, true);
    throw e;
  }
  return sessionRequest(deps, apiUrl, method, renewed, headers);
}

function signedInLines(s: CliSession): string[] {
  const name = s.user.name ? ` (${s.user.name})` : "";
  const lines = [`Signed in as ${s.user.email}${name}.`];
  if (s.teams.length > 0) lines.push(`Teams: ${s.teams.map((t) => t.slug).join(", ")}.`);
  else lines.push("You're not in a UI Verify team yet: your first `uiverify upload` creates your team and the project for its repository.");
  if (process.env.UIVERIFY_API_KEY) lines.push("UIVERIFY_API_KEY is set in this shell, so uploads from it use the key, not this login.");
  return lines;
}

// ---------------------------------------------------------------------------------------------------------
// The device flow

async function fetchLoginConfig(deps: AuthDeps, apiUrl: string, headers: Record<string, string>) {
  return reaching(apiUrl, () =>
    withRetry({ label: "login config" }, async (signal) => {
      const res = await deps.fetch(`${apiBase(apiUrl)}/api/cli/login`, { headers: { ...headers, accept: "application/json" }, signal });
      const body = await readJson(res);
      if (res.status === 404) {
        throw new HttpStatusError(404, `${apiBase(apiUrl)} doesn't support \`uiverify login\`; set UIVERIFY_API_KEY instead.`, "login config", null);
      }
      if (!res.ok) throw serverError("GET /api/cli/login", res.status, body);
      return loginConfigSchema.parse(body);
    }),
  );
}

/** A new code. Once the config arrived, UI Verify has counted a start, so any failure past it is reported. */
async function startDeviceLogin(deps: LoginDeps): Promise<PendingLogin> {
  const config = await fetchLoginConfig(deps, deps.apiUrl, deps.clientHeaders);
  try {
    return await requestDeviceCode(deps, config);
  } catch (e) {
    deps.reportEnded("start_failed");
    throw e;
  }
}

async function requestDeviceCode(deps: LoginDeps, config: z.infer<typeof loginConfigSchema>): Promise<PendingLogin> {
  const res = await postForm(deps, config.deviceAuthorizationEndpoint, { client_id: config.clientId, scope: config.scopes.join(" ") }, OAUTH_TIMEOUT_MS);
  if (!res.ok) {
    const err = oauthErrorSchema.safeParse(res.body);
    throw new Error(`could not start a login: device authorization -> ${res.status}${err.success ? ` (${err.data.error})` : ""}`);
  }
  const auth = deviceAuthorizationSchema.parse(res.body);
  holdSecret(auth.device_code);
  return {
    clientId: config.clientId,
    tokenEndpoint: config.tokenEndpoint,
    deviceCode: auth.device_code,
    userCode: auth.user_code,
    verificationUri: auth.verification_uri_complete ?? auth.verification_uri,
    expiresAt: deps.now() + auth.expires_in * 1000,
    interval: auth.interval ?? DEFAULT_INTERVAL_S,
  };
}

class TransientPollError extends Error {}

/** A poll failure worth polling again after: the network (undici's "fetch failed", or "terminated" for a
 *  connection dropped mid-response), a timeout, or AuthKit's 5xx or 429. */
function transient(e: unknown): boolean {
  // "terminated": undici's error for a connection dropped while the response body was being read.
  const network = isFetchFailure(e) || (e instanceof TypeError && e.message === "terminated");
  return e instanceof TransientPollError || network || (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"));
}

type PollResult = { kind: "tokens"; tokens: Tokens } | { kind: "pending"; slowDown: boolean } | { kind: "denied" | "expired" | "used" };

async function pollDeviceToken(deps: AuthDeps, pending: PendingLogin): Promise<PollResult> {
  const res = await postForm(
    deps,
    pending.tokenEndpoint,
    { grant_type: "urn:ietf:params:oauth:grant-type:device_code", device_code: pending.deviceCode, client_id: pending.clientId },
    OAUTH_TIMEOUT_MS,
  );
  if (res.ok) return { kind: "tokens", tokens: toTokens(tokenSchema.parse(res.body), undefined, deps.now()) };
  if (res.status >= 500 || res.status === 429) throw new TransientPollError(`token endpoint -> ${res.status}`);
  const err = oauthErrorSchema.safeParse(res.body);
  const code = err.success ? err.data.error : undefined;
  if (code === "authorization_pending") return { kind: "pending", slowDown: false };
  if (code === "slow_down") return { kind: "pending", slowDown: true };
  if (code === "access_denied") return { kind: "denied" };
  if (code === "expired_token") return { kind: "expired" };
  if (code === "invalid_grant") return { kind: "used" };
  throw new Error(`login failed: token endpoint -> ${res.status}${code ? ` (${code})` : ""}`);
}

const FAILED_POLL: Record<"denied" | "expired" | "used", string> = {
  denied: `The login was denied in the browser. Run ${LOGIN_COMMAND} to try again.`,
  expired: `The login code expired before it was approved. Run ${LOGIN_COMMAND} again.`,
  used: `This login code is no longer valid (already used, or expired). Run ${LOGIN_COMMAND} again.`,
};

export type LoginOutcome = "signed-in" | "waiting";

/** The `login` state machine; see the design in the module comment. Returns `waiting` when the caller
 *  should exit 1 (a message saying what to do next was already printed). */
export async function runLogin(deps: LoginDeps): Promise<LoginOutcome> {
  const key = loginKey(deps.apiUrl);
  const { store, log } = deps;
  const deadline = deps.isTTY ? Number.POSITIVE_INFINITY : deps.now() + NO_TTY_WAIT_MS;
  log(`Signing in to UI Verify at ${key}`);

  let toldPlain = false;
  // A store sealed by another system's key store (a config dir synced between a Mac and a Linux desktop) is
  // replaced by a plain one: sealing it here again would sign the other machine out on every switch.
  let seal = true;
  /** Run `change` on this origin's entry under the lock, as a `login` write: sealed when it starts a store,
   *  unless `seal` says otherwise. A change that returns null leaves the store as it is; the result says whether
   *  this call wrote. */
  async function update(change: (entry: LoginEntry) => LoginEntry | null): Promise<boolean> {
    const written = await store.withLock(async () => {
      const file = store.read();
      const next = change(entryOf(file, key));
      return next === null ? null : store.write(withEntry(file, key, next), { seal });
    });
    if (written === null) return false;
    // Where the OS keeps a key, the login is meant to be sealed: say so when it couldn't be, rather than
    // downgrade silently. No generic "sign in from your terminal to reseal": that reseals the store and locks
    // this shell out again; only a key store that knows a reseal helps (a tool to install) gives the steps.
    if (written.form === "unsealable" && !toldPlain) {
      toldPlain = true;
      // Not while a store is set aside (by this run or an earlier one): the steps' `logout` deletes it, and a
      // fixed key store would open it again once it is renamed back.
      const steps = written.reseal !== undefined && store.setAside().length === 0 ? ` ${written.reseal}` : "";
      log(`Storing this login unencrypted, readable only by you: ${written.reason}.${steps}`);
    }
    return true;
  }

  const clearPending = (deviceCode: string) =>
    update((e) => (e.pending?.deviceCode === deviceCode ? { active: e.active } : null));

  function printCode(p: PendingLogin): void {
    log("To sign in, open this link and check the code matches:");
    log(`  ${p.verificationUri}`);
    log(`  Code: ${p.userCode}`);
  }

  function signedIn(s: CliSession): LoginOutcome {
    for (const line of signedInLines(s)) log(line);
    return "signed-in";
  }

  const approvalChanged = (storedAt: number): boolean => {
    const now = entryOf(store.read(), key).active;
    return now !== undefined && now.storedAt !== storedAt;
  };

  /** Confirm the stored, unconfirmed login with the control plane (which fires `cli_login`). */
  async function confirm(): Promise<LoginOutcome> {
    let said = false;
    for (let attempt = 0; ; attempt++) {
      const stored = entryOf(store.read(), key).active;
      if (!stored) throw new Error(NOT_SIGNED_IN);
      if (stored.confirmedAt !== null) return report();
      const storedAt = stored.storedAt;
      const dropIfSame = () => update((e) => (e.active?.storedAt === storedAt ? { pending: e.pending } : null));
      let res: SessionResult;
      // Who refused the approved login: UI Verify (a 401, even when the renewal it forced then failed) or AuthKit.
      let refusedBy: "server" | "authkit" = "server";
      try {
        res = await storedSession(deps, store, deps.apiUrl, "POST", { pin: storedAt, headers: deps.clientHeaders });
      } catch (e) {
        if (!(e instanceof LoginGoneError)) throw e;
        // Another `login` stored a newer approval meanwhile: confirm that one on the next pass.
        if (approvalChanged(storedAt)) continue;
        res = { kind: "unauthorized" };
        if (!e.afterRejection) refusedBy = "authkit";
      }
      if (res.kind === "ok") {
        let recorded = false;
        await update((e) => {
          if (e.active?.storedAt !== storedAt) return null;
          recorded = true;
          return { active: { ...e.active, confirmedAt: deps.now() } };
        });
        // A newer approval replaced this one while the request was out: confirm that one instead, so what is
        // reported is what is stored.
        if (!recorded) continue;
        return signedIn(res.session);
      }
      if (res.kind === "unauthorized") {
        if (await dropIfSame()) deps.reportEnded(refusedBy === "server" ? "rejected" : "refresh_refused");
        throw new Error(`UI Verify did not accept the new login. Run ${LOGIN_COMMAND} again.`);
      }
      if (deps.now() - storedAt > CONFIRM_GIVE_UP_MS) {
        if (await dropIfSame()) deps.reportEnded("account_not_ready");
        // Not the server's "try again in a minute": ten minutes in, the account isn't coming.
        throw new Error(
          "UI Verify still hasn't finished setting up your account. Sign in once at the website to finish it, then run " +
            `${LOGIN_COMMAND} again. If that doesn't help, contact support.`,
        );
      }
      if (!said) log("Finishing setting up your account...");
      said = true;
      const delay = CONFIRM_DELAYS_MS[Math.min(attempt, CONFIRM_DELAYS_MS.length - 1)] ?? 30_000;
      if (deps.now() + delay > deadline) {
        log(`Still finishing your sign-in. Run ${LOGIN_COMMAND} again to finish.`);
        return "waiting";
      }
      await deps.sleep(delay);
    }
  }

  /** A stored, confirmed login, confirmed again with the control plane; null when it is dead. */
  async function report(): Promise<LoginOutcome> {
    let res: SessionResult;
    try {
      res = await storedSession(deps, store, deps.apiUrl, "GET");
    } catch (e) {
      if (e instanceof LoginGoneError) return start();
      throw e;
    }
    if (res.kind !== "ok") return start();
    const pending = entryOf(store.read(), key).pending;
    if (pending) await clearPending(pending.deviceCode);
    return signedIn(res.session);
  }

  // A store this shell can't open (dead, or sealed with a key this shell can't get, e.g. a sandboxed agent
  // shell after a login at the person's own terminal) is renamed, never deleted, so `login` always has a way
  // forward. A newer uiverify's store is left alone.
  let first: LoginEntry;
  try {
    first = entryOf(store.read(), key);
  } catch (e) {
    // A keychain that timed out (an unlock dialog nobody answered) may open next time: never set aside for it.
    if (!(e instanceof UnreadableStoreError) || e.kind === "newer" || e.kind === "timeout") throw e;
    const aside = await store.withLock(async () => {
      try {
        store.read();
        return null;
      } catch (again) {
        if (!(again instanceof UnreadableStoreError) || again.kind === "newer" || again.kind === "timeout") throw again;
        seal = !again.sealedElsewhere;
        return store.moveAside();
      }
    });
    if (aside) {
      const plain = seal ? "" : " The new login is stored unencrypted, readable by any shell or machine that shares this folder.";
      log(`${e.message} Moved it to ${aside} (rename it back to use it again) and signing in afresh.${plain}`);
    }
    first = entryOf(store.read(), key);
  }
  // Names the approval this run started from; a renewal keeps it, a new approval (another process's) changes it.
  const seenApproval = first.active?.storedAt;
  const resumable = first.pending && first.pending.expiresAt > deps.now() ? first.pending : undefined;
  if (resumable) printCode(resumable);

  /** Wait for approval of `pending`, then confirm. `fresh`: this run created the code; `opened`: and opened
   *  a browser on it. */
  async function poll(pending: PendingLogin, fresh: boolean, opened: boolean): Promise<LoginOutcome> {
    if (fresh && !opened && !deps.isTTY) {
      const minutes = Math.max(1, Math.round((pending.expiresAt - deps.now()) / 60_000));
      log(
        `Show this link and code to the person signing in; the code must be picked up within ${minutes} ` +
          `minute${minutes === 1 ? "" : "s"}. If they see your messages while you work, run ${LOGIN_COMMAND} again ` +
          "right away and again while it says it is still waiting. If they only see them when you stop, stop " +
          `here and run ${LOGIN_COMMAND} again as soon as they say they approved.`,
      );
      return "waiting";
    }
    log("Waiting for you to approve in the browser...");
    let saidRetrying = false;
    let interval = pending.interval;
    // A resumed code may have been approved while no process was watching: ask at once.
    let wait = fresh ? interval * 1000 : 0;
    for (;;) {
      if (deps.now() + wait >= pending.expiresAt) return codeEnded("expired");
      if (deps.now() + wait > deadline) {
        log(`Still waiting for approval. Run ${LOGIN_COMMAND} again to keep waiting (same code).`);
        return "waiting";
      }
      await deps.sleep(wait);
      let r: PollResult;
      try {
        r = await pollDeviceToken(deps, pending);
      } catch (e) {
        // A network blip, or AuthKit's 5xx or rate limit: keep polling (RFC 8628) rather than end a login the
        // person may be approving right now. Any other answer is a real error.
        if (!transient(e)) throw e;
        if (!saidRetrying) log(`Couldn't get a usable answer from the sign-in server (${errorMessage(e)}); still trying...`);
        saidRetrying = true;
        r = { kind: "pending", slowDown: false };
      }
      if (r.kind === "tokens") {
        const now = deps.now();
        // A stored login makes any code moot, this one's or another process's.
        await update(() => ({
          active: { clientId: pending.clientId, tokenEndpoint: pending.tokenEndpoint, ...r.tokens, confirmedAt: null, storedAt: now },
        }));
        return confirm();
      }
      if (r.kind === "pending") {
        if (r.slowDown) {
          interval += SLOW_DOWN_STEP_S;
          await update((e) => (e.pending?.deviceCode === pending.deviceCode ? { ...e, pending: { ...e.pending, interval } } : null));
        }
        wait = interval * 1000;
        continue;
      }
      return codeEnded(r.kind);
    }

    /** The code is over (denied, expired, already used): unless another `login` signed in with it, fail. */
    async function codeEnded(kind: "denied" | "expired" | "used"): Promise<LoginOutcome> {
      const cleared = await clearPending(pending.deviceCode);
      // Another `login` may have redeemed this code: a login it stored is this one's success too. Its write may
      // still be queued behind the lock (an upload renewing), so look after a short wait and under the lock.
      if (kind === "used") await deps.sleep(LOSER_GRACE_MS);
      const now = await store.withLock(async () => entryOf(store.read(), key));
      if (now.active && now.active.storedAt !== seenApproval) {
        return now.active.confirmedAt === null ? confirm() : report();
      }
      if (cleared) deps.reportEnded(kind === "used" ? "code_used" : kind);
      throw new Error(FAILED_POLL[kind]);
    }
  }

  async function start(): Promise<LoginOutcome> {
    const fresh = entryOf(store.read(), key).pending;
    if (fresh && fresh.expiresAt > deps.now()) {
      if (fresh.deviceCode !== resumable?.deviceCode) printCode(fresh);
      return poll(fresh, false, false);
    }
    const created = await startDeviceLogin(deps);
    // Another `login` may have stored its own code meanwhile: adopt it, so every run shows the one code.
    let pending = created;
    let replacedExpired = false;
    await update((e) => {
      if (e.pending && e.pending.expiresAt > deps.now()) pending = e.pending;
      else replacedExpired = e.pending !== undefined;
      return { ...e, pending };
    });
    // A code that died while no run was polling it; this write is the one that removed it.
    if (replacedExpired) deps.reportEnded("expired_unwatched");
    printCode(pending);
    if (pending !== created) return poll(pending, false, false);
    const opened = deps.canOpenBrowser && (await deps.openBrowser(pending.verificationUri));
    return poll(pending, true, opened);
  }

  if (first.active) return first.active.confirmedAt === null ? confirm() : report();
  return start();
}

// ---------------------------------------------------------------------------------------------------------
// whoami / logout

/** `uiverify whoami`: who the stored login for this API URL is, confirmed with the control plane. */
export async function runWhoami(deps: AuthDeps & { apiUrl: string; store: CredentialStore; log: (msg: string) => void }): Promise<void> {
  const notSignedIn = `Not signed in. Run ${LOGIN_COMMAND}.`;
  const active = entryOf(deps.store.read(), loginKey(deps.apiUrl)).active;
  if (!active) throw new Error(notSignedIn);
  if (active.confirmedAt === null) throw new Error(NOT_FINISHED);
  let res: SessionResult;
  try {
    res = await storedSession(deps, deps.store, deps.apiUrl, "GET");
  } catch (e) {
    if (e instanceof LoginGoneError) throw new Error(notSignedIn);
    throw e;
  }
  if (res.kind === "unauthorized") throw new Error(notSignedIn);
  if (res.kind === "forbidden") throw new Error(res.message);
  for (const line of signedInLines(res.session)) deps.log(line);
}

/** `uiverify logout`: forget the stored login (and any pending code) for this API URL. A store that can never
 *  be read is deleted whole: it can't be used, and signing out must not leave a renewable login on disk. */
export async function runLogout(deps: { apiUrl: string; store: CredentialStore; log: (msg: string) => void }): Promise<void> {
  const key = loginKey(deps.apiUrl);
  const outcome = await deps.store.withLock(async (): Promise<{ result: "removed" | "none" | "deleted-unreadable"; asides: string[] }> => {
    let file: Credentials | null;
    try {
      file = deps.store.read();
    } catch (e) {
      // A keychain that only timed out may open on the next try: touch nothing. Any other store this shell
      // can't read is deleted whole, since signing out must leave no renewable login behind.
      if (!(e instanceof UnreadableStoreError) || e.kind === "timeout" || e.kind === "newer") throw e;
      file = null;
    }
    // Logins `login` set aside could be renamed back into use: signing out removes them too.
    const asides = deps.store.setAside();
    for (const f of asides) fs.rmSync(f, { force: true });
    if (file === null) {
      deps.store.remove();
      return { result: "deleted-unreadable", asides };
    }
    if (!file.logins[key]) return { result: "none", asides };
    deps.store.write(withEntry(file, key, {}));
    return { result: "removed", asides };
  });
  if (outcome.result === "deleted-unreadable") {
    deps.log(`Deleted ${deps.store.file}, which this shell couldn't read. It held every UI Verify login on this machine, for every server.`);
  } else {
    deps.log(outcome.result === "removed" ? `Signed out of ${key}.` : `Not signed in to ${key}.`);
  }
  if (outcome.asides.length > 0) {
    deps.log(`Also deleted ${outcome.asides.length} login file(s) set aside earlier: ${outcome.asides.join(", ")}.`);
  }
}

/** Whether a browser can plausibly be opened: not CI, not an SSH session, and on Linux a display. */
export function shouldOpenBrowser(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, ci: boolean): boolean {
  if (ci || env.SSH_CONNECTION || env.SSH_TTY) return false;
  if (platform === "darwin" || platform === "win32") return true;
  return Boolean(env.DISPLAY || env.WAYLAND_DISPLAY);
}
