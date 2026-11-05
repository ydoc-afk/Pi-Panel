/**
 * Lets an agent ask to publish its work without ever holding a credential.
 *
 * The agent's push_to_repo tool (assets/panel-forge.js) asks pi for an input dialog with a reserved
 * title. The session manager recognises it, shows the user a confirmation the panel wrote itself,
 * pushes from the host only after the user says yes, and answers the dialog with the outcome. The
 * dialog text never comes from the agent, so it cannot dress a push up as something else.
 */

/** Title of the reserved dialog; the request travels as JSON in the placeholder. */
export const PUSH_DIALOG_TITLE = '@pi-panel/push';

export interface PushRequest {
  /** owner/name, needed only when several repositories are included. */
  repo?: string;
  branch: string;
  message?: string;
}

export interface PushOutcome {
  repo: string | null;
  branch: string;
  commit: string;
  committed: boolean;
}

/** Title of the reserved pull request dialog; same mechanism as the push dialog. */
export const PR_DIALOG_TITLE = '@pi-panel/pull-request';

export interface PullRequestRequest {
  /** owner/name, needed only when several repositories are included. */
  repo?: string;
  /** Branch with the changes; it must already be pushed. */
  head: string;
  title: string;
  body?: string;
  /** Branch to merge into; the repository's default branch when omitted. */
  base?: string;
}

export interface PullRequestOutcome {
  url: string;
  number: number | null;
  base: string;
  head: string;
}

/** What the session manager needs from the GitHub/Forgejo services. */
export interface ForgePusher {
  /**
   * The forge and repository a request means: the one it names, or the only included one. null when
   * the project has none; throws an Error with a message for the agent when the request is
   * ambiguous or names a repository that is not included.
   */
  link(projectId: number, repo?: string): { forge: 'GitHub' | 'Forgejo'; repo: string } | null;
  push(projectId: number, request: PushRequest): Promise<PushOutcome>;
  /** Opens a pull request with the account's token, which the agent never sees. */
  pullRequest?(projectId: number, request: PullRequestRequest): Promise<PullRequestOutcome>;
}

/** Validates the JSON an agent put in the dialog placeholder. */
export function parsePushRequest(raw: unknown): PushRequest | null {
  if (typeof raw !== 'string' || raw.length > 10_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { branch, message, repo } = data as {
    branch?: unknown;
    message?: unknown;
    repo?: unknown;
  };
  if (typeof branch !== 'string' || !branch || branch.length > 200) return null;
  if (message !== undefined && (typeof message !== 'string' || message.length > 5000)) return null;
  if (repo !== undefined && (typeof repo !== 'string' || repo.length > 200)) return null;
  return { branch, ...(message ? { message } : {}), ...(repo ? { repo } : {}) };
}

/** The sentence the user is asked to approve, built only from the panel's own knowledge. */
export function describePush(forge: string, repo: string, request: PushRequest): string {
  const note = request.message
    ? ` Uncommitted changes are committed first with the message "${request.message.replace(/\s+/g, ' ').slice(0, 200)}".`
    : ' Uncommitted changes, if any, are committed first.';
  return `The agent asks to push branch "${request.branch}" to ${forge} repository ${repo}.${note}`;
}

/** Validates the JSON an agent put in the pull request dialog placeholder. */
export function parsePullRequestRequest(raw: unknown): PullRequestRequest | null {
  if (typeof raw !== 'string' || raw.length > 100_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { head, title, body, base, repo } = data as Record<string, unknown>;
  if (typeof head !== 'string' || !head || head.length > 200) return null;
  if (typeof title !== 'string' || !title.trim() || title.length > 256) return null;
  if (body !== undefined && (typeof body !== 'string' || body.length > 65_536)) return null;
  if (base !== undefined && (typeof base !== 'string' || base.length > 200)) return null;
  if (repo !== undefined && (typeof repo !== 'string' || repo.length > 200)) return null;
  return {
    head,
    title,
    ...(body ? { body } : {}),
    ...(base ? { base } : {}),
    ...(repo ? { repo } : {}),
  };
}

/** The sentence the user is asked to approve for a pull request. */
export function describePullRequest(
  forge: string,
  repo: string,
  request: PullRequestRequest,
): string {
  const title = request.title.replace(/\s+/g, ' ').slice(0, 200);
  const base = request.base ? `"${request.base.slice(0, 200)}"` : 'the default branch';
  return `The agent asks to open a pull request on ${forge} repository ${repo}: "${title}", from branch "${request.head}" into ${base}.`;
}
