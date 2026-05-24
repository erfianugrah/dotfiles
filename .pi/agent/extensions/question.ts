/**
 * question — ask the user one or more questions during execution.
 *
 * Port of opencode/src/tool/question.ts to Pi. opencode's version uses
 * its own Question.Service with a custom UI; Pi has ctx.ui.select and
 * ctx.ui.input primitives that cover the same need with less code.
 *
 * Schema mirrors opencode's Question.Prompt as closely as the Pi UI
 * surface allows:
 *   questions: [{
 *     question, header (short label), options: [{ label, description }],
 *     multiple (bool), custom (bool, default true)
 *   }]
 *
 * Differences from opencode:
 *   - `multiple` (multi-select) is implemented as repeated single-select
 *     because Pi's ctx.ui has no native multi-select. Tell the user the
 *     loop ends when they pick "(done)".
 *   - `custom` (free-form answer) maps to ctx.ui.input when the user
 *     selects the auto-added "Type your own answer" option.
 *
 * Output format matches opencode for skill-compatibility:
 *   `User has answered your questions: "Q1"="A1", "Q2"="A2,A3". You can now continue with the user's answers in mind.`
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const CUSTOM_OPTION_LABEL = "Type your own answer";
const DONE_OPTION_LABEL = "(done — finish selecting)";

const questionTool = defineTool({
  name: "question",
  label: "Question",
  promptSnippet:
    "question — ask the user multiple-choice or open-ended questions mid-execution. Use when blocked on a decision the user must make, NOT for chatting.",
  promptGuidelines: [
    "Use ONLY when you genuinely need user input to proceed.",
    "Prefer single-question with a small options array; bundle related questions into one call.",
  ],
  description: [
    "Use this tool when you need to ask the user questions during execution. This allows you to:",
    "1. Gather user preferences or requirements",
    "2. Clarify ambiguous instructions",
    "3. Get decisions on implementation choices as you work",
    "4. Offer choices to the user about what direction to take.",
    "",
    "Usage notes:",
    '- When `custom` is enabled (default), a "Type your own answer" option is added automatically; don\'t include "Other" or catch-all options',
    "- Answers are returned as arrays of labels; set `multiple: true` to allow selecting more than one",
    '- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label',
  ].join("\n"),
  parameters: Type.Object({
    questions: Type.Array(
      Type.Object({
        question: Type.String({ description: "Complete question" }),
        header: Type.String({ description: "Very short label (max 30 chars)" }),
        options: Type.Array(
          Type.Object({
            label: Type.String({ description: "Display text (1-5 words, concise)" }),
            description: Type.String({ description: "Explanation of choice" }),
          }),
          { description: "Available choices" },
        ),
        multiple: Type.Optional(
          Type.Boolean({ description: "Allow selecting multiple choices" }),
        ),
        custom: Type.Optional(
          Type.Boolean({
            description: 'Auto-add "Type your own answer" option (default: true)',
          }),
        ),
      }),
      { description: "Questions to ask" },
    ),
  }),

  async execute(_id, params, _signal, _onUpdate, ctx) {
    if (!ctx.hasUI) {
      return {
        isError: true,
        content: [{ type: "text", text: "Error: question tool requires interactive mode (no UI available)" }],
        details: { answers: [] },
      };
    }

    const allAnswers: string[][] = [];

    for (const q of params.questions) {
      const allowCustom = q.custom ?? true;
      const baseOptions = q.options.map((o) => o.label);
      // Pi's select takes a list of strings. We add the custom + done options
      // when relevant. Descriptions are shown by appending after a dash since
      // ctx.ui.select doesn't take separate descriptions.
      const displayOptions = q.options.map((o) =>
        o.description ? `${o.label} — ${o.description}` : o.label,
      );
      if (allowCustom) displayOptions.push(CUSTOM_OPTION_LABEL);

      const labelFor = (chosen: string): string => {
        const idx = displayOptions.indexOf(chosen);
        if (idx >= 0 && idx < baseOptions.length) return baseOptions[idx];
        return chosen;
      };

      const answers: string[] = [];

      if (q.multiple) {
        // Multi-select via repeated single-select. Add "(done)" each iteration.
        while (true) {
          const remaining = displayOptions.filter((o) => !answers.includes(labelFor(o)));
          if (remaining.length === 0) break;
          const selectable = answers.length > 0 ? [DONE_OPTION_LABEL, ...remaining] : remaining;
          const picked = await ctx.ui.select(`${q.question}${answers.length > 0 ? ` [selected: ${answers.join(", ")}]` : ""}`, selectable);
          if (picked === DONE_OPTION_LABEL || picked === null) break;
          if (picked === CUSTOM_OPTION_LABEL) {
            const free = await ctx.ui.input?.(`Type your answer for: ${q.header}`, "");
            if (free && free.trim()) answers.push(free.trim());
            continue;
          }
          answers.push(labelFor(picked));
          if (answers.length === q.options.length) break;
        }
      } else {
        const picked = await ctx.ui.select(q.question, displayOptions);
        if (picked === CUSTOM_OPTION_LABEL) {
          const free = await ctx.ui.input?.(`Type your answer for: ${q.header}`, "");
          if (free && free.trim()) answers.push(free.trim());
        } else if (picked !== null && picked !== undefined) {
          answers.push(labelFor(picked));
        }
      }

      allAnswers.push(answers);
    }

    // Format matches opencode's output text so skills that reference this
    // tool keep working without modification.
    const formatted = params.questions
      .map((q, i) =>
        `"${q.question}"="${allAnswers[i]?.length ? allAnswers[i].join(", ") : "Unanswered"}"`,
      )
      .join(", ");

    return {
      content: [
        {
          type: "text",
          text: `User has answered your questions: ${formatted}. You can now continue with the user's answers in mind.`,
        },
      ],
      details: { answers: allAnswers },
    };
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(questionTool);
}
