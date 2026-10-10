import { useEffect, useState } from 'react';
import { api, base } from '../api.js';
import { Link, navigate, useRobots } from '../router.jsx';
import { ErrorNote, Loading, Notice, TierSelect, useAction } from '../ui.jsx';
import { words } from '../words.js';

function WhoSees({ me, onSaved }) {
  const [settings, setSettings] = useState(me.settings);
  const [saved, setSaved] = useState(false);
  const { run, busy, error } = useAction();
  const change = (key) => (tier) => {
    setSaved(false);
    setSettings({ ...settings, [key]: tier });
  };
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/api/me/settings', { method: 'PATCH', body: settings });
      setSaved(true);
      onSaved();
    });
  };
  return (
    <form className="panel stack" onSubmit={save} aria-labelledby="who-heading">
      <h2 id="who-heading">who sees what</h2>
      <TierSelect id="tier-profile" label="your spore & everything on it" value={settings.profile} onChange={change('profile')} />
      <TierSelect id="tier-matter" label="new matter, unless you pick otherwise" value={settings.matter} onChange={change('matter')} />
      <TierSelect id="tier-email" label="your email address" value={settings.email} onChange={change('email')} />
      <p className="quiet">
        {words.tiers.followers} hides you from anyone signed out & from search engines. {words.tiers.friends} is
        only people you've {words.fused} with. {words.tiers.private} is only you.
      </p>
      <div className="buttons"><button type="submit" disabled={busy}>save</button></div>
      {saved && <Notice>saved.</Notice>}
      <ErrorNote error={error} />
    </form>
  );
}

function People() {
  const [people, setPeople] = useState(null);
  const { run, busy, error } = useAction();
  const load = () => run(async () => setPeople(await api('/api/me/relations')));
  useEffect(() => { load(); }, []);
  const act = (method, path, handle) => run(async () => {
    await api(`${path}/${handle}`, { method });
    setPeople(await api('/api/me/relations'));
  });

  const list = (title, handles, actions = []) => (
    <div className="people">
      <h3>{title} ({handles.length})</h3>
      {handles.length === 0 ? <p className="quiet">none yet.</p> : (
        <ul>
          {handles.map((handle) => (
            <li key={handle}>
              <Link to={`/@${handle}`}>@{handle}</Link>
              {actions.map(([label, method, path]) => (
                <button key={label} type="button" className="quiet-button" disabled={busy} onClick={() => act(method, path, handle)}>{label}</button>
              ))}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className="panel" aria-labelledby="people-heading">
      <h2 id="people-heading">your people</h2>
      <ErrorNote error={error} />
      {!people && !error && <Loading />}
      {people && (
        <>
          {list('fuse requests', people.requests.incoming, [['accept', 'PUT', '/api/friends'], ['decline', 'DELETE', '/api/friends']])}
          {list(words.fused, people.friends, [['unfuse', 'DELETE', '/api/friends']])}
          {list(words.mutuals, people.mutuals)}
          {list(words.hosts, people.followers, [['remove', 'DELETE', '/api/followers']])}
          {list(words.bonded, people.following, [[words.unbond, 'DELETE', '/api/follows']])}
          {list('fuse requests you sent', people.requests.outgoing, [['cancel', 'DELETE', '/api/friends']])}
          {list(words.pruned, people.blocked, [['unprune', 'DELETE', '/api/blocks']])}
        </>
      )}
    </section>
  );
}

function Password({ me, onChanged }) {
  const [password, setPassword] = useState('');
  const [current, setCurrent] = useState('');
  const [done, setDone] = useState(null);
  const { run, busy, error } = useAction();
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/api/me/password', { method: 'POST', body: { password, current: current || undefined } });
      setPassword('');
      setCurrent('');
      setDone('password saved. every other session was signed out.');
      onChanged();
    });
  };
  const remove = () => run(async () => {
    await api('/api/me/password', { method: 'DELETE', body: { current: current || undefined } });
    setDone('password removed. sign in by link from now on.');
    onChanged();
  });
  return (
    <form className="panel stack" onSubmit={save} aria-labelledby="password-heading">
      <h2 id="password-heading">password</h2>
      <p className="quiet">
        {me.has_password ? 'you can sign in with a password.' : 'no password yet. links always work; a password is optional.'}
      </p>
      {me.has_password && (
        <label className="field" htmlFor="current-password">
          <span>current password (not needed within 15 minutes of signing in)</span>
          <input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(event) => setCurrent(event.target.value)} />
        </label>
      )}
      <label className="field" htmlFor="new-password">
        <span>{me.has_password ? 'new password' : 'password'}, at least 12 characters</span>
        <input id="new-password" type="password" autoComplete="new-password" minLength={12} maxLength={256} value={password} onChange={(event) => setPassword(event.target.value)} />
      </label>
      <div className="buttons">
        <button type="submit" disabled={busy || password.length < 12}>save password</button>
        {me.has_password && <button type="button" className="secondary" onClick={remove} disabled={busy}>remove password</button>}
      </div>
      {done && <Notice>{done}</Notice>}
      <ErrorNote error={error} />
    </form>
  );
}

function DeleteAccount({ me, onDeleted }) {
  const [confirmText, setConfirmText] = useState('');
  const { run, busy, error } = useAction();
  const expected = me.handle ?? me.email;
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/api/me', { method: 'DELETE', body: { confirm: confirmText } });
      onDeleted();
    });
  };
  return (
    <form className="panel stack danger-zone" onSubmit={submit} aria-labelledby="delete-heading">
      <h2 id="delete-heading">delete your account</h2>
      <p>everything goes: your matter, the germinations under it, your germinations elsewhere, every bond & fusion. render your spore print first if you want a copy.</p>
      <label className="field" htmlFor="delete-confirm">
        <span>type {me.handle ? 'your handle' : 'your email address'} ({expected}) to confirm</span>
        <input id="delete-confirm" autoComplete="off" value={confirmText} onChange={(event) => setConfirmText(event.target.value)} />
      </label>
      <div className="buttons"><button type="submit" className="danger" disabled={busy || confirmText !== expected}>delete everything</button></div>
      <ErrorNote error={error} />
    </form>
  );
}

