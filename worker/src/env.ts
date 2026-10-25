export interface Env {
  DB: D1Database;
  FILES: R2Bucket;
  AUTH_LIMITER?: RateLimit;

  ENVIRONMENT: 'development' | 'staging' | 'production';
  PUBLIC_BASE_URL: string;
  APNS_TOPIC: string;
  APNS_ENV: 'sandbox' | 'production';
  EMAIL_FROM: string;
  APP_STORE_URL?: string; // unlisted App Store link sent to new customers

  JWT_SECRET: string;
  RESEND_API_KEY?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_PUBLISHABLE_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  APNS_KEY_P8?: string;
  APNS_KEY_ID?: string;
  APNS_TEAM_ID?: string;
}

export type Role = 'customer' | 'coworker' | 'lead' | 'office' | 'admin';

export interface AuthUser {
  id: string;
  role: Role;
  locale: 'en' | 'es';
  crew_id: string | null;
}

export type AppEnv = { Bindings: Env; Variables: { user: AuthUser } };

// Role groups used by route guards.
export const STAFF: Role[] = ['coworker', 'lead', 'office', 'admin'];
export const MANAGERS: Role[] = ['lead', 'admin'];
export const BACKOFFICE: Role[] = ['office', 'admin'];
