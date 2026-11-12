import fs from "node:fs";
import type { Credential } from "./auth";
import type { ClientDeltaEntry } from "./git";
import { NOT_SIGNED_IN } from "./login";
import { HttpStatusError, withRetry } from "./retry";
import { z } from "zod";
import pkg from "../package.json";

/** This CLI's own version, reported at register (`x-uiverify-cli-version`) so UI Verify can nudge an
 *  outdated CLI. Inlined at build time (esbuild bundles the JSON import). */
export const CLI_VERSION: string = pkg.version;

// The review notes still open on this build's branch, so the CLI can print them before it renders anything.
// Optional end to end: an older server omits it, a branch with no open notes omits it, and a shape this client
// can't read becomes absent too, since a register must never fail over a hint. `body` is null when the server
// withheld the text (a CI run, or a public project), and `textShown` says so for the whole list.
const openCommentNote = z.object({
  storyId: z.string(),
  title: z.string(),
  name: z.string(),
  viewport: z.string(),
  browser: z.string(),
  buildNumber: z.number(),
  reviewUrl: z.string(),
  author: z.string(),
  body: z.string().nullable(),
  replies: z.number(),
});
const openComments = z
  .object({
    branch: z.string(),
    projectId: z.string(),
    total: z.number(),
    textShown: z.boolean(),
    notes: z.array(openCommentNote),
  })
  .nullish()
  .catch(undefined)
  .transform((v) => v ?? undefined);

export type OpenComments = NonNullable<z.output<typeof openComments>>;

// `baselineCommits` are the (sparse) commits a baseline could come from; the CLI intersects them
// against the head's true local git ancestry and uploads the confirmed subset at markUploaded. An
// older server omits the field, so it defaults to empty (it then resolves the legacy way) — the
// client must never break on its absence.
const registerResponse = z.object({
  buildId: z.string(),
  uploadUrl: z.string(),
  baselineCommits: z.array(z.string()).default([]),
  // The base commits skip-unchanged should diff against, named by the server. The CLI computes the
  // changed-file delta over these with local git (`deltaFor`) and sends it with the upload. An older
  // server omits the field ⇒ empty (no git work). Sanitized in `register` before use.
  deltaBases: z.array(z.string()).default([]),
  // Advisory, non-blocking messages surfaced into the CI log (e.g. the GitHub App isn't installed on
  // the repo, so no check/comment will post). An older server omits the field ⇒ empty.
  warnings: z.array(z.string()).default([]),
  openComments,
  // The project a signed-in upload landed in: the server picks it from the repo and upload type (or
  // `--project`), and creates it (and the first team) when nothing matches. Absent for a key upload and from an
  // older server; `teamCreated` and `url` are absent from a server that predates creating them.
  project: z
    .object({
      id: z.string(),
      team: z.string(),
      slug: z.string(),
      created: z.boolean(),
      teamCreated: z.boolean().optional(),
      url: z.string().optional(),
    })
    .optional(),
});

export type RegisteredProject = NonNullable<z.infer<typeof registerResponse>["project"]>;

// The server skipped the rebuild of an already-passed commit: a same-commit re-upload whose bundle hash
// matched a prior fully-accepted, zero-failure build. Nothing was created; `buildNumber` is that prior
// build (for the "Skipping rebuild of already-passed build #N" line). Only a server new enough to know
// the hash returns this, and only when the CLI sent one — an older server always returns an upload URL.
const skippedRegisterResponse = z.object({
  outcome: z.literal("skipped"),
  buildId: z.string(),
  buildNumber: z.number(),
  openComments,
});

/** The register outcome: either an upload URL to PUT the bundle to (the normal flow), or a skip of the
 *  rebuild of an already-passed commit (no upload, no poll — just print and exit 0). */
export type RegisterResult =
  | {
      outcome: "upload";
      buildId: string;
      uploadUrl: string;
      baselineCommits: string[];
      deltaBases: string[];
      warnings: string[];
      openComments?: OpenComments;
      project?: RegisteredProject;
    }
  | { outcome: "skipped"; buildId: string; buildNumber: number; openComments?: OpenComments };

