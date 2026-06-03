import { useState } from 'react';
import { ExternalLink, KeyRound, X } from 'lucide-react';
import StandaloneShell from '../../standalone-shell/view/StandaloneShell';
import { DEFAULT_PROJECT_FOR_EMPTY_SHELL, IS_PLATFORM } from '../../../constants/config';
import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

type ProviderLoginModalProps = {
  isOpen: boolean;
  onClose: () => void;
  provider?: LLMProvider;
  onComplete?: (exitCode: number) => void;
  customCommand?: string;
  isAuthenticated?: boolean;
};

const getProviderCommand = ({
  provider,
  customCommand,
  isAuthenticated: _isAuthenticated,
}: {
  provider: LLMProvider;
  customCommand?: string;
  isAuthenticated: boolean;
}) => {
  if (customCommand) {
    return customCommand;
  }

  if (provider === 'claude') {
    return 'claude --dangerously-skip-permissions /login';
  }

  if (provider === 'cursor') {
    return 'cursor-agent login';
  }

  if (provider === 'codex') {
    return IS_PLATFORM ? 'codex login --device-auth' : 'codex login';
  }

  if (provider === 'opencode') {
    return 'opencode auth login';
  }

  return 'gemini status';
};

const getProviderTitle = (provider: LLMProvider) => {
  if (provider === 'claude') return 'Claude CLI Login';
  if (provider === 'cursor') return 'Cursor CLI Login';
  if (provider === 'codex') return 'Codex CLI Login';
  if (provider === 'opencode') return 'OpenCode CLI Login';
  if (provider === 'azure') return 'Azure OpenAI Configuration';
  return 'Gemini CLI Configuration';
};

