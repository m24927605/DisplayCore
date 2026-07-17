'use strict';

const { createHash } = require('node:crypto');
const defaultFileSystem = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  MAXIMUM_MANAGED_IMAGE_BYTES,
  matchesImageSignature,
} = require('../config/managed-image-importer');

const APP_SCHEME = 'displaycore';
const APP_HOST = 'app';
const ALLOWED_RESOURCE_ROOTS = new Set(['assets', 'control', 'display']);
const MANAGED_LOGO_ROUTE = /^\/managed\/logo\/([a-f0-9]{24}\.(png|jpg|webp))$/;
const MANAGED_STANDBY_BACKGROUND_ROUTE =
  /^\/managed\/standby-background\/([a-f0-9]{24}\.(png|jpg|webp))$/;
const IMAGE_MIME_TYPES = Object.freeze({
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
});

/**
 * 在 Electron ready 前註冊最小權限的本機協定。
 *
 * standard 讓相對 CSS 與圖片路徑正常解析；secure 讓頁面具有安全來源語意。
 * 本系統不需要 Fetch API、Service Worker 或略過 CSP 等額外權限。
 *
 * @param {typeof Electron.protocol} protocol
 */
function registerAppScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
      },
    },
  ]);
}

/**
 * 將 displaycore: URL 安全轉換為專案內的靜態檔案路徑。
 *
 * 僅允許 assets、control 與 display 三個公開目錄；config、main、ipc 與其他
 * 專案檔案都不能被 Renderer 讀取。
 *
 * @param {string} appRoot 專案根目錄
 * @param {string} requestUrl Renderer 請求 URL
 * @returns {string|null}
 */
function resolveAppResource(appRoot, requestUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== `${APP_SCHEME}:` || parsedUrl.host !== APP_HOST) {
    return null;
  }

  let decodedPath;

  try {
    decodedPath = decodeURIComponent(parsedUrl.pathname);
  } catch {
    return null;
  }

  if (decodedPath.includes('\0') || decodedPath.includes('\\')) {
    return null;
  }

  const segments = decodedPath.split('/').filter(Boolean);
  const [resourceRoot, ...relativeSegments] = segments;

  if (!ALLOWED_RESOURCE_ROOTS.has(resourceRoot) || relativeSegments.length === 0) {
    return null;
  }

  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return null;
  }

  const allowedRoot = path.resolve(appRoot, resourceRoot);
  const resourcePath = path.resolve(allowedRoot, ...relativeSegments);
  const relativePath = path.relative(allowedRoot, resourcePath);

  if (
    relativePath === '' ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === '..' ||
    path.isAbsolute(relativePath)
  ) {
    return null;
  }

  return resourcePath;
}

/**
 * 建立不洩漏本機路徑或例外細節的固定錯誤回應。
 *
 * @param {number} status HTTP 狀態碼
 * @param {string} statusText 回應本文
 * @returns {Response}
 */
