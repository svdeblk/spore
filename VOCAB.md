# VOCAB

every themed word has a plain correlative. nothing is form over function. the first column is what the page says, the second is the plain-english word for it, the third is where it shows up in the code and the api. the page's words all live in `src/words.js`.

## On The Page

| spore word | plain word | where |
|---|---|---|
| bond, unbond | follow, unfollow | `PUT` and `DELETE /api/follows/:handle` |
| bonded | following | `GET /api/me/relations` |
| burrow | back | the `← burrow` link |
| decay | archive | `/archive`, `POST /api/matter/:id/archive` |
| decayed | archived | `archived_at` column |
| decompose | move to the bin | `/bin`, `POST /api/matter/:id/bin` |
| decomposing | in the bin | `binned_at` column |
| feed | public feed | `/`, `GET /api/feed` |
| fuse, unfuse | send a friend request, end a friendship | `PUT` and `DELETE /api/friends/:handle` |
| fused | friends | `friends` table |
| germinate, germination | reply | `POST /api/matter` with `parent_id`, `GET /api/thread/:id`. one level deep |
| host | follower | `DELETE /api/followers/:handle` removes one |
| let in | approve a request | `POST /api/admin/requests/:id/approve` |
| matter | post | `/api/matter`, `lib/matter.js` |
| mutuals, mutualism | people who follow each other | `GET /api/me/relations` |
| propagate | ask for an invite | `/request-access`, `POST /auth/request-access` |
| prune, unprune | block, unblock | `PUT` and `DELETE /api/blocks/:handle` |
| pruned | blocked | `blocks` table |
| release | publish a post | the composer, `POST /api/matter` |
| restore | restore | `POST /api/matter/:id/restore` |
| rot | delete for good | `DELETE /api/matter/:id`, `DELETE /api/me/bin` |
| spore | profile | `/@handle`, `GET /api/spore/:handle` |
| soil | settings | `/settings`, `PATCH /api/me/settings` |
| steward | admin | `ADMIN_EMAILS`, `/admin`, `/api/admin/*` |
| substrate | home feed: you and the people you bond or fuse with | `/substrate`, `GET /api/substrate` |
| spore print | data export | `GET /api/me/export`, saves `spore-print-<handle>.json` |

## Privacy Tiers

| spore word | plain word | stored as |
|---|---|---|
| public | public | 0 |
| hosts and fused | followers and friends | 1, `followers` |
| fused only | friends only | 2, `friends` |
| private | only you | 3 |

a higher number is always stricter. when a post & its author's profile disagree, the stricter one wins.

## Planned, Not Built

| spore word | plain word |
|---|---|
| morels | long form blogs, 20k characters |
| puffballs | quick status posts |
| colonies | groups |
| the undergrowth | marketplace |
| fruiting | repost, share |
| fruiting events | notifications |
| the woodwide web | federated network |
| caps | themes |
| grafts | plugins |
| mycelium | a self-hosted instance |
| vectors | crossposting |
| hyphal growth | background jobs |
| amendments | releases, updates |
| chemotaxis | the feed algorithm |

their rules & parameters are still TBD.
