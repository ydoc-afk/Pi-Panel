/** Badge colour and hint for each project status. */
export const PROJECT_STATUS: Record<string, { color: string; hint: string }> = {
  running: { color: 'teal', hint: 'The container is up; sessions can run' },
  creating: { color: 'blue', hint: 'The container is being created' },
  stopped: { color: 'orange', hint: 'The container is stopped. Start it to run sessions.' },
  missing: { color: 'red', hint: 'The container is gone. Start makes a new one; files are kept.' },
};
