/**
 * Mapping of tools to autonomy action classes.
 * 
 * This module provides the mapping between specific tools and their corresponding
 * autonomy action classes (merge, deploy, external_message, etc.). The mapping
 * is configurable with sensible defaults.
 */

import { AutonomyActionClass } from "@paperclipai/shared";

export interface ToolAutonomyMapping {
  [toolName: string]: AutonomyActionClass;
}

/**
 * Default mapping of tools to autonomy action classes.
 * These are the factory defaults that can be overridden by configuration.
 */
export const DEFAULT_TOOL_AUTONOMY_MAPPING: ToolAutonomyMapping = {
  // Merge-related tools
  "github.create_pr": "merge",
  "github.update_pr": "merge",
  "github.merge_pr": "merge",
  "github.close_pr": "merge",
  "git.push": "merge",
  "git.branch": "merge",
  
  // Deployment-related tools
  "deploy.apply": "deploy",
  "deploy.rollback": "deploy",
  "deploy.status": "deploy",
  "kubernetes.deploy": "deploy",
  "kubernetes.scale": "deploy",
  "kubernetes.rollback": "deploy",
  "vercel.deploy": "deploy",
  "netlify.deploy": "deploy",
  "aws.deploy": "deploy",
  "gcp.deploy": "deploy",
  
  // External message tools
  "email.send": "external_message",
  "slack.send_message": "external_message",
  "discord.send_message": "external_message",
  "teams.send_message": "external_message",
  "telegram.send_message": "external_message",
  "twitter.post": "external_message",
  "linkedin.post": "external_message",
  "sms.send": "external_message",
  "notification.send": "external_message",
  "calendar.create_event": "external_message", // Could potentially send notifications
  "calendar.update_event": "external_message", // Could potentially send notifications
  
  // Spend-related tools
  "aws.cost.create_budget": "spend_above_threshold",
  "gcp.billing.create_budget": "spend_above_threshold",
  "azure.cost.create_budget": "spend_above_threshold",
  "stripe.charge": "spend_above_threshold",
  "paypal.process_payment": "spend_above_threshold",
  
  // Delete-related tools
  "filesystem.delete_file": "delete",
  "database.delete_record": "delete",
  "aws.s3.delete_object": "delete",
  "aws.ec2.terminate_instance": "delete",
  "gcp.compute.delete_instance": "delete",
  "kubernetes.delete_resource": "delete",
  
  // Pause/wake agents
  "agent.pause": "pause_wake_agents",
  "agent.wake": "pause_wake_agents",
  "agent.stop": "pause_wake_agents",
  "agent.start": "pause_wake_agents",
  
  // Instruction changes
  "agent.update_instructions": "change_instructions",
  "agent.modify_behavior": "change_instructions",
};

/**
 * Get the autonomy action class for a given tool.
 * 
 * @param toolName The name of the tool
 * @param customMapping Optional custom mapping to override defaults
 * @returns The autonomy action class or undefined if no mapping exists
 */
export function getToolAutonomyClass(
  toolName: string, 
  customMapping?: ToolAutonomyMapping
): AutonomyActionClass | undefined {
  const mapping = customMapping || DEFAULT_TOOL_AUTONOMY_MAPPING;
  return mapping[toolName];
}

/**
 * Check if a tool has a defined autonomy action class.
 */
export function hasAutonomyClass(toolName: string, customMapping?: ToolAutonomyMapping): boolean {
  return getToolAutonomyClass(toolName, customMapping) !== undefined;
}