const CANONICAL_SHA = /^[0-9a-f]{40}$/;
const MAX_DELTA_BASES = 16;

/** Each base lands on a `git` argv, so a base is trusted only if it is a canonical 40-hex SHA; any
 *  violation (or an over-long list from a hostile/proxied `--api-url`) drops the whole field so no git
 *  work runs on attacker-influenced input. */
function sanitizeDeltaBases(bases: string[]): string[] {
  if (bases.length > MAX_DELTA_BASES || !bases.every((b) => CANONICAL_SHA.test(b))) return [];
  return bases;
}
// The per-story summary the server attaches on the terminal poll (and only then) so the CLI can print
// the changed-story list + AI verdicts into the CI log. Mirrors what the GitHub check / `get_build`
// MCP render. Extra per-story fields it carries (viewport, browser, diffResultId, changedPct) are
// intentionally dropped here — the log doesn't print them. `comments` (open review notes) may be absent or null:
// an older server doesn't send it, and the CLI then prints no comment lines.
const commentCounts = z.object({ total: z.number(), unresolved: z.number() });
const changedStorySummary = z.object({
  storyId: z.string(),
  title: z.string(),
  name: z.string(),
  decision: z.string().nullable(),
  aiVerdict: z.string().nullable(),
  aiConfidence: z.string().nullable(),
  aiSummary: z.string().nullable(),
  comments: commentCounts.nullish(),
});
const failedStorySummary = z.object({
  storyId: z.string(),
  title: z.string(),
  name: z.string(),
  error: z.string(),
});
const buildSummary = z.object({
  aiReview: z.object({ regressions: z.number(), intended: z.number(), reviewed: z.number() }).nullable(),
  comments: commentCounts.nullish(),
  changedStories: z.array(changedStorySummary),
  changedStoriesTruncated: z.object({ shown: z.number(), total: z.number() }).nullable(),
  failedStories: z.array(failedStorySummary),
});

// Progress fields are optional: an older server returns just `{ status }`, and the client must never
// break on that (it would fail the consumer's CI). They default to 0 when absent. `summary` is present
// only on the terminal poll of a server new enough to send it — absent while running and on older
// servers, so it's optional and the CLI prints the summary block only when it arrives.
const statusResponse = z.object({
  status: z.string(),
  processed: z.number().default(0),
  total: z.number().default(0),
  changed: z.number().default(0),
  failed: z.number().default(0),
  summary: buildSummary.optional(),
  // Why a build failed as a whole (an unusable upload, a bundle crash). Absent on an older server.
  failureReason: z.string().nullable().optional(),
  // Why a `blocked` build was paused and what to do next, already worded for the user. The server sends more
  // structured fields; only the ready-made `message` is read, so the wording stays the server's. Null or absent
  // for any other status and on an older server; a shape this client can't read becomes null too, so the CLI
  // prints its generic line instead of failing the poll.
  blocked: z.object({ message: z.string() }).nullish().catch(null),
});

export type BuildStatus = z.infer<typeof statusResponse>;
export type BuildSummary = z.infer<typeof buildSummary>;

