import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useConfirm } from '../confirm.jsx';
import { Matter } from '../matter.jsx';
import { Link, navigate, useRobots } from '../router.jsx';
import { ErrorNote, Loading, Time, useAction } from '../ui.jsx';
import { words } from '../words.js';

function RelationButtons({ handle, relation, onChange }) {
  const { run, busy, error } = useAction();
  const confirm = useConfirm();
  const act = async (method, path, question, options) => {
    if (question && !(await confirm(question, options))) return;
    run(async () => onChange((await api(`${path}/${handle}`, { method })).relation));
  };

  return (
    <div className="relation">
      <div className="badges">
        {relation.mutual && <span className="badge">{words.mutuals}</span>}
        {!relation.mutual && relation.followed_by && <span className="badge">your host</span>}
        {relation.friend === 'friends' && <span className="badge">{words.fused}</span>}
      </div>
      <div className="buttons">
        {relation.following
          ? <button type="button" className="secondary" disabled={busy} onClick={() => act('DELETE', '/api/follows')}>{words.unbond}</button>
          : <button type="button" disabled={busy} onClick={() => act('PUT', '/api/follows')}>{words.bond}</button>}

        {relation.friend === 'none' && <button type="button" disabled={busy} onClick={() => act('PUT', '/api/friends')}>{words.fuse}</button>}
        {relation.friend === 'requested' && (
          <button type="button" className="secondary" disabled={busy} onClick={() => act('DELETE', '/api/friends')}>cancel fuse request</button>
        )}
        {relation.friend === 'incoming' && (
          <>
            <button type="button" disabled={busy} onClick={() => act('PUT', '/api/friends')}>accept fuse</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => act('DELETE', '/api/friends')}>decline</button>
          </>
        )}
        {relation.friend === 'friends' && (
          <button type="button" className="secondary" disabled={busy} onClick={() => act('DELETE', '/api/friends', `unfuse from @${handle}?`, { yes: 'unfuse' })}>unfuse</button>
        )}

        <button
          type="button"
          className="quiet-button"
          disabled={busy}
          onClick={() => act('PUT', '/api/blocks', `${words.prune} @${handle}? you disappear from each other; all bonds & fusing between you end.`, { yes: words.prune, danger: true })}
        >
          {words.prune}
        </button>
      </div>
      <ErrorNote error={error} />
    </div>
  );
}

// 1 line of status; whoever can see the profile sees it, owner sets or takes it down
function Puffball({ puffball, self, config, onChange }) {
  const [text, setText] = useState(puffball?.text ?? '');
  const { run, busy, error } = useAction();
  const limit = config.puffballChars ?? 140;
  const save = (event) => {
    event.preventDefault();
    run(async () => onChange((await api('/api/me/puffball', { method: 'PUT', body: { text } })).puffball));
  };
  const clear = () => run(async () => {
    await api('/api/me/puffball', { method: 'DELETE' });
    setText('');
    onChange(null);
  });

  if (!self) {
    if (!puffball) return null;
    return <p className="puffball"><span className="puffball-label">{words.puffball}</span> {puffball.text}</p>;
  }
  return (
    <form className="puffball-form" onSubmit={save}>
      <label className="field inline" htmlFor="puffball">
        <span>{words.puffball}</span>
        <input id="puffball" maxLength={limit} value={text} placeholder={words.puffballPlaceholder} onChange={(event) => setText(event.target.value)} aria-describedby="puffball-hint" />
      </label>
      <div className="buttons">
        <button type="submit" disabled={busy || !text.trim() || text.trim() === puffball?.text}>{words.puffballSet}</button>
        {puffball && <button type="button" className="secondary" disabled={busy} onClick={clear}>{words.puffballClear}</button>}
      </div>
      <p id="puffball-hint" className="quiet">{words.puffballHint}</p>
      <ErrorNote error={error} />
    </form>
  );
}

export function ProfileScreen({ handle, me, config }) {
  const [profile, setProfile] = useState(null);
  const [refused, setRefused] = useState(null);
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  const admin = useAction();
  const confirm = useConfirm();
  useRobots(profile?.visibility === 'public');

  const load = (offset) => run(async () => {
    try {
      const page = await api(`/api/spore/${handle}?limit=20&offset=${offset}`);
      setRefused(null);
      setProfile((current) => (offset === 0 ? page : { ...page, posts: [...current.posts, ...page.posts] }));
      setDone(page.posts.length < 20);
    } catch (err) {
      if (err.status !== 403) throw err;
      setRefused(err.data);
    }
  });

  useEffect(() => {
    setProfile(null);
    setRefused(null);
    load(0);
  }, [handle, me?.handle]);

  const relationChanged = (relation) => {
    if (relation.blocking) return navigate('/');
    if (profile) setProfile({ ...profile, relation });
    if (refused) load(0);
  };

  const disable = async () => {
    if (!(await confirm(`disable @${handle}? it will be signed out everywhere & all matter disappears until you enable them.`, { yes: 'disable', danger: true }))) return;
    admin.run(async () => {
      await api(`/api/admin/users/${handle}/disable`, { method: 'POST' });
      navigate('/');
    });
  };

  const self = me?.handle === handle;
  const relation = profile?.relation ?? refused?.relation;

  return (
    <section aria-labelledby="profile-heading">
      <p><Link to="/">{words.back}</Link></p>
      <h1 id="profile-heading" className="profile-handle">@{handle}</h1>
      <ErrorNote error={error && (error === 'not found' ? 'no spore by that name.' : error)} />
      {!profile && !refused && !error && <Loading />}

      {profile && (
        <p className="quiet">
          joined <Time iso={profile.joined} />
          {profile.email && <> · <a href={`mailto:${profile.email}`}>{profile.email}</a></>}
        </p>
      )}
      {profile && <Puffball key={self ? 'mine' : 'theirs'} puffball={profile.puffball} self={self} config={config} onChange={(puffball) => setProfile({ ...profile, puffball })} />}
      {self && (
        <p className="quiet">
          this is you. change who sees what in <Link to="/settings">{words.soil}</Link>. out of view:{' '}
          <Link to="/archive">{words.decayed}</Link>, <Link to="/bin">{words.decomposing}</Link>.
        </p>
      )}
      {me?.handle && relation && <RelationButtons handle={handle} relation={relation} onChange={relationChanged} />}
      {me?.admin && !self && (profile || refused) && (
        <p><button type="button" className="danger" onClick={disable} disabled={admin.busy}>disable @{handle}</button></p>
      )}
      <ErrorNote error={admin.error} />

      {refused && <p className="notice">{refused.error}.{!me && <> <Link to="/auth">sign in</Link> first.</>}</p>}

      {profile && (
        <>
          {profile.posts.length === 0 && <p className="empty">{words.emptySpore}</p>}
          <div className="matter-list">
            {profile.posts.map((post) => (
              <Matter
                key={post.id}
                post={post}
                canRot={self || me?.admin}
                canMove={self}
                onGone={(id) => setProfile((current) => ({ ...current, posts: current.posts.filter((p) => p.id !== id) }))}
              />
            ))}
          </div>
          {profile.posts.length > 0 && !done && (
            <button type="button" className="more" onClick={() => load(profile.posts.length)} disabled={busy}>more</button>
          )}
        </>
      )}
    </section>
  );
}