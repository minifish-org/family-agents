import { useEffect, useState } from "react";

type InstallPromptEvent = Event & { prompt(): Promise<unknown> };

export function InstallApp() {
  const [pending, setPending] = useState<InstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    const display = window.matchMedia("(display-mode: standalone)");
    const onDisplay = () => {
      setInstalled(display.matches);
      if (display.matches) setPending(null);
    };
    const onAvailable = (event: Event) => {
      const prompt = event as InstallPromptEvent;
      if (display.matches || typeof prompt.prompt !== "function") return;
      event.preventDefault();
      setPending(prompt);
      setMessage("");
    };
    const onInstalled = () => {
      setInstalled(true);
      setPending(null);
      setMessage("");
    };
    onDisplay();
    window.addEventListener("beforeinstallprompt", onAvailable);
    window.addEventListener("appinstalled", onInstalled);
    display.addEventListener("change", onDisplay);
    return () => {
      window.removeEventListener("beforeinstallprompt", onAvailable);
      window.removeEventListener("appinstalled", onInstalled);
      display.removeEventListener("change", onDisplay);
    };
  }, []);

  async function install() {
    if (!pending) return;
    // A browser-provided install event can only be used once, even if dismissed.
    const event = pending;
    setPending(null);
    try {
      await event.prompt();
    } catch {
      setMessage("Use Chrome's menu to install Family Agents.");
    }
  }

  if (installed) return null;
  if (message) return <p className="install-hint" role="status">{message}</p>;
  if (!pending) return null;
  return (
    <button type="button" className="secondary small" onClick={() => void install()}>
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="none">
        <path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Install App
    </button>
  );
}