export interface RegisterBody {
  commitSha: string;
  branch: string;
  prNumber: number | null;
  parentShas: string[];
  /** The PR head the checkout was built from, when the CLI could prove it; the server posts the PR's
   *  check there instead of deriving it from `parentShas` (which a shallow merge checkout lacks). */
  prHeadSha?: string;
  autoAcceptChanges?: boolean;
  /** Render only the stories this commit's changed files could affect and carry the rest forward
   *  (skip-unchanged). Decided server-side; per build, so it never changes anyone else's builds. */
  onlyChanged?: boolean;
  /** The checkout had edits that aren't in `commitSha` (or git couldn't say), so the server won't use this
   *  build's results as a reference point for skipping in later builds. */
  uncommittedChanges?: boolean;
  /** This is an interactive preview check (`uiverify check`, a coding agent's edit-loop): render only
   *  `previewTargets`, diff against the real CI baseline, post no GitHub check, and never advance a CI
   *  baseline. Metered like any build. Absent/false ⇒ a normal build. */
  preview?: boolean;
  /** The agent's explicit target selection for a preview check — story-id globs (`components-button--*`)
   *  or exact ids. The server intersects them with the bundle to form the render set, REPLACING the
   *  dep-graph closure a CI build uses. Only meaningful with `preview: true`. */
  previewTargets?: string[];
  /** GitHub `owner/repo`; the server binds it to the project so it knows where to post the check +
   *  PR comment. Omitted when it can't be determined locally. */
  repoFullName?: string;
  /** `owner/repo` of the checkout's `upstream` remote, when it has one. */
  upstreamRepoFullName?: string;
  /** `--project` verbatim (`slug` or `team/slug`): which project a signed-in upload goes to. Sent with a key
   *  too, and the server refuses one that doesn't name the key's project. */
  project?: string;
  /** `--confirm-new`, sent only when given. */
  confirmNew?: string;
  /** What was uploaded, by a file sniff: `--screenshots`, a Storybook static dir, or a capture archive. The
   *  server derives the project type from it (with the SDK header); the CLI never maps one to the other. */
  captureShape?: CaptureShape;
  /** The capture SDK that produced the bundle (`@uiverify/playwright` | `@uiverify/vitest`) and its
   *  version, read from the archive manifest. Sent as `x-uiverify-sdk-*` headers (never in the JSON
   *  body). Absent for a Storybook upload (no SDK) or an archive from a pre-stamp SDK. */
  sdkName?: string;
  sdkVersion?: string;
  /** The deterministic content hash of the bundle about to be uploaded (`bundleContentHash`, tagged
   *  `v1:<hex>`). Lets the server skip the rebuild of an already-passed commit when it matches a prior
   *  fully-accepted build at the same commit. Omitted under `--render-all`, or if hashing somehow failed. */
  bundleContentHash?: string;
  /** This run's output may be read by people outside the team (`outputMayBePublic`): the server then
   *  withholds review-comment text from the response. Absent from an older CLI, which gets none either. */
  ci?: boolean;
}

export type CaptureShape = "storybook" | "archive" | "screenshots";

export interface IngestClient {
  register(body: RegisterBody): Promise<RegisterResult>;
  upload(uploadUrl: string, tgzPath: string): Promise<void>;
  /** `ancestorShas`: the confirmed-ancestor subset of the register response's `baselineCommits`, used
   *  to gate baseline inheritance against true git ancestry. Empty when the checkout was shallow.
   *  `changedFiles`: the skip-unchanged delta (`deltaFor`), the server's only source of changed files;
   *  omitted when there is none, and then nothing is carried from an earlier commit. */
  markUploaded(buildId: string, ancestorShas: string[], changedFiles?: Record<string, ClientDeltaEntry>): Promise<void>;
  getStatus(buildId: string): Promise<BuildStatus>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/**
 * Build the error for a failed HTTP response. The control plane returns `{ "error": "<message>" }` on a
 * deliberate rejection - e.g. a wrong project type / SDK yields a 409 whose body is the actionable
 * "This is a screenshot project, but you uploaded with the @uiverify/playwright SDK..." - so surface
 * that message verbatim, giving the user something they can act on instead of a raw
 * `POST /api/ingest/build -> 409: {"error":"..."}`. Falls back to the `<label> -> <status>: <body>`
 * status line for a non-JSON / opaque body. (4xx is never retried, so this message goes straight to the
 * CLI's error output.)
 */
function httpError(label: string, status: number, body: string, fromUiVerify = true): HttpStatusError {
  try {
    const parsed: unknown = JSON.parse(body);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error) {
      return new HttpStatusError(status, parsed.error, label, fromUiVerify ? parsed.error : null);
    }
  } catch {
    // Not JSON - fall through to the raw status line below.
  }
  return new HttpStatusError(status, body ? `${label} -> ${status}: ${body}` : `${label} -> ${status}`, label, null);
}

