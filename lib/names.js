// handles & group names outright blocks for prop. site words, roles, or staff
// also words that are slurs. swearing is fine.

const SITE_WORDS = [
  'about', 'abuse', 'account', 'accounts', 'amendments', 'api', 'assets', 'auth', 'blocks', 'blog', 'bond', 'bonded', 'bonds', 'cultivators', 'decay', 'decompose', 'foragers', 'fused', 'germinate', 'germinations',
  'host', 'hosts', 'mycologists', 'pins', 'rot', 'sporelings', 'stewards', 'tenders', 'unbond', 'unbonded', 'vector',
  'burrow', 'caps', 'cdn', 'chemotaxis', 'config', 'contact', 'dashboard', 'dev', 'developer', 'docs', 'email',
  'explore', 'export', 'feed', 'follow', 'followers', 'following', 'follows', 'friends', 'fruiting', 'fruits',
  'gills', 'graft', 'grafts', 'group', 'groups', 'healthz', 'help', 'home', 'hyphae', 'inbox', 'invite', 'legal',
  'login', 'logout', 'mail', 'matter', 'messages', 'morel', 'morels', 'mutualism', 'mutuals', 'nomatter',
  'noreply', 'notifications', 'postmaster', 'privacy', 'profile', 'propagate', 'prune', 'pruned', 'puffball',
  'puffballs', 'rhizomorphs', 'rhizos', 'ring', 'rings', 'search', 'security', 'settings', 'signin', 'signup',
  'soil', 'spore', 'spore_bond', 'sporebond', 'spores', 'sporeprint', 'static', 'status', 'stems', 'substrate',
  'support', 'symbiont', 'symbionts', 'terms', 'thread', 'threads', 'undergrowth', 'vectors', 'vendor',
  'webmaster', 'woodwide', 'www',
];

const ACCOUNT_WORDS = [
  'admin', 'administrator', 'all', 'anon', 'anonymous', 'deleted', 'everyone', 'guest', 'me', 'mine', 'mod',
  'moderator', 'mods', 'my', 'nobody', 'null', 'official', 'owner', 'root', 'self', 'someone', 'staff',
  'superuser', 'sysadmin', 'system', 'team', 'undefined', 'unknown', 'user', 'users', 'verified', 'you', 'sade',
  'svde', 'sadeblack', 'svdeblk', 'sade_black', 'svde_black', 'sade-black', 'me', 'emily', 
];

// matched anywhere in a name, after undoing common letter swaps
const SLURS_ANYWHERE = [
  'beaner', 'cameljockey', 'chink', 'faggot', 'halfbreed', 'jigaboo', 'junglebunny', 'kike', 'mongoloid',
  'negro', 'nigga', 'nigger', 'porchmonkey', 'raghead', 'redskin', 'retard', 'sandnigger', 'shemale', 'spastic',
  'towelhead', 'trannie', 'tranny', 'wetback', 'zipperhead', 'troon', 
];

// short enough to sit inside ordinary words, so only matched as a whole part of a name
const SLURS_WHOLE = ['coon', 'dago', 'dyke', 'fag', 'fags', 'gook', 'homo', 'hymie', 'kyke', 'paki', 'spaz', 'spic', 'spick', 'squaw', 'wog', 'wop'];

const RESERVED = new Set([...SITE_WORDS, ...ACCOUNT_WORDS]);

const SWAPS = { 0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g' };
const unswap = (text) => text.replace(/[01345789]/g, (digit) => SWAPS[digit] ?? '');

export function isReserved(name) {
  return RESERVED.has(name) || RESERVED.has(name.replace(/_/g, ''));
}

export function isSlur(name) {
  const joined = unswap(name.replace(/_/g, ''));
  if (SLURS_ANYWHERE.some((slur) => joined.includes(slur))) return true;
  const parts = name.split('_').filter(Boolean).flatMap((part) => [part.replace(/\d+/g, ''), unswap(part)]);
  return parts.some((part) => SLURS_WHOLE.includes(part) || SLURS_WHOLE.includes(part.replace(/s$/, '')));
}
