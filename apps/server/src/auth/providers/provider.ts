/**
 * The seam between OpenPurpose and an external sign-in service (Supabase first). A provider
 * proves who someone is; what happens next (sign in, wait for approval, get a workspace) is
 * decided in service/signin.ts, the same for every provider.
 */
import type { AuthMethod, SignInErrorCode } from '@openpurpose/contracts';

/** Who the provider says this is. `subject` is the provider's stable user id. */
export interface ExternalIdentity {
  provider: string;
  subject: string;
  email: string | null;
  name: string | null;
}

export interface AuthProvider {
  /** The OPENPURPOSE_AUTH_PROVIDER value, e.g. 'supabase'. */
  id: string;
  /** What the sign-in page offers, e.g. a magic link and GitHub. */
  methods(): AuthMethod[];
  /**
   * Begin signing in. OAuth returns a `redirect`; a magic link sends an email. Both end on
   * `callbackUrl`. A `verifier` (PKCE) is kept in a cookie and handed back to finish(). A
   * `notice` goes to the server log only, never to the visitor.
   */
  start(input: {
    method: AuthMethod;
    email?: string;
    callbackUrl: string;
  }): Promise<{
    redirect?: string;
    emailSent?: boolean;
    verifier?: string;
    notice?: { level: 'info' | 'warn'; message: string };
  }>;
  /** Turn the callback's query string into an identity. Throws a SignInError when it can't. */
  finish(input: { query: Record<string, string>; verifier?: string }): Promise<ExternalIdentity>;
}

/** Sends the person back to /sign-in?error=<reason>, with `message` in the server log. */
export class SignInError extends Error {
  constructor(
    readonly reason: SignInErrorCode,
    message: string,
  ) {
    super(message);
  }
}
