import type { ComponentType } from 'react';
import type { PendingPermissionRequest } from '../../types/types';

export interface PermissionPanelProps {
  request: PendingPermissionRequest;
  onDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; updatedInput?: unknown },
  ) => void;
}

/**
 * Tool name the backend gives an MCP server's request for input ("elicitation") when it
 * forwards it as a permission request. The permission banner draws it with the elicitation
 * panel, and the composer steps aside while one is open, as it does for a question.
 */
export const MCP_ELICITATION_TOOL_NAME = 'McpElicitation';

const registry: Record<string, ComponentType<PermissionPanelProps>> = {};

export function registerPermissionPanel(
  toolName: string,
  component: ComponentType<PermissionPanelProps>,
): void {
  registry[toolName] = component;
}

export function getPermissionPanel(
  toolName: string,
): ComponentType<PermissionPanelProps> | null {
  return registry[toolName] || null;
}
