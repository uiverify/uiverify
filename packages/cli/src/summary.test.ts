import { describe, it, expect } from "vitest";
import type { BuildSummary } from "./client";
import { formatVerdictSummary } from "./summary";

const BUILD_URL = "https://uiverify.example.com/builds/b1";

describe("formatVerdictSummary", () => {
  it("renders the AI tally, per-story lines with confidence + summary, overflow, and the review URL", () => {
    const summary: BuildSummary = {
      aiReview: { regressions: 1, intended: 1, reviewed: 2 },
      changedStories: [
        {
          storyId: "components-decisionbadge--all",
          title: "Components/DecisionBadge",
          name: "All",
          decision: null,
          aiVerdict: "regression",
          aiConfidence: "high",
          aiSummary: 'The "Accepted" pill\'s background fill changed from green to transparent.',
        },
        {
          storyId: "pages-project-overview--populated",
          title: "Pages/Project/Overview",
          name: "Populated",
          decision: "accepted",
          aiVerdict: "intended",
          aiConfidence: "medium",
          aiSummary: null,
        },
      ],
      changedStoriesTruncated: { shown: 2, total: 11 },
      failedStories: [],
    };

    const lines = formatVerdictSummary(summary, BUILD_URL);

    // AI tally — "reviewed of {totalChanged}", where totalChanged comes from the truncation total.
    expect(lines).toContain("AI review (advisory): 1 likely regression, 1 intended — 2 of 11 changed judged.");
    expect(lines).toContain("Changed stories:");
    // Regression line: full label, awaiting-review decision, verdict + confidence in parens.
    expect(lines).toContain(
      "  Components/DecisionBadge › All · awaiting review · AI: likely regression (high)",
    );
    // The aiSummary renders as an indented sub-line under its story.
    expect(lines).toContain('      The "Accepted" pill\'s background fill changed from green to transparent.');
    // Second story: its persisted decision + the intended verdict; no sub-line (null summary).
    expect(lines).toContain("  Pages/Project/Overview › Populated · accepted · AI: intended (medium)");
    // Server capped at 2 of 11 → overflow line for the remaining 9.
    expect(lines).toContain("  …and 9 more changed");
    expect(lines).toContain(`Review: ${BUILD_URL}`);

    // No markdown leaks into the terminal output.
    expect(lines.some((l) => l.includes("**") || l.includes("]("))).toBe(false);
  });

  it("omits the AI tally when AI review didn't run, and pluralizes a single regression-less tally", () => {
    const summary: BuildSummary = {
      aiReview: null,
      changedStories: [
        {
          storyId: "components-card--default",
          title: "Components/Card",
          name: "Default",
          decision: null,
          aiVerdict: null,
          aiConfidence: null,
          aiSummary: null,
        },
      ],
      changedStoriesTruncated: null,
      failedStories: [],
    };

    const lines = formatVerdictSummary(summary, BUILD_URL);
    expect(lines.some((l) => l.startsWith("AI review"))).toBe(false);
    // No AI verdict → bare label + decision, nothing else.
    expect(lines).toContain("  Components/Card › Default · awaiting review");
    // Not truncated → no overflow line.
    expect(lines.some((l) => l.includes("more changed"))).toBe(false);
  });

  it("singularizes one regression and uses the changed length when not truncated", () => {
    const summary: BuildSummary = {
      aiReview: { regressions: 1, intended: 0, reviewed: 1 },
      changedStories: [
        {
          storyId: "a",
          title: "A",
          name: "X",
          decision: null,
          aiVerdict: "regression",
          aiConfidence: "low",
          aiSummary: "shifted",
        },
      ],
      changedStoriesTruncated: null,
      failedStories: [],
    };
    const lines = formatVerdictSummary(summary, BUILD_URL);
    expect(lines).toContain("AI review (advisory): 1 likely regression, 0 intended — 1 of 1 changed judged.");
  });

  it("renders the failed-to-render section with its error and caps the list", () => {
    const failedStories = Array.from({ length: 22 }, (_, i) => ({
      storyId: `f-${i}`,
      title: `Pages/Thing${i}`,
      name: "Main",
      error: i === 0 ? "timed out" : "boom",
    }));
    const summary: BuildSummary = {
      aiReview: null,
      changedStories: [],
      changedStoriesTruncated: null,
      failedStories,
    };

    const lines = formatVerdictSummary(summary, BUILD_URL);
    expect(lines).toContain("Failed to render:");
    expect(lines).toContain("  Pages/Thing0 › Main - timed out");
    // 22 failures, capped at 20 → 2 overflow.
    expect(lines.filter((l) => l.startsWith("  Pages/Thing"))).toHaveLength(20);
    expect(lines).toContain("  …and 2 more");
  });

  it("appends the agent MCP handoff (endpoint + numbered recipe + accept) when given an agent target", () => {
    const summary: BuildSummary = {
      aiReview: null,
      changedStories: [
        { storyId: "a", title: "A", name: "X", decision: null, aiVerdict: null, aiConfidence: null, aiSummary: null },
      ],
      changedStoriesTruncated: null,
      failedStories: [],
    };
    const agent = { mcpUrl: "https://uiverify.example.com/api/mcp", selector: '{ "prNumber": 7 }' };

    const lines = formatVerdictSummary(summary, BUILD_URL, agent);
    expect(lines).toContain("For the agent that opened this PR - resolve this over the UI Verify MCP:");
    expect(lines).toContain("  Endpoint: https://uiverify.example.com/api/mcp (authenticate with your project API key)");
    expect(lines).toContain('  1. get_build { "prNumber": 7 } - the changed-story list, each with a diffResultId.');
    expect(lines).toContain(
      '     - accept_build { "prNumber": 7 } - accept every change at once (advances the baseline, greens the check).',
    );
    // Omitted entirely when no agent target is passed (older invocations / no app URL).
    expect(formatVerdictSummary(summary, BUILD_URL).some((l) => l.includes("get_build"))).toBe(false);
    // Still markdown-free.
    expect(lines.some((l) => l.includes("**") || l.includes("]("))).toBe(false);
  });

  it("the failure-only handoff points at fixing the story, not accepting a diff", () => {
    const summary: BuildSummary = {
      aiReview: null,
      changedStories: [],
      changedStoriesTruncated: null,
      failedStories: [{ storyId: "f", title: "F", name: "Y", error: "boom" }],
    };
    const lines = formatVerdictSummary(summary, BUILD_URL, {
      mcpUrl: "https://x/api/mcp",
      selector: '{ "commitSha": "abc" }',
    });
    expect(lines.some((l) => l.includes("accept_build"))).toBe(false);
    expect(lines).toContain(
      "  These are render failures, not visual diffs - fix the failing story or its setup and push again.",
    );
  });

  it("falls back to the storyId when a story has no name (older builds)", () => {
    const summary: BuildSummary = {
      aiReview: null,
      changedStories: [
        {
          storyId: "components-button--primary",
          title: "",
          name: "",
          decision: null,
          aiVerdict: null,
          aiConfidence: null,
          aiSummary: null,
        },
      ],
      changedStoriesTruncated: null,
      failedStories: [],
    };
    const lines = formatVerdictSummary(summary, BUILD_URL);
    expect(lines).toContain("  components-button--primary · awaiting review");
  });
});
