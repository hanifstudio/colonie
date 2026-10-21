import { StrictMode } from "react";
import { AppErrorBoundary } from "./components/AppErrorBoundary";
import { createRoot } from "react-dom/client";
import { bootstrapBrand } from "./lib/brand";
import { applySkin, readSkin } from "./lib/skins";
import { applyFont, readFont } from "./lib/fonts";
import { settleAdvancedModeDefault } from "./lib/interface-mode";
import { setAnalyticsEnabled } from "./lib/analytics";
import "katex/dist/katex.min.css";
import "./styles.css";

// Before the first paint, not inside a component: stamping the skin during
// render would show one frame of the default palette first. The brand (window
// title, accent) is fetched the same way so a white-labelled deployment never
// flashes the default name; it waits at most a moment and falls back silently.
// Simple vs Advanced is decided first: applySkin below writes colonie-skin, which
// would otherwise make every fresh install look like an existing one.
settleAdvancedModeDefault();
// This fork uses local CLI authentication, not the upstream signup/analytics flow.
setAnalyticsEnabled(false);
applySkin(readSkin());
applyFont(readFont());

/** The Local VM's own page is the one route that is not the app shell. */
async function chooseRoot(): Promise<React.ReactNode> {
  if (location.pathname === "/desktop-viewer") {
    const { DesktopViewer } = await import("./components/DesktopViewer");
    return <DesktopViewer />;
  }
  // A browser that the server does not know (a Shared workspace opened
  // without signing in) gets the sign-in page instead of an app that cannot
  // load. The desktop app's own window is the owner and skips the question.
  if (!window.colonie) {
    const { firstScreen, readEnvironment, readSessionState } = await import("./lib/session");
    if (firstScreen(await readSessionState()) === "sign-in") {
      const [{ SignInPage }, environment] = await Promise.all([import("./components/SignInPage"), readEnvironment()]);
      return <SignInPage colonieSignIn={environment?.capabilities.colonieSignIn === true} workspace={environment?.label || "this workspace"} />;
    }
  }
  const { default: App } = await import("./App");
  // The desktop app's own page: a Colonie account first, once (AccountGate).
  if (window.colonie?.localWorkspaces) {
    const { AccountGate } = await import("./components/AccountGate");
    return <AccountGate><App /></AccountGate>;
  }
  return <App />;
}

void Promise.all([bootstrapBrand(), chooseRoot()]).then(([, root]) => {
  createRoot(document.getElementById("root")!).render(<StrictMode><AppErrorBoundary>{root}</AppErrorBoundary></StrictMode>);
}).catch((error: unknown) => {
  // The app's code could not even load: still never a black screen.
  createRoot(document.getElementById("root")!).render(<AppErrorBoundary><Thrown error={error} /></AppErrorBoundary>);
});

function Thrown({ error }: { error: unknown }): never {
  throw error;
}
