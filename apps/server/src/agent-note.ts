/**
 * Context the panel gives the agent about its repositories. The agent runs in a sandbox that holds
 * no forge credentials on purpose, so it cannot push itself: it asks through push_to_repo and the
 * user approves in the panel. Without this note agents go looking for tokens and ask the user for one.
 */
export interface AgentRepo {
  repo: string;
  host: string | null;
  /** Relative to the workspace; '' is the workspace root. */
  folder: string;
  /** Whether the agent's push and pull request tools may use it. */
  included: boolean;
}

/**
 * repos is the project's repositories; a single "owner/name" string stands for one included
 * repository at the workspace root, which is how a project started out.
 */
export function agentNote(
  repos: AgentRepo[] | string | null,
  host: string | null,
  runtime: string | null = null,
): string | null {
  const list: AgentRepo[] =
    typeof repos === 'string' ? [{ repo: repos, host, folder: '', included: true }] : (repos ?? []);
  const parts = [
    list.length > 0 ? publishingNote(list) : null,
    runtime ? runtimeSection(runtime) : null,
  ];
  const text = parts.filter((p): p is string => p !== null).join('\n');
  return text === '' ? null : text;
}

/** Which toolchains the sandbox has, so the agent tests with them instead of assuming none exist. */
function runtimeSection(note: string): string {
  return `# Tools in this sandbox

${note}
`;
}

const forgeName = (host: string | null) => (host === 'forgejo' ? 'Forgejo' : 'GitHub');
const where = (r: AgentRepo) => (r.folder === '' ? '/workspace' : `/workspace/${r.folder}`);

function publishingNote(repos: AgentRepo[]): string {
  const included = repos.filter((r) => r.included);
  const forge = forgeName((included[0] ?? repos[0]!).host);
  const only = repos.length === 1 ? repos[0]! : null;
  const intro = only
    ? `This project is linked to the ${forgeName(only.host)} repository \`${only.repo}\`` +
      (only.folder === '' ? '.' : `, cloned in \`${where(only)}\`.`)
    : `This project has ${repos.length} repositories:

${repos
  .map(
    (r) =>
      `- \`${r.repo}\` (${forgeName(r.host)}) in \`${where(r)}\`: ${r.included ? 'included' : 'NOT included, do not push it'}`,
  )
  .join('\n')}

Only included repositories can be pushed or opened as pull requests. Run git inside the
repository's own folder.`;
  const repoArg =
    included.length > 1
      ? ' Several repositories are included, so also pass `repo` (owner/name) to say which one.'
      : '';
  return `# Publishing your work

${intro}

- Commit your work locally with git as usual.
- To publish it, call the \`push_to_repo\` tool with the branch (\`git branch --show-current\`).${repoArg} The
  panel asks the user to confirm, pushes from the host if they agree, and returns the result.
- To open a pull request, push the branch first, then call the \`open_pull_request\` tool with the
  branch, a title and a description. The user confirms and the panel opens it with its own account.
- Do not run \`git push\` and do not call the ${forge} API with curl or node (it answers 401).
  Do not ask the user for a token, password or other credentials: this sandbox has none by design,
  so that is not a missing setting. Use the two tools above. A push from here fails with "could not read Username".
- If the user declined, do not retry unless they ask. If it failed, report the error as it is.
`;
}
