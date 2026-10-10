import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useConfirm } from '../confirm.jsx';
import { MatterBody } from '../matter.jsx';
import { Link, useRobots } from '../router.jsx';
import { ErrorNote, Loading, Notice, Time, useAction } from '../ui.jsx';
import { words } from '../words.js';

const PAGE = 20;
const BIN_DAYS = [3, 7, 14, 30, null];

function KeptMatter({ post, onGone }) {
  const { run, busy, error } = useAction();
  const decayed = Boolean(post.archived_at);
  const confirm = useConfirm();
  const act = async (method, path, question, options) => {
    if (question && !(await confirm(question, options))) return;
    run(async () => {
      await api(path, { method });
      onGone(post.id);
    });
  };

  return (
    <article className="matter" aria-label={`your ${decayed ? words.decayed : words.decomposing} matter`}>
      <header className="matter-meta">
        <Time iso={post.created_at} />
        {post.parent_id
          ? <Link to={`/thread/${post.parent_id}`}>{words.germination}</Link>
          : post.tier !== 'public' && <span className="tier">{words.tiers[post.tier]}</span>}
      </header>
      <MatterBody html={post.html} />
      <p className="quiet">
        {decayed && <>{words.decayed} <Time iso={post.archived_at} /></>}
        {!decayed && (post.gone_at ? <>rots <Time iso={post.gone_at} /></> : 'stays until you rot it')}
      </p>
      <footer className="matter-actions">
        <button type="button" className="quiet-button" disabled={busy} onClick={() => act('POST', `/api/matter/${post.id}/restore`)}>{words.restore}</button>
        {decayed
          ? <button type="button" className="quiet-button" disabled={busy} onClick={() => act('POST', `/api/matter/${post.id}/bin`)}>{words.decompose}</button>
          : <button type="button" className="quiet-button" disabled={busy} onClick={() => act('POST', `/api/matter/${post.id}/archive`)}>{words.decay}</button>}
        <button type="button" className="quiet-button" disabled={busy} onClick={() => act('DELETE', `/api/matter/${post.id}`, words.rotConfirm, { yes: words.rot, danger: true })}>{words.rot}</button>
      </footer>
      <ErrorNote error={error} />
    </article>
  );
}

function BinDays({ me, onSaved }) {
  const [days, setDays] = useState(me.settings.bin_days);
  const [saved, setSaved] = useState(false);
  const { run, busy, error } = useAction();
  const save = (event) => {
    event.preventDefault();
    run(async () => {
      await api('/api/me/settings', { method: 'PATCH', body: { bin_days: days } });
      setSaved(true);
      onSaved();
    });
  };
  return (
    <form className="panel stack" onSubmit={save}>
      <label className="field inline" htmlFor="bin-days">
        <span>{words.decomposing} matter rots after</span>
        <select id="bin-days" value={days ?? 'never'} onChange={(event) => { setSaved(false); setDays(event.target.value === 'never' ? null : Number(event.target.value)); }}>
          {BIN_DAYS.map((value) => <option key={value ?? 'never'} value={value ?? 'never'}>{value ? `${value} days` : 'never'}</option>)}
        </select>
      </label>
      <div className="buttons"><button type="submit" disabled={busy}>save</button></div>
      {saved && <Notice>saved. it counts from when each matter started {words.decomposing}.</Notice>}
      <ErrorNote error={error} />
    </form>
  );
}

// decayed matter=private archive. decomposing matter=bin. rots=perm auto-del on time-sched
export function KeptScreen({ me, kind, onChanged }) {
  useRobots(false);
  const archive = kind === 'archive';
  const [posts, setPosts] = useState(null);
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  const confirm = useConfirm();
  const path = archive ? '/api/me/archive' : '/api/me/bin';

  const load = (offset) => run(async () => {
    const page = await api(`${path}?limit=${PAGE}&offset=${offset}`);
    setPosts((current) => (offset === 0 ? page.posts : [...(current ?? []), ...page.posts]));
    setDone(page.posts.length < PAGE);
  });

  useEffect(() => {
    if (!me) return;
    setPosts(null);
    load(0);
  }, [path, me?.settings.bin_days]);

  if (!me) return <p><Link to="/auth">sign in</Link> to see your {archive ? words.decayed : words.decomposing} matter.</p>;

  const rotAll = async () => {
    if (!(await confirm(words.rotAllConfirm, { yes: 'rot everything', danger: true }))) return;
    run(async () => {
      await api('/api/me/bin', { method: 'DELETE' });
      setPosts([]);
    });
  };
  const gone = (id) => setPosts((current) => current.filter((p) => p.id !== id));

  return (
    <section aria-labelledby="kept-heading">
      <p><Link to="/">{words.back}</Link></p>
      <h1 id="kept-heading">{archive ? words.decayed : words.decomposing}</h1>
      <p className="quiet">
        {archive
          ? 'only you see these. nobody can germinate or otherwise interact with them. restore one to put it back where it was.'
          : 'nobody sees these, you included, until you restore them. they rot on their own.'}{' '}
        <Link to={archive ? '/bin' : '/archive'}>{archive ? words.decomposing : words.decayed}</Link> is the other place matter waits.
      </p>
      {!archive && <BinDays me={me} onSaved={onChanged} />}
      <ErrorNote error={error} />
      {posts === null && !error && <Loading />}
      {posts?.length === 0 && <p className="empty">{archive ? words.emptyDecayed : words.emptyDecomposing}</p>}
      <div className="matter-list">
        {posts?.map((post) => <KeptMatter key={post.id} post={post} onGone={gone} />)}
      </div>
      {posts?.length > 0 && !done && (
        <button type="button" className="more" onClick={() => load(posts.length)} disabled={busy}>more</button>
      )}
      {!archive && posts?.length > 0 && (
        <div className="buttons"><button type="button" className="danger" onClick={rotAll} disabled={busy}>{words.rotAll}</button></div>
      )}
    </section>
  );
}
