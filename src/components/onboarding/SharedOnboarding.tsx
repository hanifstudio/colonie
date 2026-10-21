// New workspace → Shared: the Shared workspace onboarding on its own, in the
// same card as the first run. It ends by opening the new workspace, where
// its admin goes on connecting AI and inviting people.
import { useEffect, useState } from "react";
import { OPEN_CREATE_SHARED } from "../CreateSharedWorkspace";
import { WelcomeFlow } from "./WelcomeFlow";

export function SharedOnboarding() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!window.colonie?.environments) return;
    const show = () => setOpen(true);
    window.addEventListener(OPEN_CREATE_SHARED, show);
    return () => window.removeEventListener(OPEN_CREATE_SHARED, show);
  }, []);
  if (!open) return null;
  return <WelcomeFlow bot={null} sharedOnly entrance="switch" onDone={() => setOpen(false)} />;
}
