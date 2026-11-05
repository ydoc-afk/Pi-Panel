# Repositories

A project can hold several repositories, from GitHub and Forgejo together. They are managed in the
project's **Repository** tab, which replaces the separate GitHub and Forgejo tabs. Accounts (tokens)
are still connected in the GitHub and Forgejo pages of the main menu.

## Where they live

Each repository the tab clones goes into its own folder of the workspace, named after the repository
(`/workspace/hello`, then `/workspace/hello-2` if the name is taken). The agent is told these paths.

Projects that already had a repository keep it exactly where it was, at the workspace root
(`/workspace`). A repository added to such a project goes into a subfolder, and the panel adds that
folder to the root repository's local `.git/info/exclude` so committing the root repository never
sweeps the other one up. Nothing is moved.

## Included

Each repository has a checkbox, on by default. A ticked repository takes part in:

- **Pull all** and **Push all** (the buttons at the top). Pull is fast-forward only: a branch that
  has diverged is reported, never merged. Push all commits and pushes each repository's current
  branch. One repository failing does not stop the others, and the result is listed per repository.
- the agent's `push_to_repo` and `open_pull_request` tools. With one repository included, the agent
  needs no extra argument. With several, it passes `repo` (owner/name); without it the request is
  refused with the list. Naming an unticked repository is refused. The user still approves each
  push and pull request.

An unticked repository stays cloned and can still be pulled or pushed by hand from its own card.

**Remove** forgets a repository; its files stay in the workspace.

## Data

`project_repos` (migration 7): project, host, `owner/name`, folder (`''` is the root) and the
included flag. Existing projects get one row for their repository. `projects.repo` and
`repo_host` mirror the first row so lists and the dashboard keep working. The old
`/api/projects/:id/github` and `/forgejo` routes still work and act on the first repository.
