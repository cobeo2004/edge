/**
 * Result of an authentication verification attempt.
 */
export interface AuthResult {
  /** Whether the credentials are valid */
  valid: boolean;
  /** Decoded claims/payload from the credentials (e.g., JWT claims) */
  claims?: Record<string, unknown>;
  /** Error message if verification failed */
  error?: string;
}

/**
 * Pluggable authentication strategy interface.
 * Implement this to provide custom authentication (JWT, API keys, OAuth, etc.)
 */
export interface AuthStrategy {
  /** Extract credentials (token, key, etc.) from the incoming request */
  extractCredentials(request: Request): Promise<string | null>;
  /** Verify the extracted credentials and return the result */
  verify(credentials: string): Promise<AuthResult>;
}
