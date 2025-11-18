/**
 * Main entry point
 * Exports Lambda handler with routing
 */

// Primary Lambda handler export (for API Gateway)
export { handler } from './handlers/router.handler';

// Individual handler exports (for testing or direct invocation)
export { handler as uploadHandler } from './handlers/upload.handler';
export { handler as completeHandler } from './handlers/complete.handler';

// Export types for potential client SDK generation
export * from './types';
