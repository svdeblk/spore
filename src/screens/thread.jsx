import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { Composer, Matter } from '../matter.jsx';
import { Link, useRobots } from '../router.jsx';
import { ErrorNote, Loading, useAction } from '../ui.jsx';
import { words } from '../words.js';

export function ThreadScreen({ id, me, config }) {
  const [thread, setThread] = useState(null);
  const { run, error } = useAction();
  useRobots(thread?.root.tier === 'public');

  useEffect(() => {
    setThread(null);
    run(async () => setThread(await api(`/api/thread/${id}`)));
  }, [id]);

  const rootOwner = thread && me?.handle === thread.root.author.handle;
  const canRot = (post) => me && (post.author.handle === me.handle || rootOwner || me.admin);

  return (
    <section aria-labelledby="thread-heading">
      <h1 id="thread-heading" className="visually-hidden">thread</h1>
      <p><Link to="/">{words.back}</Link></p>
      <ErrorNote error={error && (error === 'not found' ? "this matter isn't here, or isn't yours to see." : error)} />
      {!thread && !error && <Loading />}
      {thread && (
        <>
          <Matter
            post={thread.root}
            linkToThread={false}
            canRot={canRot(thread.root)}
            canMove={me?.handle === thread.root.author.handle}
            onGone={() => history.back()}
            onChanged={(root) => setThread((current) => ({ ...current, root }))}
          />
          <h2 className="section-heading">{words.germinations(thread.replies.length)}</h2>
          <div className="replies">
            {thread.replies.map((reply) => (
              <Matter
                key={reply.id}
                post={reply}
                canRot={canRot(reply)}
                canMove={me?.handle === reply.author.handle}
                onGone={(gone) => setThread((current) => ({ ...current, replies: current.replies.filter((r) => r.id !== gone) }))}
              />
            ))}
          </div>
          {me?.handle && (
            <Composer
              me={me}
              config={config}
              parentId={thread.root.id}
              onPosted={(reply) => setThread((current) => ({ ...current, replies: [...current.replies, reply] }))}
            />
          )}
          {!me && <p className="quiet"><Link to="/auth">sign in</Link> to {words.germinate}.</p>}
        </>
      )}
    </section>
  );
}
