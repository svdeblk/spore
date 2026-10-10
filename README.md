# spore.bond

a small microblog service & app. you release matter, people germinate on it. spread your spores or keep them close to home. privacy is important, so who sees what is yours to set. sign in by magic-link, email & password, or with github/google.

write social feed posts, add friends & follow others. share thoughts, share art, share your tiny worlds.

the UI components (matter, germinate, bond, fuse, soil and so on) are heavily themed,  definitions live in `src/words.js`. the names in the code and the API are the ones you're used to, written in plain english. see `VOCAB.md` for a full breakdown.

## Current Build

- matter (posts) up to 1000 characters, germinations (replies) one lvl deep
- four privacy tiers (public, hosts and fused, fused only, private), set separately for your profile, your new matter, and your email address
- bond (follow), fuse (friends), prune (block)
- decay (a private archive), decompose (a bin that empties itself after 3, 7, 14 or 30 days, or never), and rot (perma-delete)
- a spore print: everything you wrote, at every tier, as one json file
- an allowlist beta with a request form & a queue for stewards (admins)
- one each light & dark theme setting, mono/sans/serif & atkinson hyperlegible fonts, small/medium/large text (many more coming soon)

## Tech Stack

| part | what |
|---|---|
| language | JavaScript (ES modules) on Node 22.9 or newer, JSX for the page. no TypeScript |
| backend | Express 5 started by `server.js` |
| database | SQLite through better-sqlite3 | (`spore.db`) in WAL mode. plain SQL, no ORM |
| frontend | React 19, bundled by esbuild. a small router in `src/router.jsx`, no router or state library |
| styling | plain CSS in `src/app.css`. custom properties carry the themes, the text sizes & the fonts. no framework |
| fonts | IBM Plex Mono, Public Sans, Literata & Atkinson Hyperlegible, self-hosted through Fontsource |
| sign-in | magic links by email, optional passwords hashed with scrypt (Node's own crypto), GitHub & Google OAuth (Google with PKCE & a nonce) |
| mail | Resend. sign-in links print to the terminal when no mail transport is set |
| security | helmet, express-rate-limit & cookie-parser. sessions are random tokens stored hashed in SQLite, sent in an httpOnly SameSite=Lax cookie. the page gets its content security policy from `public/_headers` and the API sends a deny-all one |
| tests | Node's built-in test runner. Playwright drives Chromium for `pnpm walkthrough` & `pnpm a11y` |
| package manager | pnpm 12 |
| hosting | the API runs `server.js` on an Oracle Cloud instance, behind a Cloudflare tunnel (`TRUST_PROXY` defaults to `loopback`). the page is the static `public/` folder on Cloudflare Pages. `spore.bond` serves the page & `api.spore.bond` serves the API |

## Run It, Contribute, Build Your Own

needs node 22.9 or newer & pnpm (the pnpm version is pinned in `package.json`, so `corepack enable` is enough).

```
pnpm install
pnpm build
pnpm start
```

open [http://localhost:3000](http://localhost:3000)

with no mail settings it'll print sign-in links to the terminal.

`pnpm dev` rebuilds the page & restarts the server as you edit.

| command | what it does |
|---|---|
| `pnpm test` | the whole test suite, no browser needed |
| `pnpm walkthrough [dir]` | walks every flow in chromium, both themes, two widths, and saves screenshots |
| `pnpm a11y [report]` | the same walkthru by keyboard alone + a contrast measurement of every color pair |
| `pnpm build` | bundles the page into `public/build` |

the two browser commands need a chromium
set `CHROMIUM_PATH` if playwright can't find one.

## Min. Settings

every variable is in `.env.example` with what it does in production.

(`NODE_ENV=production`) the server refuses to start until the page origin is https, mail has a key, the signup mode is set on purpose, and at least one steward is named.
it will define which ones are missing.

## Layout

```
server.js        starts the api
lib/             backend: database, auth, matter, relations, visibility, parser, mail
src/             the page, in jsx, bundled by esbuild
public/          static files; build/ is generated and not committed
test/            node's test runner, plus browser/ for the chromium walks
```

the page & API can live on different hosts: build the page with `API_BASE` set to the origin

`public/_headers` carries the page's security policy and `public/_redirects` sends every path to the page, for hosts such as CF pages. the API sets its own strict headers.

## Down the Line

all planned with spec but not built. rules & params are still TBD.

- morels (20k, long form blogs) & puffballs (quick status)
- colonies (groups)
- follower approval
- the UNDERGROWTH marketplace, post custom content/plugins/etc for spore to the market for zero seller fees
- custom themes (caps) & grafts (plugins) w/ full framework & management system
- DM/messaging 
- many more bits & bobs!


## Contributing

fixes and small changes are welcome. anything bigger than a bug fix, open an issue first, since most of "Down the Line" is spec'd and not open for building yet.

see `CONTRIBUTORS.md` for full rules & standards

## License

MIT; see `LICENSE`