/**
 * HTTP client for the ingest contract. Every call asks `credential` for its token first and sends it in the
 * Authorization header, the only place a credential travels (never in logs); the bundle PUT goes to the
 * presigned URL (no auth header — the URL is the capability).
 *
 * Every call is time-bounded per attempt and retried on transport failures + 5xx (never 4xx) via
 * `withRetry`, so a single stalled request no longer fails the run — the retry lands on a healthy
 * response. `markUploaded` is idempotent, so a retry can't double-render. A login answered 401 is renewed
 * once and the call retried once, which covers a clock running behind the server's.
 */
export function httpIngestClient(apiUrl: string, credential: Credential): IngestClient {
  async function authorized<T>(label: string, send: (headers: Record<string, string>, signal: AbortSignal) => Promise<T>): Promise<T> {
    // Every request identifies the CLI version.
    const headersFor = (token: string) => ({ authorization: `Bearer ${token}`, "x-uiverify-cli-version": CLI_VERSION });
    const token = await credential.token();
    try {
      return await withRetry({ label }, (signal) => send(headersFor(token), signal));
    } catch (e) {
      if (!credential.renew || !(e instanceof HttpStatusError) || e.status !== 401) throw e;
    }
    const renewed = await credential.renew(token);
    try {
      return await withRetry({ label }, (signal) => send(headersFor(renewed), signal));
    } catch (e) {
      if (e instanceof HttpStatusError && e.status === 401) throw new HttpStatusError(401, NOT_SIGNED_IN, e.label, e.serverError);
      throw e;
    }
  }

  async function postJson(
    pathname: string,
    body: unknown,
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(`${apiUrl}${pathname}`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw httpError(`POST ${pathname}`, res.status, await res.text());
    return res.json();
  }

  return {
    async register(body) {
      // The SDK identity travels as headers, not in the JSON body - strip it out so the body stays the
      // build-input contract and only send the headers when the bundle actually reported an SDK.
      const { sdkName, sdkVersion, ...payload } = body;
      const sdkHeaders: Record<string, string> = {
        ...(sdkName ? { "x-uiverify-sdk-name": sdkName } : {}),
        ...(sdkVersion ? { "x-uiverify-sdk-version": sdkVersion } : {}),
      };
      const raw = await authorized("register", (headers, signal) =>
        postJson("/api/ingest/build", payload, { ...headers, ...sdkHeaders }, signal),
      );
      // The server skipped the rebuild of an already-passed commit — no upload URL, nothing to do. Only a
      // new-enough server that got a hash returns this shape; try it first, then fall back to the normal
      // upload response (which an older server, or a non-skippable build, always returns).
      const skipped = skippedRegisterResponse.safeParse(raw);
      if (skipped.success) return skipped.data;
      const parsed = registerResponse.parse(raw);
      return { outcome: "upload", ...parsed, deltaBases: sanitizeDeltaBases(parsed.deltaBases) };
    },
    async upload(uploadUrl, tgzPath) {
      const bytes = new Uint8Array(fs.readFileSync(tgzPath));
      await withRetry({ label: "bundle upload" }, async (signal) => {
        const res = await fetch(uploadUrl, {
          method: "PUT",
          headers: { "content-type": "application/gzip" },
          body: bytes,
          signal,
        });
        // The PUT goes to the storage host (or a proxy in front of it), so its error text is never ours.
        if (!res.ok) throw httpError("bundle upload", res.status, await res.text(), false);
      });
    },
    async markUploaded(buildId, ancestorShas, changedFiles) {
      const body = changedFiles ? { ancestorShas, changedFiles } : { ancestorShas };
      await authorized("markUploaded", (headers, signal) =>
        postJson(`/api/ingest/build/${buildId}/uploaded`, body, headers, signal),
      );
    },
    async getStatus(buildId) {
      const res = await authorized("status", async (headers, signal) => {
        const r = await fetch(`${apiUrl}/api/ingest/build/${buildId}`, { headers, signal });
        if (!r.ok) throw httpError("status", r.status, await r.text());
        return r.json();
      });
      return statusResponse.parse(res);
    },
  };
}
