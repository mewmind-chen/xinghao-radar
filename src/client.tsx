// This must be the first application import. Vite's target transpiles syntax,
// but it does not provide String.prototype.replaceAll for older WebViews.
import "core-js/actual/string/replace-all";

import { StrictMode, startTransition, useEffect } from "react";
import { hydrateRoot } from "react-dom/client";
import { StartClient } from "@tanstack/react-start/client";

function StartupReady() {
  // Effects run only after React has committed hydration, at which point the
  // SSR login controls have their client event handlers attached.
  useEffect(() => {
    window.__radarStartup?.markReady();
  }, []);
  return null;
}

startTransition(() => {
  hydrateRoot(
    document,
    <StrictMode>
      <StartClient />
      <StartupReady />
    </StrictMode>,
    {
      onCaughtError: () => window.__radarStartup?.fail("hydration_error"),
      onUncaughtError: () => window.__radarStartup?.fail("hydration_error"),
    },
  );
});
