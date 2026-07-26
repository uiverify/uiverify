import fs from "node:fs";
import { HttpStatusError, withRetry } from "./retry";
import { z } from "zod";

// `baselineCommits` are the (sparse) commits a baseline could come from; the CLI intersects them
// against the head's true local git ancestry and uploads the confirmed subset at markUploaded. An
// older server omits the field, so it defaults to empty (it then resolves the legacy way) — the
// client must never break on its absence.
const registerResponse = z.object({
  buildId: z.string(),
  uploadUrl: z.string(),
  baselineCommits: z.array(z.string()).default([]),
  // Advisory, non-blocking messages surfaced into the CI log (e.g. the GitHub App isn't installed on
  // the repo, so no check/comment will post). An older server omits the field ⇒ empty.
  warnings: z.array(z.string()).default([]),
});
// The per-story summary the server attaches on the terminal poll (and only then) so the CLI can print
// the changed-story list + AI verdicts into the CI log. Mirrors what the GitHub check / `get_build`
// MCP render. Extra per-story fields it carries (viewport, browser, diffResultId, changedPct) are
// intentionally dropped here — the log doesn't print them.
const changedStorySummary = z.object({
  storyId: z.string(),
  title: z.string(),
  name: z.string(),
  decision: z.string().nullable(),
  aiVerdict: z.string().nullable(),
  aiConfidence: z.string().nullable(),
  aiSummary: z.string().nullable(),
});
const failedStorySummary = z.object({
  storyId: z.string(),
  title: z.string(),
  name: z.string(),
  error: z.string(),
});
const buildSummary = z.object({
  aiReview: z.object({ regressions: z.number(), intended: z.number(), reviewed: z.number() }).nullable(),
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
});

export type BuildStatus = z.infer<typeof statusResponse>;
export type BuildSummary = z.infer<typeof buildSummary>;

/**
 * HTTP client for the ingest contract. Authenticates every call with the project API key; the bundle
 * PUT goes to the presigned URL (no auth header — the URL is the capability). The key only ever
 * travels in the Authorization header, never in logs.
 *
 * Every call is time-bounded per attempt and retried on transport failures + 5xx (never 4xx) via
 * `withRetry`, so a single stalled request no longer fails the run — the retry lands on a healthy
 * response. `markUploaded` is idempotent, so a retry can't double-render.
 */
export interface RegisterBody {
  commitSha: string;
  branch: string;
  prNumber: number | null;
  parentShas: string[];
  autoAcceptChanges?: boolean;
  /** Render only the stories this commit's changed files could affect and carry the rest forward
   *  (skip-unchanged). Decided server-side; per build, so it never changes anyone else's builds. */
  onlyChanged?: boolean;
  /** GitHub `owner/repo`; the server binds it to the project so it knows where to post the check +
   *  PR comment. Omitted when it can't be determined locally. */
  repoFullName?: string;
}

export interface IngestClient {
  register(
    body: RegisterBody,
  ): Promise<{ buildId: string; uploadUrl: string; baselineCommits: string[]; warnings: string[] }>;
  upload(uploadUrl: string, tgzPath: string): Promise<void>;
  /** `ancestorShas`: the confirmed-ancestor subset of the register response's `baselineCommits`, used
   *  to gate baseline inheritance against true git ancestry. Empty when the checkout was shallow. */
  markUploaded(buildId: string, ancestorShas: string[]): Promise<void>;
  getStatus(buildId: string): Promise<BuildStatus>;
}

export function httpIngestClient(apiUrl: string, apiKey: string): IngestClient {
  const auth = { authorization: `Bearer ${apiKey}` };

  async function postJson(pathname: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    const res = await fetch(`${apiUrl}${pathname}`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) throw new HttpStatusError(res.status, `POST ${pathname} -> ${res.status}: ${await res.text()}`);
    return res.json();
  }

  return {
    async register(body) {
      return registerResponse.parse(
        await withRetry({ label: "register" }, (signal) => postJson("/api/ingest/build", body, signal)),
      );
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
        if (!res.ok) throw new HttpStatusError(res.status, `bundle upload -> ${res.status}: ${await res.text()}`);
      });
    },
    async markUploaded(buildId, ancestorShas) {
      await withRetry({ label: "markUploaded" }, (signal) =>
        postJson(`/api/ingest/build/${buildId}/uploaded`, { ancestorShas }, signal),
      );
    },
    async getStatus(buildId) {
      const res = await withRetry({ label: "status" }, async (signal) => {
        const r = await fetch(`${apiUrl}/api/ingest/build/${buildId}`, { headers: auth, signal });
        if (!r.ok) throw new HttpStatusError(r.status, `status -> ${r.status}: ${await r.text()}`);
        return r.json();
      });
      return statusResponse.parse(res);
    },
  };
}
