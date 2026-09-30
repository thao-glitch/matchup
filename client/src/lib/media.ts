import type { AppError } from '../types';

/**
 * Camera + microphone acquisition.
 *
 * Tuned for 1v1 chat on global links: 720p is the sweet spot between "looks
 * sharp" and "fits in a 1-3 Mbps uplink", and the acoustic processing flags
 * matter a lot on laptops/phones with noisy fans and echoey rooms.
 */
export const LOCAL_MEDIA_CONSTRAINTS: MediaStreamConstraints = {
  video: {
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 24, max: 30 },
    facingMode: 'user',
  },
  audio: {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
};

export class MediaError extends Error {
  readonly appError: AppError;
  constructor(appError: AppError) {
    super(appError.message);
    this.name = 'MediaError';
    this.appError = appError;
  }
}

/** `true` when a usable stream already exists (both tracks present). */
export function hasLiveMedia(stream: MediaStream | null): stream is MediaStream {
  if (!stream) return false;
  const [video] = stream.getVideoTracks();
  const [audio] = stream.getAudioTracks();
  return Boolean(video?.readyState === 'live' && audio?.readyState === 'live');
}

export async function acquireLocalMedia(): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new MediaError({
      code: 'media-missing',
      title: 'Camera not available',
      message:
        'This browser or page context does not expose getUserMedia. Open the app over https:// (or http://localhost) in a modern browser.',
    });
  }

  try {
    return await navigator.mediaDevices.getUserMedia(LOCAL_MEDIA_CONSTRAINTS);
  } catch (err) {
    throw new MediaError(describeMediaError(err));
  }
}

/** Turn a raw DOMException into something a human can act on. */
export function describeMediaError(err: unknown): AppError {
  const name = err instanceof DOMException ? err.name : '';

  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return {
        code: 'media-denied',
        title: 'Camera / microphone blocked',
        message:
          'Allow camera and microphone access in your browser’s address bar, then try again. HTTPS is required outside localhost.',
      };
    case 'NotFoundError':
    case 'DevicesNotFoundError':
      return {
        code: 'media-missing',
        title: 'No camera found',
        message: 'Connect a camera (and a microphone) and retry.',
      };
    case 'NotReadableError':
    case 'TrackStartError':
      return {
        code: 'media-missing',
        title: 'Camera is in use',
        message:
          'Another app or browser tab is holding the camera. Close it and retry.',
      };
    case 'OverconstrainedError':
      return {
        code: 'media-missing',
        title: 'Unsupported camera settings',
        message: 'Your camera cannot provide the requested resolution. Retry.',
      };
    case 'AbortError':
      return {
        code: 'media-missing',
        title: 'Camera start was interrupted',
        message: 'The device stopped responding. Retry, or check your system settings.',
      };
    default:
      return {
        code: 'media-missing',
        title: 'Unable to start camera',
        message:
          err instanceof Error && err.message
            ? err.message
            : 'Something went wrong while starting your camera.',
      };
  }
}

export function stopStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      /* already stopped */
    }
  }
}
