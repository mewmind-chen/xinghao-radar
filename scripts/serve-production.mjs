#!/usr/bin/env node
/**
 * Stable single-process runner for the built Nitro server.
 *
 * Vite preview is useful for development, but it can restart or re-load the
 * Nitro entry while a PGlite database is opening. Production must load one
 * server entry once and keep one database owner for the whole process.
 */
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { serve } from "srvx/node";
import { serveStatic } from "srvx/static";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const outputDir = resolve(process.env.RADAR_OUTPUT_DIR || resolve(root, ".vercel/output"));
const staticDir = resolve(outputDir, "static");
const entryPath = resolve(outputDir, "functions/__server.func/index.mjs");
const entry = await import(pathToFileURL(entryPath).href);
const app = entry.default ?? entry;

if (!app || typeof app.fetch !== "function") {
  throw new Error(`Production server entry has no fetch handler: ${entryPath}`);
}

const port = Number(process.env.RADAR_PORT || process.env.PORT || 8082);
const hostname = process.env.RADAR_HOST || "0.0.0.0";
const release = process.env.RADAR_RELEASE || "unversioned";
const HASHED_ASSET_PATH = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|map|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif)$/;
const HASHED_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid RADAR_PORT: ${String(process.env.RADAR_PORT || process.env.PORT)}`);
}

// Force the bundled server to finish its Better Auth/PGlite bootstrap before
// the socket accepts traffic. A failed database start must fail the process so
// launchd can restart it, instead of serving a page that can never log in.
const bootstrapOrigin = process.env.BETTER_AUTH_URL || `http://127.0.0.1:${port}`;
const bootstrapResponse = await app.fetch(
  new Request(new URL("/api/auth/get-session", bootstrapOrigin), {
    headers: { accept: "application/json" },
  }),
);
if (!bootstrapResponse.ok) {
  throw new Error(`Authentication bootstrap failed with HTTP ${bootstrapResponse.status}`);
}

const server = serve({
  ...app,
  hostname,
  port,
  gracefulShutdown: true,
  middleware: [
    async (request, next) => {
      if (new URL(request.url).pathname === "/healthz") {
        return new Response(JSON.stringify({ ok: true, release }), {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/json; charset=utf-8",
            "x-radar-version": release,
          },
        });
      }
      const pathname = new URL(request.url).pathname;
      const response = await next();
      const headers = new Headers(response.headers);
      headers.set("x-radar-version", release);
      if (HASHED_ASSET_PATH.test(pathname)) {
        headers.set("cache-control", HASHED_ASSET_CACHE_CONTROL);
      }
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    },
    serveStatic({ dir: staticDir }),
    ...(Array.isArray(app.middleware) ? app.middleware : []),
  ],
});

await server.ready();
console.log(`[radar] production server listening on http://${hostname}:${port}`);
console.log(`[radar] output=${outputDir}`);
console.log(`[radar] release=${release}`);
