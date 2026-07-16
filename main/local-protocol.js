'use strict';

const { createHash } = require('node:crypto');
const defaultFileSystem = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const {
  MAXIMUM_LOGO_BYTES,
  matchesImageSignature,
} = require('../config/logo-importer');

const APP_SCHEME = 'displaycore';
const APP_HOST = 'app';
const ALLOWED_RESOURCE_ROOTS = new Set(['assets', 'control', 'display']);
const MANAGED_LOGO_ROUTE = /^\/managed\/logo\/([a-f0-9]{24}\.(png|jpg|webp))$/;
const LOGO_MIME_TYPES = Object.freeze({
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

function resolveManagedLogoRequest(requestUrl) {
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

  const match = MANAGED_LOGO_ROUTE.exec(parsedUrl.pathname);

  if (!match) {
    return null;
  }

  return Object.freeze({ fileName: match[1], extension: `.${match[2]}` });
}

async function serveManagedLogo({
  fileName,
  extension,
  method,
  managedLogoDirectory,
  getAllowedLogoPath,
  fileSystem,
}) {
  if (
    typeof managedLogoDirectory !== 'string' ||
    managedLogoDirectory.length === 0 ||
    typeof getAllowedLogoPath !== 'function'
  ) {
    return createErrorResponse(404, 'Not Found');
  }

  try {
    const expectedAssetPath = `logos/${fileName}`;

    if (getAllowedLogoPath() !== expectedAssetPath) {
      return createErrorResponse(404, 'Not Found');
    }

    const allowedRoot = path.resolve(managedLogoDirectory);
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
      stats.size > MAXIMUM_LOGO_BYTES
    ) {
      return createErrorResponse(404, 'Not Found');
    }

    const contents = await fileSystem.readFile(filePath);

    if (
      contents.length <= 0 ||
      contents.length > MAXIMUM_LOGO_BYTES ||
      !matchesImageSignature(contents, extension)
    ) {
      return createErrorResponse(404, 'Not Found');
    }

    const digest = createHash('sha256')
      .update(contents)
      .digest('hex')
      .slice(0, 24);

    if (!fileName.startsWith(`${digest}.`)) {
      return createErrorResponse(404, 'Not Found');
    }

    return new Response(method === 'HEAD' ? null : contents, {
      status: 200,
      headers: {
        'Content-Type': LOGO_MIME_TYPES[extension.slice(1)],
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
 * @param {object} dependencies
 * @param {string} dependencies.appRoot
 * @param {typeof Electron.net} dependencies.net
 * @returns {(request: GlobalRequest) => Promise<Response>}
 */
function createLocalProtocolHandler({
  appRoot,
  net,
  managedLogoDirectory = null,
  getAllowedLogoPath = null,
  fileSystem = defaultFileSystem,
}) {
  return async function handleLocalResource(request) {
    const method = request.method || 'GET';

    if (method !== 'GET' && method !== 'HEAD') {
      return createErrorResponse(405, 'Method Not Allowed');
    }

    const managedLogo = resolveManagedLogoRequest(request.url);

    if (managedLogo) {
      return serveManagedLogo({
        ...managedLogo,
        method,
        managedLogoDirectory,
        getAllowedLogoPath,
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
 */
function installLocalProtocol({
  protocol,
  net,
  appRoot,
  managedLogoDirectory,
  getAllowedLogoPath,
}) {
  protocol.handle(
    APP_SCHEME,
    createLocalProtocolHandler({
      appRoot,
      net,
      managedLogoDirectory,
      getAllowedLogoPath,
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
};
