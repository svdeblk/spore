import { useState } from 'react';
import { api, base } from '../api.js';
import { Link, navigate, replace, useRobots } from '../router.jsx';
import { ErrorNote, Notice, useAction } from '../ui.jsx';
import { words } from '../words.js';

const PROVIDERS = { github: 'github', google: 'google' };

const PROBLEMS = {
  expired: 'sign-in took too long or started in another browser. try again.',
  cancelled: 'sign-in was canceled.',
  provider: "provider didn't answer the way it should. try again.",
  'unverified-email': "that account has no verified email address, can't sign in here.",
  refused: "that address can't sign up yet.",
  disabled: 'this account is disabled.',
};

function EmailField({ id, value, onChange }) {
  return (
    <label className="field" htmlFor={id}>
      <span>email</span>
      <input id={id} type="email" autoComplete="email" required value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SignInForm({ config, onSignedIn }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [withPassword, setWithPassword] = useState(false);
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();
  const providers = (config.signIn ?? []).filter((method) => PROVIDERS[method]);

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      if (withPassword) {
        onSignedIn(await api('/auth/password', { method: 'POST', body: { email, password } }));
      } else {
        await api('/auth/request-link', { method: 'POST', body: { email } });
        setSent(true);
      }
    });
  };

  if (sent) {
    return (
      <Notice>
        if that address exists & can sign-in, a link is on its way to {email}. it works once and expires in 15 minutes.{' '}
        <button type="button" className="link-button" onClick={() => setSent(false)}>use another address</button>
      </Notice>
    );
  }

  return (
    <>
      <form className="stack" onSubmit={submit}>
        <EmailField id="signin-email" value={email} onChange={setEmail} />
        {withPassword && (
          <label className="field" htmlFor="signin-password">
            <span>password</span>
            <input id="signin-password" type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} />
          </label>
        )}
        <div className="buttons">
          <button type="submit" disabled={busy}>{withPassword ? 'sign in' : 'email me a link'}</button>
          <button type="button" className="link-button" onClick={() => setWithPassword(!withPassword)}>
            {withPassword ? 'email me a link instead' : 'use a password instead'}
          </button>
        </div>
        <ErrorNote error={error} />
      </form>
      {providers.length > 0 && (
        <div className="providers" role="group" aria-label="or sign in with">
          <p className="quiet">or sign in with</p>
          {providers.map((provider) => (
            <a key={provider} className="button secondary" href={`${base}/auth/oauth/${provider}`}>{PROVIDERS[provider]}</a>
          ))}
        </div>
      )}
      {config.signupMode === 'allowlist' && (
        <p className="quiet">new here? the beta is invite only: <Link to="/request-access">{words.propagate}</Link>.</p>
      )}
    </>
  );
}

// emailed link lands here; redeeming needs click, mail scanner opening link can't spend it
function Continue({ token, email, onSignedIn }) {
  const { run, busy, error } = useAction();
  const go = () => run(async () => {
    const result = await api('/auth/verify', { method: 'POST', body: { token } });
    replace('/auth');
    onSignedIn(result);
  });
  return (
    <div className="stack">
      <p>sign in as <strong>{email || 'this address'}</strong>?</p>
      <div className="buttons"><button type="button" onClick={go} disabled={busy}>continue</button></div>
      <ErrorNote error={error} />
    </div>
  );
}

export function HandlePicker({ onPicked }) {
  const [handle, setHandle] = useState('');
  const { run, busy, error } = useAction();
  const submit = (event) => {
    event.preventDefault();
    run(async () => onPicked((await api('/api/me/handle', { method: 'POST', body: { handle } })).user));
  };
  return (
    <form className="stack" onSubmit={submit}>
      <h2>pick your handle</h2>
      <p className="quiet">3 to 20 characters: a to z, 0 to 9 and _. it's yours for the whole beta and cannot be changed.</p>
      <label className="field" htmlFor="handle">
        <span>handle</span>
        <input
          id="handle"
          autoComplete="username"
          required
          minLength={3}
          maxLength={20}
          pattern="[a-z0-9_]+"
          value={handle}
          onChange={(event) => setHandle(event.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ''))}
        />
      </label>
      <div className="buttons"><button type="submit" disabled={busy || handle.length < 3}>keep it</button></div>
      <ErrorNote error={error} />
    </form>
  );
}

export function AuthScreen({ me, config, hash, onSignedIn }) {
  useRobots(false);
  const params = new URLSearchParams(hash.slice(1));
  const token = params.get('token');
  const problem = params.get('error');

  const signedIn = (result) => {
    onSignedIn();
    if (!result.needsHandle) navigate('/');
  };

  if (token) {
    return (
      <section aria-labelledby="auth-heading">
        <h1 id="auth-heading">sign in</h1>
        <Continue token={token} email={params.get('email')} onSignedIn={signedIn} />
      </section>
    );
  }

  if (me && !me.handle) {
    return <section><HandlePicker onPicked={() => { onSignedIn(); navigate('/'); }} /></section>;
  }

  if (me) {
    return (
      <section>
        <h1>signed in</h1>
        <p>you're signed in as @{me.handle}. <Link to="/">go to the {words.feed}</Link>.</p>
      </section>
    );
  }

  return (
    <section aria-labelledby="auth-heading">
      <h1 id="auth-heading">sign in</h1>
      {problem && (
        <p className="error" role="alert">
          {PROBLEMS[problem] ?? 'during sign-in something went wrong. try again.'}
          {problem === 'refused' && <> <Link to="/request-access">{words.propagate}</Link> to ask for a way in.</>}
        </p>
      )}
      <SignInForm config={config} onSignedIn={signedIn} />
    </section>
  );
}

export function RequestAccessScreen() {
  useRobots(false);
  const [email, setEmail] = useState('');
  const [note, setNote] = useState('');
  const [sent, setSent] = useState(false);
  const { run, busy, error } = useAction();
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/auth/request-access', { method: 'POST', body: { email, note } });
      setSent(true);
    });
  };
  return (
    <section aria-labelledby="propagate-heading">
      <h1 id="propagate-heading">{words.propagate}</h1>
      {sent ? (
        <Notice>received. if approved, an invite lands in your inbox.</Notice>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="quiet">the beta is invite only for now to reduce resource strain. just ask; a steward reads every request.</p>
          <EmailField id="propagate-email" value={email} onChange={setEmail} />
          <label className="field" htmlFor="propagate-note">
            <span>a note, if you like</span>
            <textarea id="propagate-note" rows={3} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} />
          </label>
          <div className="buttons"><button type="submit" disabled={busy}>ask to join</button></div>
          <ErrorNote error={error} />
        </form>
      )}
    </section>
  );
}