function createErrorResponse(status, statusText) {
  return new Response(statusText, {
    status,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function resolveManagedImageRequest(requestUrl, route) {
  let parsedUrl;

  try {
    parsedUrl = new URL(requestUrl);
  } catch {
    return null;
  }

  if (
    parsedUrl.protocol !== `${APP_SCHEME}:` ||
    parsedUrl.host !== APP_HOST ||
    parsedUrl.username !== '' ||
    parsedUrl.password !== '' ||
    parsedUrl.port !== '' ||
    parsedUrl.search !== '' ||
    parsedUrl.hash !== '' ||
    parsedUrl.pathname.includes('%') ||
    parsedUrl.pathname.includes('\\')
  ) {
    return null;
  }

  const match = route.exec(parsedUrl.pathname);

  if (!match) {
    return null;
  }

  return Object.freeze({ fileName: match[1], extension: `.${match[2]}` });
}

function resolveManagedLogoRequest(requestUrl) {
  return resolveManagedImageRequest(requestUrl, MANAGED_LOGO_ROUTE);
}

function resolveManagedStandbyBackgroundRequest(requestUrl) {
  return resolveManagedImageRequest(
    requestUrl,
    MANAGED_STANDBY_BACKGROUND_ROUTE,
  );
}

async function serveManagedImage({
  fileName,
  extension,
  method,
  assetPathPrefix,
  managedDirectory,
  getAllowedPath = null,
  getAllowedPaths = null,
  fileSystem,
}) {
  if (
    typeof managedDirectory !== 'string' ||
    managedDirectory.length === 0 ||
    (typeof getAllowedPath !== 'function' &&
      typeof getAllowedPaths !== 'function')
  ) {
    return createErrorResponse(404, 'Not Found');
  }

  try {
    const expectedAssetPath = `${assetPathPrefix}/${fileName}`;
    const allowed = typeof getAllowedPaths === 'function'
      ? getAllowedPaths()
      : null;
    const isAllowed = typeof getAllowedPaths === 'function'
      ? Array.isArray(allowed) && allowed.includes(expectedAssetPath)
      : getAllowedPath() === expectedAssetPath;

    if (!isAllowed) {
      return createErrorResponse(404, 'Not Found');
    }

    const allowedRoot = path.resolve(managedDirectory);
    const filePath = path.resolve(allowedRoot, fileName);
    const relativePath = path.relative(allowedRoot, filePath);

    if (
      relativePath !== fileName ||
      path.isAbsolute(relativePath) ||
      relativePath.startsWith(`..${path.sep}`)
    ) {
      return createErrorResponse(404, 'Not Found');
    }

    const stats = await fileSystem.lstat(filePath);

    if (
      !stats.isFile() ||
      stats.isSymbolicLink() ||
      stats.size <= 0 ||
      stats.size > MAXIMUM_MANAGED_IMAGE_BYTES
    ) {
      return createErrorResponse(404, 'Not Found');
    }

    const contents = await fileSystem.readFile(filePath);

    if (
      contents.length <= 0 ||
      contents.length > MAXIMUM_MANAGED_IMAGE_BYTES ||
      !matchesImageSignature(contents, extension)
    ) {
      return createErrorResponse(404, 'Not Found');
    }

    const digest = createHash('sha256')
      .update(contents)
      .digest('hex')
      .slice(0, 24);

    if (fileName !== `${digest}${extension}`) {
      return createErrorResponse(404, 'Not Found');
    }

    return new Response(method === 'HEAD' ? null : contents, {
      status: 200,
      headers: {
        'Content-Type': IMAGE_MIME_TYPES[extension.slice(1)],
        'Content-Length': String(contents.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Resource-Policy': 'same-origin',
      },
    });
  } catch {
    return createErrorResponse(404, 'Not Found');
  }
}

/**
 * 建立 Electron protocol.handle 使用的本機資源處理器。
 *
 * 公開靜態資源只允許專案白名單目錄；受管理 Logo 與待機背景使用精確路由，
 * 並在每次讀取時重新驗證目前設定、普通檔案、大小、簽章與內容雜湊。
 *
 * @param {object} dependencies
 * @param {string} dependencies.appRoot
 * @param {typeof Electron.net} dependencies.net
 * @param {string|null} [dependencies.managedLogoDirectory]
 * @param {(() => string|null)|null} [dependencies.getAllowedLogoPath]
 * @param {string|null} [dependencies.managedStandbyBackgroundDirectory]
 * @param {(() => string[])|null} [dependencies.getAllowedStandbyBackgroundPaths]
 * @param {typeof defaultFileSystem} [dependencies.fileSystem]
 * @returns {(request: GlobalRequest) => Promise<Response>}
 */
function createLocalProtocolHandler({
  appRoot,
  net,
  managedLogoDirectory = null,
  getAllowedLogoPath = null,
  managedStandbyBackgroundDirectory = null,
  getAllowedStandbyBackgroundPaths = null,
  fileSystem = defaultFileSystem,
}) {
  return async function handleLocalResource(request) {
    const method = request.method || 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      return createErrorResponse(405, 'Method Not Allowed');
    }

    const managedLogo = resolveManagedLogoRequest(request.url);

    if (managedLogo) {
      return serveManagedImage({
        ...managedLogo,
        method,
        assetPathPrefix: 'logos',
        managedDirectory: managedLogoDirectory,
        getAllowedPath: getAllowedLogoPath,
        fileSystem,
      });
    }

    const managedStandbyBackground =
      resolveManagedStandbyBackgroundRequest(request.url);

    if (managedStandbyBackground) {
      return serveManagedImage({
        ...managedStandbyBackground,
        method,
        assetPathPrefix: 'standby-backgrounds',
        managedDirectory: managedStandbyBackgroundDirectory,
        getAllowedPaths: getAllowedStandbyBackgroundPaths,
        fileSystem,
      });
    }

    const resourcePath = resolveAppResource(appRoot, request.url);

    if (!resourcePath) {
      return createErrorResponse(404, 'Not Found');
    }

    try {
      return await net.fetch(pathToFileURL(resourcePath).toString());
    } catch {
      return createErrorResponse(404, 'Not Found');
    }
  };
}

/**
 * 將本機協定安裝到 DisplayCore 專用 Session。
 *
 * @param {object} dependencies
 * @param {Electron.Protocol} dependencies.protocol
 * @param {typeof Electron.net} dependencies.net
 * @param {string} dependencies.appRoot
 * @param {string} dependencies.managedLogoDirectory
 * @param {() => string|null} dependencies.getAllowedLogoPath
 * @param {string} dependencies.managedStandbyBackgroundDirectory
 * @param {() => string[]} dependencies.getAllowedStandbyBackgroundPaths
 */
function installLocalProtocol({
  protocol,
  net,
  appRoot,
  managedLogoDirectory,
  getAllowedLogoPath,
  managedStandbyBackgroundDirectory,
  getAllowedStandbyBackgroundPaths,
}) {
  protocol.handle(
    APP_SCHEME,
    createLocalProtocolHandler({
      appRoot,
      net,
      managedLogoDirectory,
      getAllowedLogoPath,
      managedStandbyBackgroundDirectory,
      getAllowedStandbyBackgroundPaths,
    }),
  );
}

module.exports = {
  APP_SCHEME,
  createLocalProtocolHandler,
  installLocalProtocol,
  registerAppScheme,
  resolveAppResource,
  resolveManagedLogoRequest,
  resolveManagedStandbyBackgroundRequest,
};
