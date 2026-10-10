import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Composer, Matter } from '../matter.jsx';
import { Link } from '../router.jsx';
import { ErrorNote, Loading, useAction } from '../ui.jsx';
import { words } from '../words.js';

const PAGE = 20;

// the feed is public matter; the substrate is what you're bonded or fused to + your own data
export function FeedScreen({ me, config, kind }) {
  const [posts, setPosts] = useState(null);
  const [done, setDone] = useState(false);
  const { run, busy, error } = useAction();
  const path = kind === 'substrate' ? '/api/substrate' : '/api/feed';
  const empty = useMemo(() => words.emptyFeed[Math.floor(Math.random() * words.emptyFeed.length)], [kind]);

  const load = (offset) => run(async () => {
    const page = await api(`${path}?limit=${PAGE}&offset=${offset}`);
    setPosts((current) => (offset === 0 ? page.posts : [...(current ?? []), ...page.posts]));
    setDone(page.posts.length < PAGE);
  });

  useEffect(() => {
    setPosts(null);
    load(0);
  }, [path]);

  const canRot = (post) => me && (post.author.handle === me.handle || me.admin);

  return (
    <section aria-labelledby="feed-heading">
      <nav className="tabs" aria-label="feeds">
        <Link to="/" aria-current={kind === 'feed' ? 'page' : undefined}>{words.feed}</Link>
        {me && <Link to="/substrate" aria-current={kind === 'substrate' ? 'page' : undefined}>{words.substrate}</Link>}
      </nav>
      <h1 id="feed-heading" className="visually-hidden">{kind === 'substrate' ? words.substrate : words.feed}</h1>

      {me?.handle && (
        <Composer
          me={me}
          config={config}
          onPosted={(post) => setPosts((current) => (post.tier === 'public' || kind === 'substrate' ? [post, ...(current ?? [])] : current))}
        />
      )}
      {!me && <p className="quiet"><Link to="/auth">sign in</Link> to release something that matters.</p>}

      <ErrorNote error={error} />
      {posts === null && !error && <Loading />}
      {posts?.length === 0 && <p className="empty">{empty}</p>}
      <div className="matter-list">
        {posts?.map((post) => (
          <Matter key={post.id} post={post} canRot={canRot(post)} canMove={me?.handle === post.author.handle} onGone={(id) => setPosts((current) => current.filter((p) => p.id !== id))} />
        ))}
      </div>
      {posts?.length > 0 && !done && (
        <button type="button" className="more" onClick={() => load(posts.length)} disabled={busy}>more</button>
      )}
    </section>
  );
}
