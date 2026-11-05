// pi extension the panel installs in a project's agent dir when the project is linked to a GitHub or
// Forgejo repository. The sandbox holds no credentials, so push_to_repo does not push: it asks pi for
// an input dialog with a reserved title, the panel turns that into a confirmation for the user, and
// pushes from the host once they agree. The answer to the dialog is the outcome.
import { Type } from 'typebox';

const PUSH_DIALOG_TITLE = '@pi-panel/push';

export default function (pi) {
  pi.registerTool({
    name: 'push_to_repo',
    label: 'Push to repository',
    description:
      "Publish your committed work to this project's linked GitHub or Forgejo repository. " +
      'The user is shown a confirmation and the push runs only if they approve it; you never handle ' +
      'credentials. Commit your changes first (uncommitted changes are committed for you with the ' +
      'message, if given). Never run git push yourself: this sandbox has no credentials.',
    parameters: Type.Object({
      branch: Type.String({
        description: 'Branch to push, usually the output of `git branch --show-current`.',
      }),
      message: Type.Optional(
        Type.String({ description: 'Commit message for any uncommitted changes.' }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!ctx?.hasUI) {
        throw new Error('No user interface is attached, so the push cannot be confirmed.');
      }
      const request = {
        branch: params.branch,
        ...(params.message ? { message: params.message } : {}),
      };
      const answer = await ctx.ui.input(PUSH_DIALOG_TITLE, JSON.stringify(request));
      if (answer === undefined) {
        return {
          content: [
            { type: 'text', text: 'The user declined the push. Do not retry unless asked.' },
          ],
          details: { declined: true },
        };
      }
      let result;
      try {
        result = JSON.parse(answer);
      } catch {
        throw new Error('The panel sent an unexpected reply.');
      }
      if (!result.ok) throw new Error(`Push failed: ${result.error}`);
      const commit = String(result.commit ?? '').slice(0, 7);
      return {
        content: [
          {
            type: 'text',
            text:
              `Pushed branch "${result.branch}" to ${result.repo} at ${commit}` +
              (result.committed ? ' (uncommitted changes were committed first).' : '.'),
          },
        ],
        details: result,
      };
    },
  });
}
