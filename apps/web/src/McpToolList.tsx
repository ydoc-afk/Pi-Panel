import type { McpTool } from './api.js';

/** A checkbox per tool: checked means the model can use it, unchecked hides it. */
export function McpToolList({
  tools,
  hidden,
  disabled,
  onChange,
}: {
  tools: McpTool[];
  hidden: string[];
  disabled?: boolean;
  onChange: (hidden: string[]) => void;
}) {
  const hiddenSet = new Set(hidden);
  const toggle = (name: string, visible: boolean) => {
    const next = new Set(hiddenSet);
    if (visible) next.delete(name);
    else next.add(name);
    onChange([...next]);
  };
  return (
    <ul style={{ listStyle: 'none', paddingLeft: 0, display: 'grid', gap: 4, margin: '6px 0' }}>
      {tools.map((t) => (
        <li key={t.name}>
          <label>
            <input
              type="checkbox"
              disabled={disabled}
              checked={!hiddenSet.has(t.name)}
              onChange={(e) => toggle(t.name, e.target.checked)}
            />{' '}
            <code>{t.name}</code>
            {t.annotations.destructiveHint && (
              <small style={{ color: 'crimson' }}> destructive</small>
            )}
            {t.annotations.readOnlyHint && <small style={{ color: 'seagreen' }}> read-only</small>}
            {t.description && <small> &mdash; {t.description}</small>}
          </label>
        </li>
      ))}
    </ul>
  );
}
