import os from 'node:os';
import path from 'node:path';

import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { addUniqueProviderSkillSource, findTopmostGitRoot } from '@/shared/utils.js';

export class AzureSkillsProvider extends SkillsProvider {
  constructor() { super('azure'); }

  protected async getSkillSources(workspacePath: string): Promise<ProviderSkillSource[]> {
    const sources: ProviderSkillSource[] = [];
    const seenRootDirs = new Set<string>();
    const repoRoot = await findTopmostGitRoot(workspacePath);

    addUniqueProviderSkillSource(sources, seenRootDirs, { scope: 'repo', rootDir: path.join(workspacePath, '.agents', 'skills'), commandPrefix: '/' });
    if (repoRoot && repoRoot !== workspacePath) {
      addUniqueProviderSkillSource(sources, seenRootDirs, { scope: 'repo', rootDir: path.join(repoRoot, '.agents', 'skills'), commandPrefix: '/' });
    }
    addUniqueProviderSkillSource(sources, seenRootDirs, { scope: 'user', rootDir: path.join(os.homedir(), '.azure-openai', 'skills'), commandPrefix: '/' });
    return sources;
  }
}
