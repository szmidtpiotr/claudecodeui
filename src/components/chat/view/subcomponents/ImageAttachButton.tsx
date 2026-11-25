import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CameraIcon, ImageIcon, ImagesIcon, LoaderIcon, SwitchCameraIcon, XIcon } from 'lucide-react';

import { ActionMenu, Button, Dialog, DialogContent, DialogTitle } from '../../../../shared/view/ui';
import { hasSoftKeyboard } from '../../../../utils/device';

type ImageAttachButtonProps = {
  /** Opens the regular file picker (gallery / file manager). */
  openImagePicker: () => void;
  /** Adds ready image files to the message, same path as drop and paste. */
  onImageFiles: (files: File[]) => void;
};

const photoFileName = () => {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `photo-${stamp}.jpg`;
};

/**
 * Image button with two choices: pick a file, or take a photo.
 *
 * On a touch device the photo goes through the phone's own camera app
 * (`capture` on a file input) — better quality and focus than a browser stream.
 * On a computer it opens a dialog with the webcam preview (getUserMedia).
 */
export default function ImageAttachButton({ openImagePicker, onImageFiles }: ImageAttachButtonProps) {
  const { t } = useTranslation('chat');
  const captureInputRef = useRef<HTMLInputElement>(null);
  const [webcamOpen, setWebcamOpen] = useState(false);

  const takePhoto = useCallback(() => {
    if (hasSoftKeyboard()) {
      captureInputRef.current?.click();
      return;
    }
    setWebcamOpen(true);
  }, []);

  return (
    <>
      <ActionMenu
        label={t('input.attachImages')}
        icon={ImageIcon}
        iconOnly
        portal
        align="left"
        variant="ghost"
        size="icon"
        triggerClassName="h-8 w-8 [&_svg]:size-4"
        items={[
          {
            key: 'file',
            label: t('input.imageFromDevice', { defaultValue: 'From device' }),
            icon: ImagesIcon,
            onSelect: openImagePicker,
          },
          {
            key: 'camera',
            label: t('input.takePhoto', { defaultValue: 'Take a photo' }),
            icon: CameraIcon,
            onSelect: takePhoto,
          },
        ]}
      />

      <input
        ref={captureInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          // Reset so the same photo name can be picked again.
          event.target.value = '';
          if (files.length > 0) onImageFiles(files);
        }}
      />

      {webcamOpen && (
        <WebcamCaptureDialog
          onClose={() => setWebcamOpen(false)}
          onCapture={(file) => {
            onImageFiles([file]);
            setWebcamOpen(false);
          }}
        />
      )}
    </>
  );
}

type WebcamCaptureDialogProps = {
  onClose: () => void;
  onCapture: (file: File) => void;
};

function WebcamCaptureDialog({ onClose, onCapture }: WebcamCaptureDialogProps) {
  const { t } = useTranslation('chat');
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceIndex, setDeviceIndex] = useState(0);
  const [status, setStatus] = useState<'starting' | 'ready' | 'error'>('starting');
  const [error, setError] = useState('');

  const stopStream = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const start = async () => {
      stopStream();
      setStatus('starting');

      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus('error');
        setError(t('input.cameraNeedsHttps', {
          defaultValue: 'The browser blocks the camera here. It only works over HTTPS (or on localhost).',
        }));
        return;
      }

      try {
        const deviceId = devices[deviceIndex]?.deviceId;
        const stream = await navigator.mediaDevices.getUserMedia({
          video: deviceId
            ? { deviceId: { exact: deviceId }, width: { ideal: 1920 }, height: { ideal: 1080 } }
            : { width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          await videoRef.current.play().catch(() => {});
        }
        setStatus('ready');

        // Labels are only filled in after permission is granted.
        if (devices.length === 0) {
          const all = await navigator.mediaDevices.enumerateDevices();
          if (!cancelled) setDevices(all.filter((d) => d.kind === 'videoinput'));
        }
      } catch (err) {
        if (cancelled) return;
        const name = (err as DOMException)?.name;
        setStatus('error');
        setError(
          name === 'NotAllowedError'
            ? t('input.cameraDenied', { defaultValue: 'Camera access was denied. Allow it in the browser and try again.' })
            : name === 'NotFoundError' || name === 'OverconstrainedError'
              ? t('input.cameraNotFound', { defaultValue: 'No camera found.' })
              : t('input.cameraError', { defaultValue: 'Could not start the camera.' }) + ` (${name || String(err)})`,
        );
      }
    };

    void start();
    return () => {
      cancelled = true;
      stopStream();
    };
    // devices.length deliberately left out: filling the list must not restart the stream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deviceIndex, stopStream, t]);

  const capture = () => {
    const video = videoRef.current;
    if (!video || !video.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob((blob) => {
      if (!blob) return;
      onCapture(new File([blob], photoFileName(), { type: 'image/jpeg' }));
    }, 'image/jpeg', 0.92);
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-2xl p-4">
        <DialogTitle>{t('input.takePhoto', { defaultValue: 'Take a photo' })}</DialogTitle>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-medium">{t('input.takePhoto', { defaultValue: 'Take a photo' })}</span>
          <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={onClose} aria-label={t('input.close', { defaultValue: 'Close' })}>
            <XIcon className="h-4 w-4" />
          </Button>
        </div>

        <div className="relative flex aspect-video w-full items-center justify-center overflow-hidden rounded-lg bg-black">
          <video
            ref={videoRef}
            playsInline
            muted
            className={status === 'ready' ? 'h-full w-full object-contain' : 'hidden'}
          />
          {status === 'starting' && <LoaderIcon className="h-6 w-6 animate-spin text-white/70" />}
          {status === 'error' && <p className="px-6 text-center text-sm text-white/80">{error}</p>}
        </div>

        <div className="mt-3 flex items-center justify-between gap-2">
          {devices.length > 1 ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setDeviceIndex((i) => (i + 1) % devices.length)}
              title={devices[(deviceIndex + 1) % devices.length]?.label}
            >
              <SwitchCameraIcon className="mr-1.5 h-4 w-4" />
              {t('input.switchCamera', { defaultValue: 'Switch camera' })}
            </Button>
          ) : <span />}
          <Button type="button" onClick={capture} disabled={status !== 'ready'}>
            <CameraIcon className="mr-1.5 h-4 w-4" />
            {t('input.capturePhoto', { defaultValue: 'Capture' })}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
