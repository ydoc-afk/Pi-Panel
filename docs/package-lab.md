# Package lab

The lab is where you build and test pi packages (extensions, skills, prompts and themes) before using
them. A draft package is a directory in a project's workspace, usually `lab/<name>`.

## Workflow

1. **Create a starter package** (UI: Package lab). Pick any mix of extension, skill, prompt and theme;
   the scaffolder writes a valid `package.json` (with the `pi-package` keyword and a `pi` manifest) and a
   template for each kind. Agents in a session can also write packages anywhere in the workspace.
2. **Add tool tests.** Each test names a tool, gives a JSON input, and optionally expects the output to
   contain some text, or expects an error.
3. **Run in lab.** The panel copies the package into a new throwaway container, loads it with the real
   pi SDK, runs the tool tests, and returns a structured report.

## What the report contains

Everything comes from pi itself, so the rules match what a real session would apply:

- extensions that loaded, and extensions that failed with pi's own error and file:line
- registered tools (with their parameter schema) and commands
- skills, prompts and themes that loaded, plus pi's diagnostics for ones that did not
  (for example "description is required" for a skill)
- per-test results: `passed`, `tool-error`, `threw`, `invalid-input`, `not-found` or `timeout`

pi's tool wrapper does not validate arguments, so the harness validates each test input against the
tool's schema first, as the agent loop does for model calls. No model and no credentials are involved.

## Isolation

Each run uses a fresh container from the sandbox image with **no network**, **no credentials**, a
1 GB memory limit, one CPU, 256 processes, all capabilities dropped and `no-new-privileges`. Nothing is
bind-mounted: the package is copied in as a tar archive, so the container cannot touch the workspace
and nothing persists. Runs are limited to one per project and two at a time overall, with a 90 s timeout.

What is copied: regular files only. Symlinks, `node_modules`, `.git`, files over 2 MB and anything past
2000 files / 10 MB are skipped or refused, and the report lists what was skipped. The workspace is
agent-controlled, so the panel never follows symlinks and refuses paths that leave the workspace.

## What a pass means

A pass is a functional result for a human to read, **not a security attestation**. The package's code
runs in the same process as the harness and could influence the report. Review the source before
trusting a package, and do not treat a green lab run as approval.

Packages that need npm dependencies must bundle them: nothing is installed during a lab run.

## Developing against the real SDK

Most tests use a fake runtime. `apps/server/src/lab-real-pi.test.ts` runs the same harness against the
real pi SDK (only Docker is faked) and is skipped unless you point it at an install:

```bash
mkdir /tmp/pi && cd /tmp/pi && npm init -y && npm install --ignore-scripts @earendil-works/pi-coding-agent
PI_SDK_ENTRY=/tmp/pi/node_modules/@earendil-works/pi-coding-agent/dist/index.js npm test
```

The theme template in `lab-theme-template.ts` is derived from pi's built-in dark theme
(MIT, Copyright (c) 2025 Mario Zechner).
