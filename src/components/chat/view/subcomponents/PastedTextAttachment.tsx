import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDownIcon, ChevronUpIcon, FileTextIcon, XIcon } from 'lucide-react';

import { countLines, type PastedTextBlock } from '../../utils/pastedText';

type PastedTextAttachmentProps = {
  block: PastedTextBlock;
  onRemove: () => void;
};

/** A long paste held out of the textarea: name, size, preview and remove. */
export default function PastedTextAttachment({ block, onRemove }: PastedTextAttachmentProps) {
  const { t } = useTranslation('chat');
  const [open, setOpen] = useState(false);
  const lines = countLines(block.text);

  return (
    <div className="w-full rounded-lg border border-border/60 bg-background text-xs">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <FileTextIcon className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="font-medium text-foreground">
          {t('pastedText.title', { defaultValue: 'Pasted text #{{id}}', id: block.id })}
        </span>
        <span className="truncate text-muted-foreground">
          {t('pastedText.size', {
            defaultValue: '{{lines}} lines · {{chars}} characters',
            lines: lines.toLocaleString(),
            chars: block.text.length.toLocaleString(),
          })}
        </span>
        <div className="ml-auto flex flex-shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setOpen((value) => !value)}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-expanded={open}
          >
            {open ? <ChevronUpIcon className="h-3.5 w-3.5" /> : <ChevronDownIcon className="h-3.5 w-3.5" />}
            {open
              ? t('pastedText.hide', { defaultValue: 'Hide' })
              : t('pastedText.preview', { defaultValue: 'Preview' })}
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={t('pastedText.remove', { defaultValue: 'Remove pasted text' })}
            aria-label={t('pastedText.remove', { defaultValue: 'Remove pasted text' })}
          >
            <XIcon className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {open && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words border-t border-border/60 px-2 py-1.5 font-mono text-[11px] leading-4 text-foreground">
          {block.text}
        </pre>
      )}
    </div>
  );
}
