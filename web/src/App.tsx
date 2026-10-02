import { useEffect, useState } from 'react';
import { setUnauthorizedHandler } from './api';
import { useLang } from './i18n';
import { refreshPush, serviceWorker } from './lib/push';
import { navigate, useRoute } from './lib/router';
import { connectEvents, disconnectEvents, loadAll, loadSession, useStore } from './store';
import { Login } from './components/Login';
import { Setup } from './components/Setup';
import { Shell } from './components/Shell';
import { Logo, Toasts } from './components/ui';

export function App() {
  useLang();
  const route = useRoute();
  const session = useStore((s) => s.session);
  const [booted, setBooted] = useState(false);

  useEffect(() => {
    // Displays notifications on mobile browsers and opens conversations from them.
    void serviceWorker();
    setUnauthorizedHandler(() => void loadSession().catch(() => undefined));
    loadSession()
      .catch(() => undefined)
      .finally(() => setBooted(true));
  }, []);

  const authenticated = session?.authenticated ?? false;
  useEffect(() => {
    if (!authenticated) return;
    connectEvents();
    void loadAll().catch(() => undefined);
    void refreshPush().catch(() => undefined);
    return () => disconnectEvents();
  }, [authenticated]);

  if (!booted) {
    return (
      <main className="center-screen" aria-busy="true">
        <Logo size={56} />
      </main>
    );
  }

  if (!session?.authenticated) {
    return (
      <>
        <Login onSuccess={() => void loadSession()} />
        <Toasts />
      </>
    );
  }

  if (!session.setupCompleted || route.name === 'setup') {
    return (
      <>
        <Setup
          pollActive={session.pollActiveSeconds}
          pollIdle={session.pollIdleSeconds}
          onDone={async () => {
            await loadSession();
            await loadAll();
            navigate({ name: 'home' }, { replace: true });
          }}
        />
        <Toasts />
      </>
    );
  }

  return <Shell route={route} />;
}
