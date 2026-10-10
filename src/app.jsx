import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from './api.js';
import { Link, useLocation } from './router.jsx';
import { ErrorNote, Loading } from './ui.jsx';
import { words } from './words.js';
import { FeedScreen } from './screens/feed.jsx';
import { ThreadScreen } from './screens/thread.jsx';
import { ProfileScreen } from './screens/profile.jsx';
import { AuthScreen, HandlePicker, RequestAccessScreen } from './screens/auth.jsx';
import { AdminScreen, PrivacyScreen, SettingsScreen } from './screens/settings.jsx';
import { KeptScreen } from './screens/kept.jsx';
import { AboutScreen, ContactScreen, TermsScreen } from './screens/pages.jsx';

// theme & font only things kept in the browser
function remembered(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}

function usePreference(key, fallback) {
  const [value, setValue] = useState(() => remembered(key, fallback));
  useEffect(() => remember(key, value), [key, value]);
  return [value, setValue];
}

function Screen({ path, hash, me, config, refresh }) {
  let match;
  if (path === '/') return <FeedScreen me={me} config={config} kind="feed" />;
  if (path === '/substrate') return me ? <FeedScreen me={me} config={config} kind="substrate" /> : <p><Link to="/auth">sign in</Link> to see your {words.substrate}.</p>;
  if (path === '/auth') return <AuthScreen me={me} config={config} hash={hash} onSignedIn={refresh} />;
  if (path === '/request-access') return <RequestAccessScreen />;
  if (path === '/settings') return <SettingsScreen me={me} onChanged={refresh} />;
  if (path === '/admin') return <AdminScreen me={me} />;
  if (path === '/archive' || path === '/bin') return <KeptScreen me={me} kind={path.slice(1)} onChanged={refresh} />;
  if (path === '/privacy') return <PrivacyScreen />;
  if (path === '/about') return <AboutScreen />;
  if (path === '/terms') return <TermsScreen />;
  if (path === '/contact') return <ContactScreen />;
  if ((match = path.match(/^\/thread\/([0-9a-f]{24})$/))) return <ThreadScreen id={match[1]} me={me} config={config} />;
  if ((match = path.match(/^\/@([a-z0-9_]{1,20})$/))) return <ProfileScreen handle={match[1]} me={me} />;
  return <p>nothing grows here. <Link to="/">{words.back}</Link></p>;
}

export function App() {
  const { path, hash } = useLocation();
  const [me, setMe] = useState(undefined);
  const [config, setConfig] = useState(null);
  const [error, setError] = useState(null);
  const [theme, setTheme] = usePreference('theme', 'dark');
  const [font, setFont] = usePreference('font', 'mono');
  const [size, setSize] = usePreference('size', 'medium');

  const refresh = useCallback(async () => {
    try {
      setMe((await api('/api/me')).user);
    } catch (err) {
      if (err.status === 401) setMe(null);
      else setError(err.message);
    }
  }, []);

  useEffect(() => {
    refresh();
    api('/api/config').then(setConfig, (err) => setError(err.message));
  }, [refresh]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.font = font;
    document.documentElement.dataset.size = size;
  }, [theme, font, size]);

  // new screen starts reading content auto
  const arrived = useRef(false);
  useEffect(() => {
    if (arrived.current) document.getElementById('main')?.focus({ preventScroll: true });
    arrived.current = true;
  }, [path]);

  const current = (to) => (path === to ? 'page' : undefined);

  return (
    <div className="app">
      <a className="skip" href="#main">skip to content</a>
      <header className="top">
        <Link to="/" className="mark">{words.mark}</Link>
        <nav aria-label="main">
          <Link to="/" aria-current={current('/')}>{words.feed}</Link>
          {me && <Link to="/substrate" aria-current={current('/substrate')}>{words.substrate}</Link>}
          {me?.handle && <Link to={`/@${me.handle}`} aria-current={current(`/@${me.handle}`)}>@{me.handle}</Link>}
          {me && <Link to="/settings" aria-current={current('/settings')}>{words.soil}</Link>}
          {me?.admin && <Link to="/admin" aria-current={current('/admin')}>{words.stewards}</Link>}
          {me === null && <Link to="/auth" aria-current={current('/auth')}>sign in</Link>}
        </nav>
        <div className="toggles">
          <button type="button" className="toggle" aria-pressed={theme === 'light'} onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}>
            {theme === 'light' ? 'dark' : 'light'}
          </button>
          <select id="font-select" aria-label="font" value={font} onChange={(event) => setFont(event.target.value)}>
            <option value="mono">mono</option>
            <option value="sans">sans</option>
            <option value="serif">serif</option>
            <option value="readable">readable</option>
          </select>
          <select id="size-select" aria-label="text size" value={size} onChange={(event) => setSize(event.target.value)}>
            <option value="small">small</option>
            <option value="medium">medium</option>
            <option value="large">large</option>
          </select>
        </div>
      </header>

      <main id="main" tabIndex={-1}>
        <ErrorNote error={error} />
        {(me === undefined || !config) && !error && <Loading />}
        {me !== undefined && config && (
          <>
            {me && !me.handle && path !== '/auth' && (
              <div className="panel"><HandlePicker onPicked={refresh} /></div>
            )}
            <Screen path={path} hash={hash} me={me} config={config} refresh={refresh} />
          </>
        )}
      </main>

      <footer className="bottom">
        <Link to="/about" aria-current={current('/about')}>about</Link>
        <Link to="/privacy" aria-current={current('/privacy')}>privacy</Link>
        <Link to="/terms" aria-current={current('/terms')}>terms</Link>
        <Link to="/contact" aria-current={current('/contact')}>contact</Link>
      </footer>
    </div>
  );
}
