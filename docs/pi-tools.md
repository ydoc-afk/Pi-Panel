# pi's controls in the panel

## Thinking level, compaction and token use

Above each session's terminal:

- **Context meter and token use.** Context used out of the model's window, plus tokens and cost for
  the session; hover for input/output/cache and tool calls. It refreshes when a turn starts or ends.
  The window comes from pi's model data: for providers added by hand it may be unknown, and the meter
  then shows tokens without a percentage.
- **Thinking level** (off to max, as many as the model supports; a model without reasoning only offers
  off). Changing it applies at once.
- **Auto-compact** switch and **Compact now** (with optional "what to keep" instructions). Compaction
  is a model call that summarises older messages, so it can take a minute.

The thinking level and auto-compaction choice are remembered for the session
(`sessions.thinking_level`, `auto_compaction`) and sent to pi again whenever its process restarts,
for example after a package change. A level the model does not offer is ignored by pi, and the header
shows what pi actually uses. A session that is not running yet shows the choices that will be applied
when it starts; the panel never starts pi just to read these.

API: `GET /api/sessions/:id/pi`, `POST /api/sessions/:id/thinking {level}`,
`/auto-compaction {enabled}`, `/compact {instructions?}`.

## Package sets

On a project's **Packages** tab, **Save current packages as a set** records the npm packages the
project uses, at their exact versions (anything not pinned is left out and counted). A set can be
applied to any other project. Applying shows the review for every package it would add (publisher,
license, install scripts, warnings, link to the files) and installs nothing until you approve the
whole list, so a set never installs anything unreviewed. A package the project already has at a
different version is left alone and flagged. Sets are shared by all projects (`package_sets`,
migration 9).

Not built: installing a set automatically into new projects. That would install code nobody reviewed.

API: `GET/POST /api/package-sets`, `PUT/DELETE /api/package-sets/:id`,
`GET /api/projects/:id/package-sets` (each set with what it would add to that project).

## The lab's design session

The **Lab** tab opens a pi session of its own ("Design with pi"). It is told how to build packages
under `lab/<name>`, to read pi's documentation in the sandbox image first, and to test with a
`lab_run` tool. `lab_run` runs the package lab (a throwaway container with no network and no
credentials) and returns pi's own report: what loaded, what failed, and each tool test. The tool
exists only in this session (`PI_PANEL_SESSION_KIND=lab`), and the panel refuses lab runs from other
sessions. Lab runs need no confirmation because they cannot reach the network or any credential;
reports are cut at 30,000 characters.

The session uses the project's default model, keeps its transcript, and is left out of the Sessions
list. When it finishes a turn the lab's package list rescans. **Start a new design session** deletes
the old transcript; packages written to `lab/` stay.

Getting a finished package into a project is still manual: the lab does not install packages, and
package installs accept npm sources only. Publish it, then add it on the Packages tab.
