import type { LLMProvider } from '../../types/app';
import ClaudeLogo from './ClaudeLogo';
import CodexLogo from './CodexLogo';
import CursorLogo from './CursorLogo';
import GeminiLogo from './GeminiLogo';
import OpenCodeLogo from './OpenCodeLogo';

type SessionProviderLogoProps = {
  provider?: LLMProvider | string | null;
  className?: string;
};

export default function SessionProviderLogo({
  provider = 'claude',
  className = 'w-5 h-5',
}: SessionProviderLogoProps) {
  if (provider === 'cursor') {
    return <CursorLogo className={className} />;
  }

  if (provider === 'codex') {
    return <CodexLogo className={className} />;
  }

  if (provider === 'gemini') {
    return <GeminiLogo className={className} />;
  }

  if (provider === 'opencode') {
    return <OpenCodeLogo className={className} />;
  }

  if (provider === 'azure') {
    return (
      <svg className={className} viewBox="0 0 24 24" fill="currentColor" role="img" aria-label="Azure OpenAI">
        <path d="M13.05 4.24L6.56 18.05L8.76 18.05L10.06 15.04L15.8 15.04L13.05 4.24ZM13.57 7.3L15.3 13.43L10.93 13.43L13.57 7.3ZM17.44 8.76L14.4 18.05L22 18.05L17.44 8.76Z"/>
      </svg>
    );
  }

  return <ClaudeLogo className={className} />;
}
