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
  branch: string;
  message?: string;
}

export interface PushOutcome {
  repo: string | null;
  branch: string;
  commit: string;
  committed: boolean;
}

/** What the session manager needs from the GitHub/Forgejo services. */
export interface ForgePusher {
  /** Name of the forge and repository the project is linked to, or null when it has none. */
  link(projectId: number): { forge: 'GitHub' | 'Forgejo'; repo: string } | null;
  push(projectId: number, request: PushRequest): Promise<PushOutcome>;
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
  const { branch, message } = data as { branch?: unknown; message?: unknown };
  if (typeof branch !== 'string' || !branch || branch.length > 200) return null;
  if (message !== undefined && (typeof message !== 'string' || message.length > 5000)) return null;
  return { branch, ...(message ? { message } : {}) };
}

/** The sentence the user is asked to approve, built only from the panel's own knowledge. */
export function describePush(forge: string, repo: string, request: PushRequest): string {
  const note = request.message
    ? ` Uncommitted changes are committed first with the message "${request.message.replace(/\s+/g, ' ').slice(0, 200)}".`
    : ' Uncommitted changes, if any, are committed first.';
  return `The agent asks to push branch "${request.branch}" to ${forge} repository ${repo}.${note}`;
}
