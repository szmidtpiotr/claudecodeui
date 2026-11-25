import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ClipboardPaste } from 'lucide-react';

import { PASTE_SETTINGS_DEFAULTS, usePasteSettings } from '../../../hooks/usePasteSettings';
import { SETTING_ROW_CLASS } from '../constants';

import QuickSettingsToggleRow from './QuickSettingsToggleRow';

type LimitFieldProps = {
  label: string;
  value: number;
  fallback: number;
  disabled: boolean;
  onCommit: (value: number) => void;
};

/** Number field that saves on blur/Enter, so typing "2" on the way to "2500" doesn't apply. */
function LimitField({ label, value, fallback, disabled, onCommit }: LimitFieldProps) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const parsed = Number(draft);
    const next = Number.isFinite(parsed) && parsed >= 1 ? Math.round(parsed) : fallback;
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <label className={`${SETTING_ROW_CLASS} ${disabled ? 'opacity-50' : ''}`}>
      <span className="text-sm text-gray-900 dark:text-white">{label}</span>
      <input
        type="number"
        min={1}
        inputMode="numeric"
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') (event.target as HTMLInputElement).blur();
        }}
        className="w-20 rounded border border-gray-300 bg-white px-2 py-1 text-right text-sm text-gray-900 dark:border-gray-600 dark:bg-gray-900 dark:text-white"
      />
    </label>
  );
}

export default function QuickSettingsPasteRows() {
  const { t } = useTranslation('settings');
  const { settings, updateSettings } = usePasteSettings();
  const off = !settings.collapseLongPastes;

  return (
    <>
      <QuickSettingsToggleRow
        label={t('quickSettings.collapseLongPastes', { defaultValue: 'Long pastes as attachments' })}
        icon={ClipboardPaste}
        checked={settings.collapseLongPastes}
        onCheckedChange={(value) => updateSettings({ collapseLongPastes: value })}
      />
      <LimitField
        label={t('quickSettings.pasteMinChars', { defaultValue: 'Above this many characters' })}
        value={settings.minChars}
        fallback={PASTE_SETTINGS_DEFAULTS.minChars}
        disabled={off}
        onCommit={(value) => updateSettings({ minChars: value })}
      />
      <LimitField
        label={t('quickSettings.pasteMinLines', { defaultValue: 'or above this many lines' })}
        value={settings.minLines}
        fallback={PASTE_SETTINGS_DEFAULTS.minLines}
        disabled={off}
        onCommit={(value) => updateSettings({ minLines: value })}
      />
      <p className="ml-3 text-xs text-gray-500 dark:text-gray-400">
        {t('quickSettings.collapseLongPastesDescription', {
          defaultValue: 'A long paste shows as a short marker in the input with a preview card above it. The full text is still sent with the message.',
        })}
      </p>
    </>
  );
}
