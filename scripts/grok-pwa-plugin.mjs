/**
 * Dev/preview (Vite) half of the platform PWA chrome: serves the ?install=1
 * tutorial and the per-app manifest, and injects missing PWA head tags into
 * app documents. The deployed-app half lives in server/middleware/grok-pwa.ts;
 * both share scripts/grok-pwa-shared.mjs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  acceptsHtml,
  createHeadInjector,
  injectGrokPwaHead,
  isDocumentPath,
  isInstallQuery,
  renderInstallPageHtml,
  renderWebManifest,
  snapshotOgIdentity,
} from "./grok-pwa-shared.mjs";
import { renderStandaloneLoginPage } from "./mobile-login-page.mjs";

export const GROK_OG_IDENTITY_ID = "virtual:grok-og-identity";
// Documents must revalidate after a deploy, while Vite's hashed static assets
// retain their normal immutable cache policy.
const DOCUMENT_CACHE_CONTROL = "no-cache, no-store, must-revalidate";
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
const HASHED_ASSET_PATH =
  /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif)$/;

const INSTALL_PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), "install-page.html");

function requestHost(req) {
  const forwarded = req.headers["x-forwarded-host"];
  const host = forwarded ?? req.headers.host ?? req.headers[":authority"];
  return Array.isArray(host) ? host[0] : host;
}

export function renderInstallPage(hostHeader, url = "/") {
  const template = readFileSync(INSTALL_PAGE_PATH, "utf8");
  return renderInstallPageHtml(template, { host: hostHeader, url });
}

function sendHtml(res, html) {
  const body = Buffer.from(html, "utf8");
  res.statusCode = 200;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", DOCUMENT_CACHE_CONTROL);
  res.setHeader("content-length", String(body.byteLength));
  res.end(body);
}

function serveGrokPwa(middlewares) {
  middlewares.use((req, res, next) => {
    const rawUrl = req.url ?? "";
    const pathOnly = rawUrl.split("?", 1)[0] ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET") {
      next();
      return;
    }

    if (pathOnly === "/__grok/manifest.webmanifest" || pathOnly === "/__grok/manifest.json") {
      const body = Buffer.from(renderWebManifest(requestHost(req)), "utf8");
      res.statusCode = 200;
      res.setHeader("content-type", "application/manifest+json; charset=utf-8");
      res.setHeader("cache-control", "no-cache");
      res.setHeader("content-length", String(body.byteLength));
      res.end(body);
      return;
    }

    const cookieHeader = req.headers.cookie ?? "";
    const hasSessionCookie = cookieHeader.includes("__Host-grok-auth.session_token=");

    if (
      (pathOnly === "/login" || (isDocumentPath(pathOnly) && !hasSessionCookie)) &&
      acceptsHtml(req.headers.accept)
    ) {
      sendHtml(res, renderStandaloneLoginPage());
      return;
    }

    if (isInstallQuery(rawUrl) && isDocumentPath(pathOnly) && acceptsHtml(req.headers.accept)) {
      try {
        sendHtml(res, renderInstallPage(requestHost(req), rawUrl));
      } catch (err) {
        console.error("[app-builder] install page missing:", err);
        res.statusCode = 500;
        res.end("install page unavailable");
      }
      return;
    }

    next();
  });
}

/**
 * Vite preview does not add a long-lived cache header for its content-hashed
 * assets. Apply one before its static-file middleware runs, without matching
 * HTML documents or unhashed public files.
 */
function cacheHashedAssets(middlewares) {
  middlewares.use((req, res, next) => {
    const pathOnly = (req.url ?? "").split("?", 1)[0] ?? "";
    if ((req.method ?? "GET").toUpperCase() === "GET" && HASHED_ASSET_PATH.test(pathOnly)) {
      res.setHeader("cache-control", HASHED_ASSET_CACHE_CONTROL);
    }
    next();
  });
}

/**
 * Wrap res.write/res.end on app-document requests to inject missing PWA head
 * tags at the `</head>` boundary as chunks stream through (no full-document
 * buffering, so streaming SSR keeps its early flush). Skips anything already
 * content-encoded: under `vite preview` the compression middleware can hand
 * this wrapper gzipped bytes, which must pass through untouched.
 */
