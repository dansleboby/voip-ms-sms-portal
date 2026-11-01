import { useEffect, useState } from 'react';
import { configProblem, setUnauthorizedHandler } from './api';
import { useLang } from './i18n';
import { refreshPush, serviceWorker } from './lib/push';
import { navigate, useRoute } from './lib/router';
import { connectEvents, disconnectEvents, loadAll, loadSession, useStore } from './store';
import { Login } from './components/Login';
import { NotReady } from './components/Team';
import { Setup } from './components/Setup';
import { Shell } from './components/Shell';
import { Logo, Toasts } from './components/ui';

export function App() {
  useLang();
  const route = useRoute();
  const session = useStore((s) => s.session);
  const [booted, setBooted] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  useEffect(() => {
    // Displays notifications on mobile browsers and opens conversations from them.
    void serviceWorker();
    setUnauthorizedHandler(() => void loadSession().catch(() => undefined));
    loadSession()
      // A server that is not set up yet says why: the sign-in page shows it.
      .catch((err: unknown) => setProblem(configProblem(err)))
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
        <Login problem={problem} mode={session?.mode} onSuccess={() => void loadSession()} />
        <Toasts />
      </>
    );
  }

  // The wizard is for whoever manages the portal; a user waits for them.
  if (session.user?.role === 'user') {
    if (!session.setupCompleted) {
      return (
        <>
          <NotReady />
          <Toasts />
        </>
      );
    }
  } else if (!session.setupCompleted || route.name === 'setup') {
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
