import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

import { IMAGE_MIME_TYPES, imageFilesFrom } from '../../utils/clipboardImage';

type PasteCatcherProps = {
  onText: (text: string) => void;
  onImages: (files: File[]) => void;
  onClose: () => void;
};

/** Turns <img> elements a keyboard inserted into the field into image files. */
async function filesFromInsertedImages(field: HTMLElement): Promise<File[]> {
  const files: File[] = [];

  for (const image of Array.from(field.querySelectorAll('img'))) {
    try {
      const blob = await (await fetch(image.src)).blob();
      if (IMAGE_MIME_TYPES.includes(blob.type)) {
        files.push(new File([blob], `clipboard.${blob.type.split('/')[1]}`, { type: blob.type }));
      }
    } catch {
      // A source the page may not read (content:// URI): nothing to attach.
    }
  }

  return files;
}

/**
 * Fallback for pasting when the page may not read the clipboard itself (plain
 * HTTP, or permission refused): a field the user pastes into with the system
 * "Paste" action or the keyboard's clipboard row.
 *
 * It is an editable block, not a text box: Android offers to paste a picture
 * only into rich-text fields.
 */
export default function PasteCatcher({ onText, onImages, onClose }: PasteCatcherProps) {
  const { t } = useTranslation('chat');
  const fieldRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);

  useEffect(() => {
    fieldRef.current?.focus();
  }, []);

  const finish = (deliver: () => void) => {
    if (doneRef.current) {
      return;
    }
    doneRef.current = true;
    deliver();
    onClose();
  };

  return (
    <div
      className="absolute inset-0 z-30 flex items-start justify-center bg-black/60 p-4"
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
        <div
          ref={fieldRef}
          contentEditable
          suppressContentEditableWarning
          role="textbox"
          aria-label={t('shell.pasteCatcher.title', { defaultValue: 'Paste here' })}
          className="mb-3 max-h-40 min-h-[4.5rem] w-full overflow-auto rounded border border-gray-600 bg-gray-900 px-3 py-2 text-sm text-gray-100 outline-none focus:border-blue-500 [&_img]:max-h-24"
          onPaste={(event) => {
            const images = imageFilesFrom(event.clipboardData.files);
            if (images.length > 0) {
              event.preventDefault();
              finish(() => onImages(images));
              return;
            }

            const text = event.clipboardData.getData('text/plain');
            if (text) {
              event.preventDefault();
              finish(() => onText(text));
            }
            // Otherwise let the browser insert whatever it has; onInput picks it up.
          }}
          // The keyboard's clipboard row inserts content without a paste event.
          onInput={(event) => {
            const field = event.currentTarget;
            void filesFromInsertedImages(field).then((images) => {
              if (images.length > 0) {
                finish(() => onImages(images));
                return;
              }
              const text = field.innerText.trim();
              if (text && field.querySelectorAll('img').length === 0) {
                finish(() => onText(text));
              }
            });
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
