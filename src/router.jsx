import { useEffect, useState } from 'react';

export function navigate(to) {
  history.pushState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
  scrollTo(0, 0);
}

// swap cur addr w/o new history entry + tell pg it changed
export function replace(to) {
  history.replaceState(null, '', to);
  dispatchEvent(new PopStateEvent('popstate'));
}

export function useLocation() {
  const [where, setWhere] = useState(() => ({ path: location.pathname, hash: location.hash }));
  useEffect(() => {
    const update = () => setWhere({ path: location.pathname, hash: location.hash });
    addEventListener('popstate', update);
    addEventListener('hashchange', update);
    return () => {
      removeEventListener('popstate', update);
      removeEventListener('hashchange', update);
    };
  }, []);
  return where;
}

// real link, works with the keyboard/middle-click/"open in new tab"
export function Link({ to, children, ...rest }) {
  const follow = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={follow} {...rest}>{children}</a>;
}

// pg own links inside rendered matter ([[handle]] & [[#id]]) stay in the page
export function followInternalLinks(event) {
  const link = event.target.closest?.('a[href^="/"]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(link.getAttribute('href'));
}

// signed-out srch eng index only pub data
export function useRobots(indexable) {
  useEffect(() => {
    if (indexable) return;
    const tag = document.createElement('meta');
    tag.name = 'robots';
    tag.content = 'noindex';
    document.head.append(tag);
    return () => tag.remove();
  }, [indexable]);
}
