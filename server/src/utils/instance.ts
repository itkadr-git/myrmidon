/**
 * Utility functions for getting server instance information
 */

// In a real implementation, this might read from environment variables,
// configuration, or database records to determine the instance ID
export function getServerInstance(): string {
  // For development/testing, we'll use an environment variable or default
  return process.env.MYRMIDON_INSTANCE_ID || 'local-dev-instance';
}