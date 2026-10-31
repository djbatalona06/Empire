import type { Env } from '../env';

// One secret should do one job. The dedicated keys are optional; until they are set, JWT_SECRET is used so
// nothing already signed or hashed stops working.
export const fileSecret = (env: Env) => env.FILE_SIGNING_SECRET || env.JWT_SECRET;
export const pulseSecret = (env: Env) => env.PULSE_HASH_SECRET || env.JWT_SECRET;

const MIN_SECRET_LENGTH = 32;

/** Returns a plain-English problem with the configuration, or null when the Worker is safe to serve traffic. */
export function configProblem(env: Env): string | null {
  if (!env.JWT_SECRET || env.JWT_SECRET.length < MIN_SECRET_LENGTH) return `JWT_SECRET must be set and at least ${MIN_SECRET_LENGTH} characters`;
  for (const [name, value] of [['FILE_SIGNING_SECRET', env.FILE_SIGNING_SECRET], ['PULSE_HASH_SECRET', env.PULSE_HASH_SECRET]] as const) {
    if (value && value.length < MIN_SECRET_LENGTH) return `${name} must be at least ${MIN_SECRET_LENGTH} characters when set`;
  }
  return null;
}

/**
 * The sign-in shortcut that hands the magic-link token straight back in the response is for local work only.
 * It needs BOTH the development setting and a localhost address, so a deploy that forgot `--env` cannot enable it.
 */
export const devLoginAllowed = (env: Env) => env.ENVIRONMENT === 'development' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(env.PUBLIC_BASE_URL);
