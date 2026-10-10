// usr vis as sql; all predicate expects viewer's id bound as @viewer 
// (null when signed out); takes alias of usr row owning the element being looked at

export const TIERS = ['public', 'followers', 'friends', 'private'];

export const tierFromName = (name) => (TIERS.includes(name) ? TIERS.indexOf(name) : null);

const follows = (a) => `EXISTS (SELECT 1 FROM follows WHERE follower_id = @viewer AND followee_id = ${a}.id)`;

const friends = (a) => `EXISTS (SELECT 1 FROM friends WHERE accepted_at IS NOT NULL
  AND ((requester_id = @viewer AND addressee_id = ${a}.id) OR (requester_id = ${a}.id AND addressee_id = @viewer)))`;

export const blockedEitherWay = (a) => `EXISTS (SELECT 1 FROM blocks
  WHERE (blocker_id = ${a}.id AND blocked_id = @viewer) OR (blocker_id = @viewer AND blocked_id = ${a}.id))`;

export const followsOrFriends = (a) => `(${follows(a)} OR ${friends(a)})`;

// owners see their own matter; block in either dir hides both usrs from each other
export function canSee(a, tier) {
  return `(${a}.disabled_at IS NULL AND (${a}.id IS @viewer OR (NOT ${blockedEitherWay(a)} AND CASE ${tier}
    WHEN 0 THEN 1
    WHEN 1 THEN @viewer IS NOT NULL AND ${followsOrFriends(a)}
    WHEN 2 THEN ${friends(a)}
    ELSE 0 END)))`;
}

// archived & binned matter out of view for all usr incl owner
// also outside the archive and the bin
const inView = (p) => `${p}.archived_at IS NULL AND ${p}.binned_at IS NULL`;

// post held stricter own tier & author's profile tier; 
// priv profile hides all; reply needs root to be visible
export function canSeePost(p, a) {
  return `(${inView(p)} AND ${canSee(a, `max(${p}.tier, ${a}.profile_tier)`)} AND (${p}.parent_id IS NULL OR EXISTS (
    SELECT 1 FROM posts root JOIN users root_author ON root_author.id = root.user_id
    WHERE root.id = ${p}.parent_id AND ${inView('root')} AND ${canSee('root_author', 'max(root.tier, root_author.profile_tier)')})))`;
}