export default function ProviderLoginModal({
  isOpen,
  onClose,
  provider = 'claude',
  onComplete,
  customCommand,
  isAuthenticated = false,
}: ProviderLoginModalProps) {
  const [azureEndpoint, setAzureEndpoint] = useState('');
  const [azureApiKey, setAzureApiKey] = useState('');
  const [azureApiVersion, setAzureApiVersion] = useState('2024-12-01-preview');
  const [azureSaving, setAzureSaving] = useState(false);
  const [azureError, setAzureError] = useState<string | null>(null);
  const [azureSaved, setAzureSaved] = useState(false);

  if (!isOpen) {
    return null;
  }

  const command = getProviderCommand({ provider, customCommand, isAuthenticated });
  const title = getProviderTitle(provider);

  const handleComplete = (exitCode: number) => {
    onComplete?.(exitCode);
  };

  const handleAzureSave = async () => {
    setAzureError(null);
    setAzureSaving(true);
    try {
      const res = await authenticatedFetch('/api/azure/config', {
        method: 'POST',
        body: JSON.stringify({ endpoint: azureEndpoint, apiKey: azureApiKey, apiVersion: azureApiVersion }),
      });
      const data = await res.json() as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setAzureError(data.error || 'Failed to save configuration');
      } else {
        setAzureSaved(true);
        onComplete?.(0);
      }
    } catch (err) {
      setAzureError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setAzureSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black bg-opacity-50 max-md:items-stretch max-md:justify-stretch">
      <div className="flex h-3/4 w-full max-w-4xl flex-col rounded-lg bg-white shadow-xl dark:bg-gray-800 max-md:m-0 max-md:h-full max-md:max-w-none max-md:rounded-none md:m-4 md:h-3/4 md:max-w-4xl md:rounded-lg">
        <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white">{title}</h3>
          <button
            onClick={onClose}
            className="text-gray-400 transition-colors hover:text-gray-600 dark:hover:text-gray-300"
            aria-label="Close login modal"
          >
            <X className="h-6 w-6" />
          </button>
        </div>

        <div className="flex-1 overflow-hidden">
          {provider === 'azure' ? (
            <div className="flex h-full flex-col items-center justify-center bg-gray-50 p-8 dark:bg-gray-900/50">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
              </div>
              <h4 className="mb-2 text-xl font-medium text-gray-900 dark:text-white">Azure OpenAI Credentials</h4>
              <p className="mb-6 max-w-md text-center text-sm text-gray-600 dark:text-gray-400">
                Enter your Azure OpenAI endpoint and API key from the Azure portal.
              </p>
              <div className="w-full max-w-md space-y-4">
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">Endpoint URL</label>
                  <input
                    type="url"
                    value={azureEndpoint}
                    onChange={(e) => setAzureEndpoint(e.target.value)}
                    placeholder="https://your-resource.openai.azure.com"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">API Key</label>
                  <input
                    type="password"
                    value={azureApiKey}
                    onChange={(e) => setAzureApiKey(e.target.value)}
                    placeholder="Your Azure OpenAI API key"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
                <div>
                  <label className="mb-1 block text-sm font-medium text-gray-900 dark:text-white">API Version</label>
                  <input
                    type="text"
                    value={azureApiVersion}
                    onChange={(e) => setAzureApiVersion(e.target.value)}
                    placeholder="2024-12-01-preview"
                    className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none dark:border-gray-600 dark:bg-gray-800 dark:text-white"
                  />
                </div>
                {azureError && <p className="text-sm text-red-600 dark:text-red-400">{azureError}</p>}
                {azureSaved && <p className="text-sm text-green-600 dark:text-green-400">Configuration saved successfully.</p>}
                <div className="flex gap-3 pt-2">
                  <button
                    onClick={() => void handleAzureSave()}
                    disabled={azureSaving || !azureEndpoint || !azureApiKey}
                    className="flex-1 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50"
                  >
                    {azureSaving ? 'Saving...' : 'Save Configuration'}
                  </button>
                  <button
                    onClick={onClose}
                    className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-600 dark:text-gray-300 dark:hover:bg-gray-700"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          ) : provider === 'gemini' ? (
            <div className="flex h-full flex-col items-center justify-center bg-gray-50 p-8 text-center dark:bg-gray-900/50">
              <div className="mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-blue-100 dark:bg-blue-900/30">
                <KeyRound className="h-8 w-8 text-blue-600 dark:text-blue-400" />
              </div>

              <h4 className="mb-3 text-xl font-medium text-gray-900 dark:text-white">Setup Gemini API Access</h4>

              <p className="mb-8 max-w-md text-gray-600 dark:text-gray-400">
                The Gemini CLI requires an API key to function. Configure it in your terminal first.
              </p>

              <div className="w-full max-w-lg rounded-xl border border-gray-200 bg-white p-6 text-left shadow-sm dark:border-gray-700 dark:bg-gray-800">
                <ol className="space-y-4">
                  <li className="flex gap-4">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                      1
                    </div>
                    <div>
                      <p className="mb-1 text-sm font-medium text-gray-900 dark:text-white">Get your API key</p>
                      <a
                        href="https://aistudio.google.com/app/apikey"
                        target="_blank"
                        rel="noreferrer"
                        className="flex inline-flex items-center gap-1 text-sm text-blue-600 hover:underline dark:text-blue-400"
                      >
                        Google AI Studio <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </li>
                  <li className="flex gap-4">
                    <div className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-sm font-medium text-blue-600 dark:bg-blue-900/50 dark:text-blue-400">
                      2
                    </div>
                    <div>
                      <p className="mb-1 text-sm font-medium text-gray-900 dark:text-white">Run configuration</p>
                      <p className="mb-2 text-sm text-gray-600 dark:text-gray-400">Open your terminal and run:</p>
                      <code className="block rounded bg-gray-100 px-3 py-2 font-mono text-sm text-pink-600 dark:bg-gray-900 dark:text-pink-400">
                        gemini config set api_key YOUR_KEY
                      </code>
                    </div>
                  </li>
                </ol>
              </div>

              <button
                onClick={onClose}
                className="mt-8 rounded-lg bg-blue-600 px-6 py-2.5 font-medium text-white transition-colors hover:bg-blue-700"
              >
                Done
              </button>
            </div>
          ) : (
            <StandaloneShell project={DEFAULT_PROJECT_FOR_EMPTY_SHELL} command={command} onComplete={handleComplete} minimal={true} />
          )}
        </div>
      </div>
    </div>
  );
}
