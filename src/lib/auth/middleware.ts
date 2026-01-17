/**
 * Authentication middleware - Route protection utilities
 * 
 * This file provides middleware helpers for protecting routes with Clerk.
 * Currently a placeholder structure for future Clerk integration.
 */

import type { NextRequest } from "next/server";
import type { AuthenticatedUser } from "./types";

/**
 * Get authenticated user from request
 * 
 * Future implementation will use Clerk's getAuth() helper
 * @example
 * // Future implementation:
 * // import { auth } from "@clerk/nextjs/server";
 * // const { userId } = await auth();
 * // return userId ? { id: userId } : null;
 */
export async function getAuthenticatedUser(request: NextRequest): Promise<AuthenticatedUser | null> {
  // TODO: Implement with Clerk
  // const { userId } = await auth();
  // if (!userId) return null;
  // const user = await clerkClient.users.getUser(userId);
  // return { id: userId, email: user.emailAddresses[0]?.emailAddress };
  return null;
}

/**
 * Require authentication - throws error if not authenticated
 */
export async function requireAuth(request: NextRequest): Promise<AuthenticatedUser> {
  const user = await getAuthenticatedUser(request);
  if (!user) {
    throw new Error("Authentication required");
  }
  return user;
}

/**
 * Optional authentication - returns user if authenticated, null otherwise
 */
export async function optionalAuth(request: NextRequest): Promise<AuthenticatedUser | null> {
  return await getAuthenticatedUser(request);
}
