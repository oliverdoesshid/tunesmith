/**
 * Renderer hardening.
 *
 * The renderer is treated as hostile: it renders community-authored text, so it must
 * not be able to navigate to arbitrary origins, open windows, use webviews, or ask for
 * device permissions. The preload bridge is the only channel back into a privileged
 * context, and every message on it is re-validated in the main process.
 */
import { session, shell, type BrowserWindow } from 'electron';
import { logger } from '../logging';

const DEV_ORIGIN = 'http://localhost:5273';

function contentSecurityPolicy(devUrl: string | null): string {
  // In dev, Vite injects an inline React-refresh preamble and talks to its own server
  // over HTTP/WS. Production keeps the strict 'self' policy.
  const scriptSrc = devUrl === null ? "'self'" : `'self' 'unsafe-inline' ${devUrl}`;
  const connectSrc = devUrl === null ? "'self'" : `'self' ${devUrl} ws://localhost:5273`;

  return [
    "default-src 'none'",
    `script-src ${scriptSrc}`,
    "style-src 'self' 'unsafe-inline'",
    // `ts-art:` serves SteamGridDB artwork from the main-process cache; remote images
    // are never loaded by the renderer itself.
    "img-src 'self' data: ts-art:",
    "font-src 'self' data:",
    `connect-src ${connectSrc}`,
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "object-src 'none'",
  ].join('; ');
}

export function installContentSecurityPolicy(devUrl: string | null): void {
  const csp = contentSecurityPolicy(devUrl);
  logger.debug('security', 'installing content security policy', { devUrl });
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
        'X-Content-Type-Options': ['nosniff'],
      },
    });
  });
}

export function denyAllPermissions(): void {
  session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
    logger.warn('security', 'permission request denied', {
      permission,
      url: contents.getURL(),
    });
    callback(false);
  });
  session.defaultSession.setPermissionCheckHandler((_contents, permission) => {
    logger.debug('security', 'permission check denied', { permission });
    return false;
  });
}

function isAllowedUrl(url: string, devUrl: string | null): boolean {
  if (devUrl !== null && url.startsWith(devUrl)) return true;
  return url.startsWith('file://');
}

export function hardenWindow(win: BrowserWindow, devUrl: string | null): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links are handed to the OS browser; never opened in-app.
    const external = url.startsWith('https://');
    logger.info('security', 'window.open intercepted', { url, external });
    if (external) void shell.openExternal(url);
    return { action: 'deny' };
  });

  win.webContents.on('will-attach-webview', (event) => {
    logger.warn('security', 'blocked webview attachment', { url: win.webContents.getURL() });
    event.preventDefault();
  });

  win.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedUrl(url, devUrl)) {
      logger.warn('security', 'blocked navigation', { url, devUrl });
      event.preventDefault();
    }
  });

  win.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedUrl(url, devUrl)) {
      logger.warn('security', 'blocked redirect', { url, devUrl });
      event.preventDefault();
    }
  });
}

export const DEV_SERVER_ORIGIN = DEV_ORIGIN;
