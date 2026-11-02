/**
 * Context the panel gives the agent about its repository. The agent runs in a sandbox that holds
 * no forge credentials on purpose, so it cannot push; the user pushes from the panel. Without
 * this note agents go looking for tokens and then ask the user for one.
 */
export function agentNote(repo: string | null, host: string | null): string | null {
  if (!repo) return null;
  const forge = host === 'forgejo' ? 'Forgejo' : 'GitHub';
  return `# Pushing your work

This project is linked to the ${forge} repository \`${repo}\`.

- Commit your work locally with git as usual.
- Do not run \`git push\`, and do not ask the user for a token, password or other credentials.
  This sandbox has none by design. A push from here fails with "could not read Username".
- The user publishes from the panel: the project's ${forge} tab has a Push button that commits and
  pushes from the host, where the credentials are kept. When your work is committed, tell the
  user which branch to push.
`;
}
