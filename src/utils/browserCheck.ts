export interface BrowserCompatibilityInfo {
  isChromiumDesktopOrAndroid: boolean;
  browserLabel: string;
  isSecureContext: boolean;
  hasWebBluetoothApi: boolean;
  isTouchDevice: boolean;
}

export function getBrowserCompatibility(): BrowserCompatibilityInfo {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return {
      isChromiumDesktopOrAndroid: true,
      browserLabel: 'Chrome',
      isSecureContext: true,
      hasWebBluetoothApi: false,
      isTouchDevice: false,
    };
  }

  const ua = navigator.userAgent;
  const isEdge = /Edg\//.test(ua);
  const isChrome = /Chrome\//.test(ua) && !isEdge && !/OPR\//.test(ua);
  const isFirefox = /Firefox\//.test(ua);
  const isSafari = /Safari\//.test(ua) && !/Chrome\//.test(ua) && !isEdge;

  let browserLabel = 'Unknown Browser';
  if (isEdge) browserLabel = 'Microsoft Edge';
  else if (isChrome) browserLabel = 'Google Chrome';
  else if (isFirefox) browserLabel = 'Firefox';
  else if (isSafari) browserLabel = 'Safari';

  const isSecureContext =
    window.isSecureContext ||
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1';

  const hasWebBluetoothApi = 'bluetooth' in navigator;
  const isTouchDevice =
    'ontouchstart' in window || (navigator.maxTouchPoints ?? 0) > 0;

  return {
    isChromiumDesktopOrAndroid: isChrome || isEdge,
    browserLabel,
    isSecureContext,
    hasWebBluetoothApi,
    isTouchDevice,
  };
}
