import type { AuthUser } from '../env';

/**
 * Who may see a row owned by a coworker: a coworker sees their own, a team lead sees their crew,
 * office and admin see all. `column` is the owner column with its table alias, e.g. `l.coworker_id`.
 * Returns an SQL condition and the values for its placeholders.
 */
export function staffScope(u: Pick<AuthUser, 'id' | 'role' | 'crew_id'>, column: string): [string, unknown[]] {
  if (u.role === 'coworker') return [`${column} = ?`, [u.id]];
  if (u.role === 'lead') return [`(${column} = ? OR ${column} IN (SELECT id FROM users WHERE crew_id = ?))`, [u.id, u.crew_id]];
  return ['1 = 1', []];
}
