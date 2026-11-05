import { useState } from 'react';
import type { Task } from './transcript.js';

const MARK = { completed: '✓', in_progress: '▶', pending: '○' } as const;

/**
 * The agent's todo list, kept from the newest todo tool result. Shown above the prompt like the
 * terminal widget the todo extension draws in pi's own UI, which RPC mode cannot carry.
 */
export function TaskList({
  tasks,
  colors,
}: {
  tasks: Task[];
  colors: { fg: string; dim: string; accent: string; ok: string; border: string };
}) {
  const [open, setOpen] = useState(true);
  if (!tasks.length) return null;
  const done = tasks.filter((t) => t.status === 'completed').length;
  const color = (t: Task) =>
    t.status === 'completed' ? colors.ok : t.status === 'in_progress' ? colors.accent : colors.dim;
  return (
    <div
      aria-label="Todo list"
      style={{
        margin: '8px 0 4px 12px',
        padding: '4px 10px',
        borderLeft: `2px solid ${colors.border}`,
        fontSize: 12.5,
      }}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        style={{
          all: 'unset',
          cursor: 'pointer',
          color: colors.fg,
          fontWeight: 600,
        }}
      >
        {open ? '▾' : '▸'} Tasks {done}/{tasks.length}
      </button>
      {open &&
        tasks.map((t) => (
          <div
            key={t.id}
            style={{
              color: color(t),
              textDecoration: t.status === 'completed' ? 'line-through' : undefined,
              opacity: t.status === 'completed' ? 0.7 : 1,
            }}
          >
            {MARK[t.status]} {t.status === 'in_progress' && t.activeForm ? t.activeForm : t.subject}
          </div>
        ))}
    </div>
  );
}
