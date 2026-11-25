import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { imageFilesFrom } from '../../utils/clipboardImage';

type PasteCatcherProps = {
  onText: (text: string) => void;
  onImages: (files: File[]) => void;
  onClose: () => void;
};

/**
 * Fallback for pasting when the page may not read the clipboard itself (plain
 * HTTP, or permission refused): a field the user pastes into with the system
 * "Paste" action, which hands over text and images alike.
 */
export default function PasteCatcher({ onText, onImages, onClose }: PasteCatcherProps) {
  const { t } = useTranslation('chat');
  const fieldRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  return (
    <div
      className="absolute inset-0 z-30 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-sm rounded-lg border border-gray-700 bg-gray-800 p-4 shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="mb-2 text-sm font-medium text-gray-100">
          {t('shell.pasteCatcher.title', { defaultValue: 'Paste here' })}
        </p>
        <p className="mb-3 text-xs text-gray-400">
          {t('shell.pasteCatcher.hint', {
            defaultValue:
              'The browser does not let this page read the clipboard. Press and hold the field below and choose "Paste" - text or a screenshot.',
          })}
        </p>
        <textarea
          ref={fieldRef}
          rows={3}
          className="mb-3 w-full rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500"
          onPaste={(event) => {
            event.preventDefault();
            const images = imageFilesFrom(event.clipboardData.files);
            if (images.length > 0) {
              onImages(images);
            } else {
              const text = event.clipboardData.getData('text/plain');
              if (text) onText(text);
            }
            onClose();
          }}
          // A keyboard's clipboard chip inserts text without a paste event.
          onChange={(event) => {
            if (event.target.value) {
              onText(event.target.value);
              onClose();
            }
          }}
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded bg-gray-700 px-3 py-1.5 text-xs font-medium text-gray-200 hover:bg-gray-600"
          >
            {t('shell.pasteCatcher.cancel', { defaultValue: 'Cancel' })}
          </button>
        </div>
      </div>
    </div>
  );
}
