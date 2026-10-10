import { useState } from 'react';
import { api } from '../api.js';
import { Link, navigate, useRobots } from '../router.jsx';
import { ErrorNote, TierSelect, useAction } from '../ui.jsx';
import { words } from '../words.js';

// long form: title + up to maxMorelChars of the same dialect as matter
export function MorelScreen({ me, config }) {
  useRobots(false);
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');
  const [tier, setTier] = useState(me?.settings.matter ?? 'public');
  const [share, setShare] = useState(false);
  const { run, busy, error } = useAction();
  if (!me) return <p><Link to="/auth">sign in</Link> to write a {words.morel}.</p>;
  if (!me.handle) return <p>pick a handle first.</p>;

  const limit = config.maxMorelChars;
  const length = [...content].length;
  const submit = (event) => {
    event.preventDefault();
    run(async () => {
      const post = await api('/api/morels', { method: 'POST', body: { title, content, tier, share } });
      navigate(`/thread/${post.id}`);
    });
  };

  return (
    <section aria-labelledby="morel-heading">
      <p><Link to="/">{words.back}</Link></p>
      <h1 id="morel-heading">{words.writeMorel}</h1>
      <p className="quiet">{words.morelHint}</p>
      <form className="stack" onSubmit={submit}>
        <label className="field" htmlFor="morel-title">
          <span>{words.morelTitle}</span>
          <input id="morel-title" maxLength={120} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="field" htmlFor="morel-body">
          <span>{words.morelBody}</span>
          <textarea
            id="morel-body"
            rows={16}
            value={content}
            placeholder={words.morelPlaceholder}
            aria-describedby="morel-count"
            onChange={(event) => setContent(event.target.value)}
          />
        </label>
        <div className="composer-row">
          <TierSelect id="morel-tier" label="who sees it" value={tier} onChange={setTier} disabled={busy} />
          <span id="morel-count" className={length > limit ? 'count over' : 'count'}>{length} / {limit}</span>
        </div>
        <label className="check" htmlFor="morel-share">
          <input id="morel-share" type="checkbox" checked={share} onChange={(event) => setShare(event.target.checked)} />
          <span>{words.shareToFeed}</span>
        </label>
        <div className="buttons">
          <button type="submit" disabled={busy || !title.trim() || !content.trim() || length > limit}>{words.releaseMorel}</button>
        </div>
        <ErrorNote error={error} />
      </form>
    </section>
  );
}