export function SettingsScreen({ me, onChanged }) {
  useRobots(false);
  const signOut = useAction();
  if (!me) return <p><Link to="/auth">sign in</Link> to reach your {words.soil}.</p>;

  const leave = () => signOut.run(async () => {
    await api('/auth/logout', { method: 'POST' });
    onChanged();
    navigate('/');
  });

  return (
    <section aria-labelledby="soil-heading">
      <h1 id="soil-heading">{words.soil}</h1>
      <p className="quiet">signed in as {me.email}{me.handle && <> · <Link to={`/@${me.handle}`}>@{me.handle}</Link></>}</p>
      <WhoSees me={me} onSaved={onChanged} />
      <People />
      <Password me={me} onChanged={onChanged} />
      <section className="panel stack" aria-labelledby="linked-heading">
        <h2 id="linked-heading">linked sign-ins</h2>
        <p className="quiet">{me.linked.length ? me.linked.join(', ') : 'none. signing in with github or google under this address links them.'}</p>
      </section>
      <section className="panel stack" aria-labelledby="print-heading">
        <h2 id="print-heading">spore print</h2>
        <p className="quiet">everything you've written, at every tier, and who you're tied to. produced as a single portable file.</p>
        <div className="buttons"><a className="button" href={`${base}/api/me/export`} download>{words.sporePrint}</a></div>
      </section>
      <section className="panel stack" aria-labelledby="kept-heading">
        <h2 id="kept-heading">out of view</h2>
        <p className="quiet">
          {words.decayed} matter waits for you alone; {words.decomposing} matter rots on its own unless you restore it.
          both are in your spore print.
        </p>
        <p><Link to="/archive">{words.decayed}</Link> · <Link to="/bin">{words.decomposing}</Link></p>
      </section>
      <DeleteAccount me={me} onDeleted={() => { onChanged(); navigate('/'); }} />
      <div className="buttons"><button type="button" className="secondary" onClick={leave} disabled={signOut.busy}>sign out</button></div>
      <ErrorNote error={signOut.error} />
    </section>
  );
}

export function AdminScreen({ me }) {
  useRobots(false);
  const [status, setStatus] = useState('pending');
  const [requests, setRequests] = useState(null);
  const { run, busy, error } = useAction();
  const load = () => run(async () => setRequests((await api(`/api/admin/requests?status=${status}`)).requests));
  useEffect(() => { if (me?.admin) load(); }, [status, me?.admin]);
  if (!me?.admin) return <p>only {words.stewards} can see this.</p>;

  const decide = (id, decision) => run(async () => {
    await api(`/api/admin/requests/${id}/${decision}`, { method: 'POST' });
    setRequests((await api(`/api/admin/requests?status=${status}`)).requests);
  });

  return (
    <section aria-labelledby="stewards-heading">
      <h1 id="stewards-heading">{words.stewards}</h1>
      <nav className="tabs" aria-label="requests">
        {['pending', 'approved', 'declined'].map((name) => (
          <button key={name} type="button" className="tab" aria-pressed={status === name} onClick={() => setStatus(name)}>{name}</button>
        ))}
      </nav>
      <ErrorNote error={error} />
      {!requests && !error && <Loading />}
      {requests?.length === 0 && <p className="empty">nothing {status}.</p>}
      <ul className="requests">
        {requests?.map((request) => (
          <li key={request.id} className="panel">
            <p><strong>{request.email}</strong></p>
            {request.note && <p className="note">{request.note}</p>}
            <div className="buttons">
              {status !== 'declined' && <button type="button" onClick={() => decide(request.id, 'approve')} disabled={busy}>{status === 'approved' ? 'send the invite again' : 'let in'}</button>}
              {status === 'pending' && <button type="button" className="secondary" onClick={() => decide(request.id, 'decline')} disabled={busy}>decline</button>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function PrivacyScreen() {
  return (
    <section aria-labelledby="privacy-heading" className="prose">
      <h1 id="privacy-heading">privacy</h1>
      <p>your email address signs you in & remains private unless you choose otherwise in your {words.soil}. it's never shown next to your matter.</p>
      <p>who sees your spore & your matter is up to you: {Object.values(words.tiers).join(', ')}. anything not public is hidden from people signed out & from search engines.</p>
      <p>{words.prune} someone & you disappear from each other.</p>
      <p>the site keeps a cookie that holds your session, and remembers your theme & font in your browser. nothing ever tracks you. nothing is ever sold.</p>
      <p>your spore print is everything you've written as a file. deleting your account removes it all.</p>
      <p>what's held about you: your email address, your handle, what you write, your settings, and a hashed copy of your session. a password, if you set one, is stored only as a hash. signing in with github or google keeps only the account id & verified email address they send back.</p>
      <p>other services handle some of it: Cloudflare serves the page & passes traffic to the API, the API runs on Oracle Cloud, and Resend sends your sign-in emails. each of them sees what that part of the job needs, like your IP address or your email address.</p>
      <p>nothing here tracks you across other sites, so a do-not-track signal has nothing to change. you can see & change what's held in your {words.soil}, or ask by writing to the <Link to="/contact">contact</Link> page.</p>
      <p>last updated 2026-10-09.</p>
    </section>
  );
}
