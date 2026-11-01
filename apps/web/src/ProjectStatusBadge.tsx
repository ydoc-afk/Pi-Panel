import { PROJECT_STATUS } from './projectStatus.js';
import { StatusBadge, Tip } from './ui.js';

/** A project's status, coloured and explained the same way everywhere. */
export function ProjectStatusBadge({ status }: { status: string }) {
  const s = PROJECT_STATUS[status];
  return (
    <Tip label={s?.hint ?? status}>
      <StatusBadge status={status} color={s?.color} />
    </Tip>
  );
}
