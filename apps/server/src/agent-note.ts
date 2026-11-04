/**
 * Context the panel gives the agent about its repository. The agent runs in a sandbox that holds
 * no forge credentials on purpose, so it cannot push itself: it asks through push_to_repo and the
 * user approves in the panel. Without this note agents go looking for tokens and ask the user for one.
 */
export function agentNote(repo: string | null, host: string | null): string | null {
  if (!repo) return null;
  const forge = host === 'forgejo' ? 'Forgejo' : 'GitHub';
  return `# Publishing your work

This project is linked to the ${forge} repository \`${repo}\`.

- Commit your work locally with git as usual.
- To publish it, call the \`push_to_repo\` tool with the branch (\`git branch --show-current\`). The
  panel asks the user to confirm, pushes from the host if they agree, and returns the result.
- Do not run \`git push\`, and do not ask the user for a token, password or other credentials.
  This sandbox has none by design. A push from here fails with "could not read Username".
- If the user declined, do not retry unless they ask. If it failed, report the error as it is.
`;
}
