import { useState } from 'react';
import { api } from './api.js';
import { useConfirm } from './confirm.jsx';
import { Link, followInternalLinks } from './router.jsx';
import { ErrorNote, Time, TierSelect, useAction } from './ui.jsx';
import { words } from './words.js';

// server renders matter escaped txt on every read
// html is safe to place as is
export function MatterBody({ html }) {
  return <div className="matter-body" onClick={followInternalLinks} dangerouslySetInnerHTML={{ __html: html }} />;
}

// canMove = author alone: decay & decompose rm matter from front-view & can be undone
// canRot ± root's author clearing germinations + stewards actions
export function Matter({ post, canRot, canMove, onGone, onChanged, linkToThread = true }) {
  const { run, busy, error } = useAction();
  // morel in a list = card (title + excerpt); on its own page = whole
  const morel = post.kind === 'morel';
  const card = morel && post.html === undefined;
  const [shared, setShared] = useState(Boolean(post.shared));
  const share = () => run(async () => {
    const next = await api(`/api/morels/${post.id}`, { method: 'PATCH', body: { shared: !shared } });
    setShared(next.shared);
    onChanged?.(next);
  });
  const confirm = useConfirm();
  const rot = async () => {
    if (!(await confirm(words.rotConfirm, { yes: words.rot, danger: true }))) return;
    run(async () => {
      await api(`/api/matter/${post.id}`, { method: 'DELETE' });
      onGone?.(post.id);
    });
  };
  const move = (where) => run(async () => {
    await api(`/api/matter/${post.id}/${where}`, { method: 'POST' });
    onGone?.(post.id);
  });

  return (
    <article className="matter" aria-label={`${morel ? words.morel : 'matter'} from @${post.author.handle}`}>
      <header className="matter-meta">
        <Link to={`/@${post.author.handle}`}>@{post.author.handle}</Link>
        <Time iso={post.created_at} />
        {post.tier !== 'public' && !post.parent_id && <span className="tier">{words.tiers[post.tier]}</span>}
      </header>
      {morel && (card
        ? <h2 className="morel-title"><Link to={`/thread/${post.id}`}>{post.title}</Link></h2>
        : <h1 className="morel-title">{post.title}</h1>)}
      {card ? <p className="excerpt">{post.excerpt}</p> : <MatterBody html={post.html} />}
      <footer className="matter-actions">
        {linkToThread && !post.parent_id && (
          card
            ? <Link to={`/thread/${post.id}`}>{post.replies > 0 ? `${words.readMorel} · ${words.germinations(post.replies)}` : words.readMorel}</Link>
            : <Link to={`/thread/${post.id}`}>{post.replies > 0 ? words.germinations(post.replies) : words.viewGerminations}</Link>
        )}
        {morel && canMove && <span className="tier">{shared ? words.onTheFeed : 'not on the feed'}</span>}
        {morel && canMove && <button type="button" className="quiet-button" onClick={share} disabled={busy}>{shared ? words.unshare : words.shareNow}</button>}
        {canMove && <button type="button" className="quiet-button" onClick={() => move('archive')} disabled={busy}>{words.decay}</button>}
        {canMove && <button type="button" className="quiet-button" onClick={() => move('bin')} disabled={busy}>{words.decompose}</button>}
        {canRot && <button type="button" className="quiet-button" onClick={rot} disabled={busy}>{words.rot}</button>}
      </footer>
      <ErrorNote error={error} />
    </article>
  );
}

export function Composer({ me, config, parentId, onPosted }) {
  const [content, setContent] = useState('');
  const [tier, setTier] = useState(me.settings.matter);
  const { run, busy, error } = useAction();
  const limit = config.maxPostChars;
  const length = [...content].length;
  const reply = Boolean(parentId);
  const id = reply ? `germinate-${parentId}` : 'compose';

  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      const post = await api('/api/matter', {
        method: 'POST',
        body: reply ? { content, parent_id: parentId } : { content, tier },
      });
      setContent('');
      onPosted(post);
    });
  };

  return (
    <form className="composer" onSubmit={submit}>
      <label className="visually-hidden" htmlFor={id}>{reply ? words.germinate : words.post}</label>
      <textarea
        id={id}
        value={content}
        onChange={(event) => setContent(event.target.value)}
        placeholder={reply ? words.germinatePlaceholder : words.composer}
        rows={reply ? 3 : 5}
        aria-describedby={`${id}-count`}
      />
      <div className="composer-row">
        {!reply && <TierSelect id={`${id}-tier`} label="who sees it" value={tier} onChange={setTier} disabled={busy} />}
        <span id={`${id}-count`} className={length > limit ? 'count over' : 'count'}>{length} / {limit}</span>
        <button type="submit" disabled={busy || !content.trim() || length > limit}>{reply ? words.germinate : words.post}</button>
      </div>
      <ErrorNote error={error} />
    </form>
  );
}