// pi extension the panel installs for the package lab's design session. lab_run does not run
// anything itself: it asks pi for an input dialog with a reserved title, and the panel runs the lab
// (a throwaway container with no network and no credentials) and answers with pi's own report.
// The tool only exists when PI_PANEL_SESSION_KIND is "lab", so other sessions of the project never
// see it.
/* global process */
import { Type } from 'typebox';

const LAB_DIALOG_TITLE = '@pi-panel/lab-run';

export default function (pi) {
  if (process.env.PI_PANEL_SESSION_KIND !== 'lab') return;
  pi.registerTool({
    name: 'lab_run',
    label: 'Run in lab',
    description:
      'Load a package from the workspace in the package lab with the real pi, and run tool tests ' +
      'against it. Returns what loaded and what failed: extensions, tools, commands, skills, prompts, ' +
      'themes, pi diagnostics, and a result for each test. The lab has no network and installs ' +
      'nothing, so the package must bundle its dependencies. Use it after every change.',
    parameters: Type.Object({
      path: Type.String({
        description: 'Package directory relative to /workspace, for example lab/my-tool.',
      }),
      tests: Type.Optional(
        Type.Array(
          Type.Object({
            tool: Type.String({ description: 'Name of a tool the package registers.' }),
            input: Type.Record(Type.String(), Type.Any(), {
              description: 'The arguments to call the tool with.',
            }),
            expectContains: Type.Optional(
              Type.String({ description: 'Text the tool output must contain.' }),
            ),
            expectError: Type.Optional(
              Type.Boolean({ description: 'True when the call is expected to fail.' }),
            ),
          }),
          { description: 'Up to 20 tool tests.', maxItems: 20 },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx?.hasUI) throw new Error('No panel is attached, so the lab cannot be run.');
      const request = { path: params.path, ...(params.tests ? { tests: params.tests } : {}) };
      const answer = await ctx.ui.input(LAB_DIALOG_TITLE, JSON.stringify(request));
      if (answer === undefined) throw new Error('The lab run was cancelled.');
      let result;
      try {
        result = JSON.parse(answer);
      } catch {
        // The panel cuts long reports; the text is still readable.
        return { content: [{ type: 'text', text: String(answer) }], details: {} };
      }
      if (result.ok === false) throw new Error(`Lab run failed: ${result.error}`);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        details: result,
      };
    },
  });
}
