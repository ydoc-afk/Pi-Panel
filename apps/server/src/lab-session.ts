/**
 * The package lab's dedicated design session: a pi session the Lab tab owns, told how to build
 * packages (extensions, skills, prompts, themes) and given a lab_run tool to test them. The tool
 * asks pi for an input dialog with a reserved title; the panel runs the lab and answers it, so the
 * agent gets pi's own load report and tool test results without the lab being reachable from the
 * sandbox. Lab runs are throwaway containers with no network and no credentials, so they need no
 * confirmation from the user.
 */

/** Title of the reserved dialog the lab_run tool uses. */
export const LAB_DIALOG_TITLE = '@pi-panel/lab-run';

/** Longest reply the agent gets back; the rest is cut so a verbose report cannot flood its context. */
export const LAB_REPLY_MAX_CHARS = 30_000;

export interface LabRunRequest {
  path: string;
  tests?: unknown;
}

export function parseLabRunRequest(raw: unknown): LabRunRequest | null {
  if (typeof raw !== 'string' || raw.length > 200_000) return null;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!data || typeof data !== 'object') return null;
  const { path, tests } = data as { path?: unknown; tests?: unknown };
  if (typeof path !== 'string' || !path) return null;
  return { path, ...(tests === undefined ? {} : { tests }) };
}

/** Instructions appended to the lab session's system prompt. */
export function labSessionNote(docsDir: string): string {
  return `# You are the package lab designer

You design and test pi packages for this project: extensions (new tools and commands), skills,
prompt templates and themes. Work inside /workspace/lab/<package-name>/. The user watches the lab
tab and decides what to keep, so explain what you build and why.

## How to work

1. Read the relevant pi docs before writing code. They are on this machine:
   - ${docsDir}/extensions.md (tools, commands, events)
   - ${docsDir}/skills.md (SKILL.md format)
   - ${docsDir}/prompt-templates.md, ${docsDir}/themes.md
   - ${docsDir}/packages.md (package.json and the "pi" manifest)
2. Create the package: a package.json with the "pi-package" keyword and a "pi" manifest listing its
   extensions, skills, prompts and themes, plus the files themselves. Keep it small and focused.
3. Test it with the lab_run tool, passing the package path (for example "lab/my-tool") and, for
   extensions, tool tests: [{ "tool": "name", "input": {...}, "expectContains": "text" }]. Use
   "expectError": true for a call that should fail. Read the whole report: extensions that failed
   to load, skills pi rejected, and each test result.
4. Fix what the report shows and run again until it is clean. Say plainly what you tested and what
   you could not.

## Rules of the lab

- A lab run has no network and no credentials, and nothing is installed during it: a package must
  bundle its own dependencies or use only Node built-ins and what pi provides.
- A passing run means the package loads and its tests pass. It is not a security review; do not
  claim it is. Never put secrets in a package.
- Tool input schemas matter: describe every parameter, because another model will read them.
- A skill needs a "description" that says when to use it; without one pi will not load it.
- You cannot publish or install packages from here. When a package is ready, tell the user where it
  is (lab/<name>) so they can review it and publish it to npm.
`;
}
