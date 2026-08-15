import { describe, expect, test } from "bun:test";
import { parseShadowDirectives } from "./directives.ts";
import { MalformedDirectiveError } from "./errors.ts";
import { buildShadowSystemPrompt, RULEBOOK_DIRECTIVE_TAG } from "./system-prompt.ts";
import { expectRejection } from "./test-helpers.ts";

describe("parseShadowDirectives", () => {
  test("returns empty arrays when the text has no directives", () => {
    const parsed = parseShadowDirectives("Just chatting, nothing to do here.");
    expect(parsed.research).toEqual([]);
    expect(parsed.chapters).toEqual([]);
  });

  test("parses a research directive", () => {
    const text = [
      "Let me look into this.",
      "```shadow:research",
      '{"goal": "How does Linear design its UI?", "subjectDomains": ["linear.app"], "maxSources": 3}',
      "```",
    ].join("\n");
    const parsed = parseShadowDirectives(text);
    expect(parsed.research).toHaveLength(1);
    expect(parsed.research[0]).toEqual({
      goal: "How does Linear design its UI?",
      subjectDomains: ["linear.app"],
      maxSources: 3,
    });
  });

  test("parses multiple research directives in one reply, in order", () => {
    const text = [
      "```shadow:research",
      '{"goal": "topic A"}',
      "```",
      "```shadow:research",
      '{"goal": "topic B"}',
      "```",
    ].join("\n");
    const parsed = parseShadowDirectives(text);
    expect(parsed.research.map((r) => r.goal)).toEqual(["topic A", "topic B"]);
  });

  test("parses a chapter directive with sourced, derived, and operator claims", () => {
    const text = [
      "```shadow:chapter",
      JSON.stringify({
        slug: "how-linear-designs-ui",
        title: "How Linear designs its UI",
        body: "Linear uses a 4px grid.[^lin-4px]",
        frontmatter: { when_to_use: "Designing dense UI", keywords: ["Linear"] },
        claims: [
          {
            label: "lin-4px",
            kind: "sourced",
            text: "Linear uses a 4px grid.",
            evidence: [{ sourceId: "src_01", quote: "a 4px grid" }],
          },
          {
            label: "derived-1",
            kind: "derived",
            text: "Both are systematic.",
            supports: ["lin-4px"],
          },
          {
            label: "op-1",
            kind: "operator",
            text: "The operator believes in dense UI.",
            evidence: [{ sourceId: "src_session", quote: "I believe in dense UI" }],
          },
        ],
      }),
      "```",
    ].join("\n");

    const parsed = parseShadowDirectives(text);
    expect(parsed.chapters).toHaveLength(1);
    const chapter = parsed.chapters[0];
    expect(chapter?.slug).toBe("how-linear-designs-ui");
    expect(chapter?.claims).toHaveLength(3);
    expect(chapter?.claims.map((c) => c.kind)).toEqual(["sourced", "derived", "operator"]);
  });

  test("throws MalformedDirectiveError on invalid JSON", () => {
    const text = ["```shadow:research", "{not json", "```"].join("\n");
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });

  test("throws MalformedDirectiveError when a required field is missing", () => {
    const text = ["```shadow:research", "{}", "```"].join("\n");
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });

  test("throws MalformedDirectiveError when a chapter claim kind is invalid", () => {
    const text = [
      "```shadow:chapter",
      JSON.stringify({
        slug: "x",
        title: "X",
        body: "text",
        claims: [{ label: "a", kind: "bogus", text: "text" }],
      }),
      "```",
    ].join("\n");
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });

  test("parses a rulebook directive with only required fields", () => {
    const text = [
      "```shadow:rulebook",
      JSON.stringify({
        slug: "rnb-loan-agreement",
        title: "RNB Loan Agreement",
        docPath: "/tmp/rnb_loan.pdf",
      }),
      "```",
    ].join("\n");
    const parsed = parseShadowDirectives(text);
    expect(parsed.rulebooks).toHaveLength(1);
    expect(parsed.rulebooks[0]).toEqual({
      slug: "rnb-loan-agreement",
      title: "RNB Loan Agreement",
      docPath: "/tmp/rnb_loan.pdf",
    });
  });

  test("parses a rulebook directive with optional fields", () => {
    const text = [
      "```shadow:rulebook",
      JSON.stringify({
        slug: "sar-filing",
        title: "SAR Filing Rules",
        docPath: "/tmp/sar.pdf",
        scope: "focus on filing deadlines, not exemptions",
        constraints: ["keep group titles under 6 words"],
        maxGroups: 8,
      }),
      "```",
    ].join("\n");
    const parsed = parseShadowDirectives(text);
    expect(parsed.rulebooks).toHaveLength(1);
    expect(parsed.rulebooks[0]).toEqual({
      slug: "sar-filing",
      title: "SAR Filing Rules",
      docPath: "/tmp/sar.pdf",
      scope: "focus on filing deadlines, not exemptions",
      constraints: ["keep group titles under 6 words"],
      maxGroups: 8,
    });
  });

  test("throws MalformedDirectiveError on invalid JSON in a rulebook block", () => {
    const text = ["```shadow:rulebook", "{not json", "```"].join("\n");
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });

  test("throws MalformedDirectiveError when a rulebook slug is not kebab-case", () => {
    const text = [
      "```shadow:rulebook",
      JSON.stringify({ slug: "Not Kebab Case", title: "X", docPath: "/tmp/doc.md" }),
      "```",
    ].join("\n");
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });

  test("throws MalformedDirectiveError when a rulebook directive is missing docPath", () => {
    const text = ["```shadow:rulebook", JSON.stringify({ slug: "x", title: "X" }), "```"].join(
      "\n",
    );
    expect(() => parseShadowDirectives(text)).toThrow(MalformedDirectiveError);
  });
});

describe("buildShadowSystemPrompt", () => {
  test("mentions the shadow:rulebook directive tag", () => {
    const prompt = buildShadowSystemPrompt();
    expect(prompt).toContain(RULEBOOK_DIRECTIVE_TAG);
  });
});

describe("expectRejection helper", () => {
  test("re-exports work as expected (sanity check for the shared test helper itself)", async () => {
    await expectRejection(
      Promise.reject(new MalformedDirectiveError("research", "{}", "bad")),
      MalformedDirectiveError,
    );
  });
});
