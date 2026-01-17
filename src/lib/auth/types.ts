/**
 * Authentication types - Clerk integration types
 */

export interface AuthenticatedUser {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  imageUrl?: string;
  metadata?: Record<string, unknown>;
}

export interface AuthContext {
  user: AuthenticatedUser | null;
  isAuthenticated: boolean;
  isLoaded: boolean;
}

/**
 * User context for services (future integration with Clerk)
 */
export interface UserContext {
  userId?: string;
  email?: string;
  plan?: string;
}
