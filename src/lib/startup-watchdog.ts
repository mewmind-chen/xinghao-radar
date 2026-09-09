/**
 * Startup status lives outside React so it can still present a recovery action
 * when the application bundle fails before hydration begins.
 */
export const STARTUP_WATCHDOG_TIMEOUT_MS = 10_000;

export const startupWatchdogScript = `(function () {
  var ready = false;
  var timer;
  var categories = {
    script: "script_load_failed",
    runtime: "startup_error",
    timeout: "hydration_timeout"
  };

  function report(category) {
    // Keep diagnostics safe for a login page: the category never includes an
    // exception message, URL, form value, cookie, or other user data.
    if (window.console && typeof window.console.error === "function") {
      window.console.error("[radar-startup] " + category);
    }
  }

  function fail(category) {
    if (ready || document.getElementById("radar-startup-failure")) return;
    window.clearTimeout(timer);
    report(category);

    var panel = document.createElement("div");
    panel.id = "radar-startup-failure";
    panel.setAttribute("role", "alert");
    panel.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:#f3f2ee;color:#1f2937;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;text-align:center';
    panel.innerHTML = '<div><p style="margin:0 0 10px;font-size:18px;font-weight:600">页面加载失败</p><p style="margin:0 0 16px;color:#66635d;font-size:14px;line-height:1.6">请检查网络后重新加载。如果仍然失败，请联系管理员。</p><button type="button" style="border:0;border-radius:8px;padding:10px 16px;background:#1f2937;color:#fff;font-size:16px">重新加载</button></div>';
    panel.querySelector("button").addEventListener("click", function () {
      window.location.reload();
    });
    document.body.appendChild(panel);
  }

  window.__radarStartup = {
    markReady: function () {
      ready = true;
      window.clearTimeout(timer);
    },
    fail: fail
  };

  window.addEventListener("error", function (event) {
    var target = event && event.target;
    // Only a failed module script is fatal to startup. Fonts, icons and the
    // optional platform extension must not cover a usable login page.
    if (target && target !== window) {
      if (String(target.tagName).toUpperCase() === "SCRIPT" && target.type === "module") {
        fail(categories.script);
      }
      return;
    }
    fail(categories.runtime);
  }, true);
  window.addEventListener("unhandledrejection", function () {
    fail(categories.runtime);
  });
  timer = window.setTimeout(function () {
    fail(categories.timeout);
  }, ${STARTUP_WATCHDOG_TIMEOUT_MS});
})();`;

declare global {
  interface Window {
    __radarStartup?: {
      markReady(): void;
      fail(category: string): void;
    };
  }
}
