export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AUTH_LIMITER?: RateLimit;
  API_LIMITER?: RateLimit;

  ENVIRONMENT: 'development' | 'staging' | 'production';
  PUBLIC_BASE_URL: string;
  APNS_TOPIC: string;
  APNS_ENV: 'sandbox' | 'production';
  EMAIL_FROM: string;
  APP_STORE_URL?: string; // unlisted App Store link sent to new customers

  JWT_SECRET: string;
  // Optional dedicated keys. Each falls back to JWT_SECRET so existing signed URLs and pulse hashes keep working.
  FILE_SIGNING_SECRET?: string;
  PULSE_HASH_SECRET?: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
  ANDROID_CERT_SHA256?: string;

  // The owner account. Kept as a secret so the address never lives in the repo. Unset = no owner bootstrap.
  MASTER_EMAIL?: string;

  // Email over SMTP (ports 465 or 587; Workers cannot use 25). Unset = fall back to Resend, then to a logged no-op.
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
}

export type Role = 'customer' | 'coworker' | 'lead' | 'office' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
  locale: 'en' | 'es';
  crew_id: string | null;
  /** Trust level of this session: 1 = proved the mailbox only, 2 = also proved the password. */
  aal: 1 | 2;
}

/** Two sign-in steps. See migration 0004. */
export type AssuranceLevel = 1 | 2;

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser; requestId: string } };

// Role groups used by route guards.
export const STAFF: Role[] = ['coworker', 'lead', 'office', 'admin'];
export const MANAGERS: Role[] = ['lead', 'admin'];
export const BACKOFFICE: Role[] = ['office', 'admin'];
