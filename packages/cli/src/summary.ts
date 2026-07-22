import type { BuildSummary } from "./client";

/**
 * The plaintext verdict printed to the CI log on a changed/failed build - and the agent's handoff. UI
 * Verify's PR check is a bare commit status (no body), so THIS is where the agent that opened the PR
 * learns what changed and exactly how to resolve it over MCP: an agent reading `gh run view
 * --log-failed` sees the changed stories, the AI judge's intended-vs-regression call, and the numbered
 * MCP recipe (`get_build` -> `render_diff_image` -> `review_diff`/`accept_build`). Returns one string
 * per line; the caller prefixes each with `[uiverify]`.
 *
 * Markdown-free by design (this is a terminal): no bold, no links - the URLs are printed raw.
 */

/** Where an agent acts on the build: the remote MCP endpoint and the selector that addresses it. */
export interface AgentHandoff {
  /** UI Verify's MCP endpoint (`${appUrl}/api/mcp`), driven with the project's API key. */
  mcpUrl: string;
  /** The MCP selector that addresses this build - its PR if it has one, else its commit. */
  selector: string;
}

/** Cap the failed-story list (the server caps the changed list; failures aren't). */
const MAX_LISTED = 20;

/** `{Title} › {Name}`, or the bare `storyId` when the build carried no story name (older builds). */
function storyPlainLabel(s: { storyId: string; title: string; name: string }): string {
  if (!s.name) return s.storyId;
  return s.title ? `${s.title} › ${s.name}` : s.name;
}

/** The AI judge's call as a per-story line suffix — empty when AI review didn't run for the story.
 *  Matches the check's `aiVerdictSuffix` wording ("likely regression" / "intended", conf in parens). */
function aiVerdictSuffix(s: { aiVerdict: string | null; aiConfidence: string | null }): string {
  if (!s.aiVerdict) return "";
  const conf = s.aiConfidence ? ` (${s.aiConfidence})` : "";
  return s.aiVerdict === "regression" ? ` · AI: likely regression${conf}` : ` · AI: intended${conf}`;
}

export function formatVerdictSummary(summary: BuildSummary, buildUrl: string, agent?: AgentHandoff): string[] {
  const lines: string[] = [];

  // AI review (advisory): the judge's tally, present only when AI review ran. Mirrors the check.
  if (summary.aiReview) {
    const { regressions, intended, reviewed } = summary.aiReview;
    const totalChanged = summary.changedStoriesTruncated?.total ?? summary.changedStories.length;
    lines.push("");
    lines.push(
      `AI review (advisory): ${regressions} likely regression${regressions === 1 ? "" : "s"}, ${intended} intended` +
        ` — ${reviewed} of ${totalChanged} changed judged.`,
    );
  }

  // Changed stories (regressions first — the server already orders them that way). The list is capped
  // upstream; print what arrived plus the overflow line from `changedStoriesTruncated`.
  if (summary.changedStories.length > 0) {
    lines.push("");
    lines.push("Changed stories:");
    for (const s of summary.changedStories) {
      const decision = s.decision ?? "awaiting review";
      lines.push(`  ${storyPlainLabel(s)} · ${decision}${aiVerdictSuffix(s)}`);
      if (s.aiSummary) lines.push(`      ${s.aiSummary}`);
    }
    const total = summary.changedStoriesTruncated?.total ?? summary.changedStories.length;
    const overflow = total - summary.changedStories.length;
    if (overflow > 0) lines.push(`  …and ${overflow} more changed`);
  }

  if (summary.failedStories.length > 0) {
    lines.push("");
    lines.push("Failed to render:");
    const shown = summary.failedStories.slice(0, MAX_LISTED);
    for (const s of shown) lines.push(`  ${storyPlainLabel(s)} - ${s.error}`);
    const overflow = summary.failedStories.length - shown.length;
    if (overflow > 0) lines.push(`  …and ${overflow} more`);
  }

  lines.push("");
  lines.push(`Review: ${buildUrl}`);

  // The agent handoff: the exact MCP calls to inspect and resolve this build. This used to live in the
  // GitHub check body, but UI Verify's check is now a bare commit status (no body), so the CI log is
  // where the PR's agent picks up the recipe. Omitted only when the caller has no app URL to build
  // the MCP endpoint from (older invocations); a real `uiverify upload` always passes it.
  if (agent) {
    lines.push("");
    lines.push("For the agent that opened this PR - resolve this over the UI Verify MCP:");
    lines.push(`  Endpoint: ${agent.mcpUrl} (authenticate with your project API key)`);
    lines.push(`  1. get_build ${agent.selector} - the changed-story list, each with a diffResultId.`);
    lines.push(`  2. render_diff_image { "diffResultId": "...", "which": "diff" } - see the changed pixels.`);
    if (summary.changedStories.length > 0) {
      lines.push("  3. Decide intended-vs-regression, then act:");
      lines.push('     - review_diff { "diffResultId": "...", "decision": "accept" | "deny" | "ignore" } - one story.');
      lines.push(`     - accept_build ${agent.selector} - accept every change at once (advances the baseline, greens the check).`);
    } else {
      lines.push("  These are render failures, not visual diffs - fix the failing story or its setup and push again.");
    }
  }
  return lines;
}