function wrapHtmlResponses(middlewares, cwd) {
  middlewares.use((req, res, next) => {
    const rawUrl = req.url ?? "";
    const pathOnly = rawUrl.split("?", 1)[0] ?? "";
    const method = (req.method ?? "GET").toUpperCase();
    const looksLikeDocument =
      method === "GET" &&
      String(req.headers.accept ?? "").includes("text/html") &&
      !isInstallQuery(rawUrl) &&
      isDocumentPath(pathOnly);
    if (!looksLikeDocument) {
      next();
      return;
    }

    // Set this before downstream SSR can flush its first chunk.
    res.setHeader("cache-control", DOCUMENT_CACHE_CONTROL);

    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    const host = requestHost(req);
    const injector = createHeadInjector({
      host,
      cwd,
    });
    let mode = null; // null = undecided, "inject" | "passthrough"

    const decideMode = () => {
      if (mode) return mode;
      const isHtml = String(res.getHeader("content-type") ?? "").includes("text/html");
      const encoded = Boolean(res.getHeader("content-encoding"));
      mode = isHtml && !encoded ? "inject" : "passthrough";
      // Streaming SSR flushes headers before the first body chunk, so the
      // header may no longer be removable — chunked responses don't carry one.
      if (mode === "inject" && !res.headersSent) res.removeHeader("content-length");
      return mode;
    };

    const toBuffer = (chunk, encoding) => {
      if (Buffer.isBuffer(chunk)) return chunk;
      if (typeof chunk === "string") {
        return Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8");
      }
      return Buffer.from(chunk);
    };

    res.write = (chunk, encoding, cb) => {
      if (decideMode() === "passthrough") return originalWrite(chunk, encoding, cb);
      const done = typeof encoding === "function" ? encoding : cb;
      if (chunk) {
        for (const out of injector.push(toBuffer(chunk, encoding))) originalWrite(out);
      }
      if (typeof done === "function") done();
      return true;
    };

    res.end = (chunk, encoding, cb) => {
      const done = typeof encoding === "function" ? encoding : cb;
      if (decideMode() === "passthrough") return originalEnd(chunk, encoding, cb);
      if (chunk) {
        for (const out of injector.push(toBuffer(chunk, encoding))) originalWrite(out);
      }
      for (const out of injector.flush()) originalWrite(out);
      return originalEnd(undefined, undefined, done);
    };

    next();
  });
}

export function grokPwaPlugin() {
  let root = process.cwd();
  return {
    name: "app-builder:grok-pwa",
    configResolved(config) {
      root = config.root;
    },
    resolveId(id) {
      if (id === GROK_OG_IDENTITY_ID) return `\0${GROK_OG_IDENTITY_ID}`;
    },
    load(id) {
      if (id !== `\0${GROK_OG_IDENTITY_ID}`) return;
      return `export const grokOgIdentity = ${JSON.stringify(snapshotOgIdentity(root))};`;
    },
    transformIndexHtml(html) {
      return injectGrokPwaHead(html, {
        host: process.env.VITE_PUBLIC_HOSTNAME ?? "",
        cwd: root,
      });
    },
    configureServer(server) {
      // Registered directly (not in a returned post-hook) so both run BEFORE
      // TanStack Start's SSR middleware, like the auth-popup plugin.
      serveGrokPwa(server.middlewares);
      cacheHashedAssets(server.middlewares);
      wrapHtmlResponses(server.middlewares, root);
    },
    configurePreviewServer(server) {
      serveGrokPwa(server.middlewares);
      // Register before Vite's static-file middleware so the asset header is
      // present when it serves a hashed file.
      cacheHashedAssets(server.middlewares);
      // Post-hook: preview registers compression between the direct hooks and
      // the post-hooks, and the injector must wrap AFTER compression so it
      // sees plaintext HTML (compression then compresses the injected output).
      return () => {
        wrapHtmlResponses(server.middlewares, root);
      };
    },
  };
}
