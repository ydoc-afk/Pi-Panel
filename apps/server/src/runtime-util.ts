import type { ContainerRuntime, ExecSpec } from './runtime.js';

export interface ExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const MAX_OUTPUT = 1024 * 1024;

/** Runs a command in a container to completion, collecting (capped) output. Kills it on timeout. */
export async function runToCompletion(
  runtime: ContainerRuntime,
  containerId: string,
  spec: ExecSpec,
  timeoutMs: number,
): Promise<ExecResult> {
  const proc = await runtime.exec(containerId, spec);
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    proc.onStdout((c) => {
      if (stdout.length < MAX_OUTPUT) stdout += c.toString();
    });
    proc.onStderr((c) => {
      if (stderr.length < MAX_OUTPUT) stderr += c.toString();
    });
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, timeoutMs);
    proc.onExit((code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}
