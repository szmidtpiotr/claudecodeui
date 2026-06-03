import { AbstractProvider } from '@/modules/providers/shared/base/abstract.provider.js';
import { AzureProviderAuth } from '@/modules/providers/list/azure/azure-auth.provider.js';
import { AzureProviderModels } from '@/modules/providers/list/azure/azure-models.provider.js';
import { AzureMcpProvider } from '@/modules/providers/list/azure/azure-mcp.provider.js';
import { AzureSessionSynchronizer } from '@/modules/providers/list/azure/azure-session-synchronizer.provider.js';
import { AzureSessionsProvider } from '@/modules/providers/list/azure/azure-sessions.provider.js';
import { AzureSkillsProvider } from '@/modules/providers/list/azure/azure-skills.provider.js';
import type { IProviderAuth, IProviderModels, IProviderSessionSynchronizer, IProviderSkills, IProviderSessions } from '@/shared/interfaces.js';

export class AzureProvider extends AbstractProvider {
  readonly models: IProviderModels = new AzureProviderModels();
  readonly mcp = new AzureMcpProvider();
  readonly auth: IProviderAuth = new AzureProviderAuth();
  readonly skills: IProviderSkills = new AzureSkillsProvider();
  readonly sessions: IProviderSessions = new AzureSessionsProvider();
  readonly sessionSynchronizer: IProviderSessionSynchronizer = new AzureSessionSynchronizer();

  constructor() { super('azure'); }
}
