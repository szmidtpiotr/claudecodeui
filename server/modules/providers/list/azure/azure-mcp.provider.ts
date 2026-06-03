import os from 'node:os';
import path from 'node:path';

import { McpProvider } from '@/modules/providers/shared/mcp/mcp.provider.js';
import type { McpScope, ProviderMcpServer, UpsertProviderMcpServerInput } from '@/shared/types.js';
import { AppError, readJsonConfig, readObjectRecord, readOptionalString, readStringArray, readStringRecord, writeJsonConfig } from '@/shared/utils.js';

const cfgPath = (scope: McpScope, workspacePath: string) =>
  scope === 'user' ? path.join(os.homedir(), '.azure-openai', 'mcp.json') : path.join(workspacePath, '.azure-openai', 'mcp.json');

export class AzureMcpProvider extends McpProvider {
  constructor() { super('azure', ['user', 'project'], ['stdio', 'http']); }

  protected async readScopedServers(scope: McpScope, workspacePath: string): Promise<Record<string, unknown>> {
    const config = await readJsonConfig(cfgPath(scope, workspacePath));
    return readObjectRecord(config.mcpServers) ?? {};
  }

  protected async writeScopedServers(scope: McpScope, workspacePath: string, servers: Record<string, unknown>): Promise<void> {
    const filePath = cfgPath(scope, workspacePath);
    const config = await readJsonConfig(filePath);
    config.mcpServers = servers;
    await writeJsonConfig(filePath, config);
  }

  protected buildServerConfig(input: UpsertProviderMcpServerInput): Record<string, unknown> {
    if (input.transport === 'stdio') {
      if (!input.command?.trim()) throw new AppError('command is required for stdio MCP servers.', { code: 'MCP_COMMAND_REQUIRED', statusCode: 400 });
      return { type: 'stdio', command: input.command, args: input.args ?? [], env: input.env ?? {} };
    }
    if (!input.url?.trim()) throw new AppError('url is required for http MCP servers.', { code: 'MCP_URL_REQUIRED', statusCode: 400 });
    return { type: 'http', url: input.url, headers: input.headers ?? {} };
  }

  protected normalizeServerConfig(scope: McpScope, name: string, rawConfig: unknown): ProviderMcpServer | null {
    const config = readObjectRecord(rawConfig);
    if (!config) return null;
    if (config.type === 'stdio' || config.command !== undefined) {
      const commandStr = readOptionalString(config.command);
      const commandArr = readStringArray(config.command);
      const command = commandStr ?? commandArr?.[0];
      if (!command) return null;
      return { provider: 'azure', name, scope, transport: 'stdio', command, args: commandArr ? commandArr.slice(1) : readStringArray(config.args) ?? [], env: readStringRecord(config.env) };
    }
    if (config.type === 'http' || typeof config.url === 'string') {
      const url = readOptionalString(config.url);
      if (!url) return null;
      return { provider: 'azure', name, scope, transport: 'http', url, headers: readStringRecord(config.headers) };
    }
    return null;
  }
}
