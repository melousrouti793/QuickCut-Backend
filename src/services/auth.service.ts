/**
 * Authentication and Authorization service
 * Handles user authentication and permission checks
 */

import { APIGatewayProxyEventV2 } from 'aws-lambda';
import { AuthContext } from '../types';
import { AuthenticationError, AuthorizationError } from '../errors/AppError';
import { logger } from '../utils/logger';

export class AuthService {
  /**
   * Extract and validate authentication context from API Gateway event
   * Assumes API Gateway has an authorizer that populates authorizer context
   */
  extractAuthContext(event: APIGatewayProxyEventV2): AuthContext {
    // API Gateway authorizer should populate requestContext.authorizer
    const authorizer = (event.requestContext as any)?.authorizer;

    if (!authorizer) {
      logger.warn('No authorizer context found in request');
      throw new AuthenticationError('Authentication required');
    }

    // Lambda authorizer typically populates these fields
    // Adjust based on your actual authorizer implementation
    const userId = this.extractClaim(authorizer, 'userId');
    const email = this.extractClaim(authorizer, 'email', false);

    if (!userId) {
      logger.warn('No userId found in authorizer context');
      throw new AuthenticationError('Invalid authentication token');
    }

    const claims: Record<string, string> = {};

    // Extract additional claims if present
    if (authorizer.claims && typeof authorizer.claims === 'object') {
      Object.entries(authorizer.claims).forEach(([key, value]) => {
        if (typeof value === 'string') {
          claims[key] = value;
        }
      });
    }

    const authContext: AuthContext = {
      userId,
      email: email || undefined,
      claims: Object.keys(claims).length > 0 ? claims : undefined,
    };

    logger.info('Authentication context extracted', { userId: authContext.userId });

    return authContext;
  }

  /**
   * Extract a claim from authorizer context
   */
  private extractClaim(
    authorizer: Record<string, unknown>,
    claimName: string,
    required: boolean = true
  ): string | null {
    // Try different possible locations for the claim
    let value: unknown = authorizer[claimName];

    // Also check in lambda.claims for Lambda authorizer
    if (!value && authorizer.lambda && typeof authorizer.lambda === 'object') {
      const lambda = authorizer.lambda as Record<string, unknown>;
      value = lambda[claimName];
    }

    // Check in jwt.claims for JWT authorizer
    if (!value && authorizer.jwt && typeof authorizer.jwt === 'object') {
      const jwt = authorizer.jwt as Record<string, unknown>;
      if (jwt.claims && typeof jwt.claims === 'object') {
        const claims = jwt.claims as Record<string, unknown>;
        value = claims[claimName];
      }
    }

    if (!value && required) {
      throw new AuthenticationError(`Required claim '${claimName}' not found in authorization context`);
    }

    return typeof value === 'string' ? value : null;
  }

  /**
   * Authorize user for upload operation
   * This is where you'd implement business logic for authorization
   * For example, checking if user has sufficient quota, is not banned, etc.
   */
  async authorizeUpload(authContext: AuthContext, fileCount: number): Promise<void> {
    // Example authorization checks (implement based on your requirements)

    logger.info('Authorizing upload', {
      userId: authContext.userId,
      fileCount,
    });

    // Example: Check if user has a specific role/permission
    // if (!this.hasPermission(authContext, 'upload:create')) {
    //   throw new AuthorizationError('User does not have upload permission');
    // }

    // Example: Check if user account is active
    // const isActive = await this.isUserActive(authContext.userId);
    // if (!isActive) {
    //   throw new AuthorizationError('User account is not active');
    // }

    // Example: Check user quota (would typically involve a database call)
    // const hasQuota = await this.checkUserQuota(authContext.userId, fileCount);
    // if (!hasQuota) {
    //   throw new AuthorizationError('User has exceeded upload quota');
    // }

    logger.info('Upload authorized', { userId: authContext.userId });
  }

  /**
   * Check if user has a specific permission
   * Currently unused but kept for future implementation
   */
  // private hasPermission(authContext: AuthContext, permission: string): boolean {
  //   // This would typically check against a role/permission system
  //   // For now, we'll do a simple check in claims
  //   const permissions = authContext.claims?.permissions;
  //   if (!permissions) return false;

  //   const permissionList = permissions.split(',').map(p => p.trim());
  //   return permissionList.includes(permission);
  // }

  /**
   * Validate that the user owns the resource (for future operations like complete/abort)
   * This would be used when completing or aborting uploads
   */
  validateResourceOwnership(authContext: AuthContext, resourceUserId: string): void {
    if (authContext.userId !== resourceUserId) {
      logger.warn('Resource ownership validation failed', {
        userId: authContext.userId,
        resourceUserId,
      });
      throw new AuthorizationError('You do not have permission to access this resource');
    }
  }
}

// Export singleton instance
export const authService = new AuthService();
