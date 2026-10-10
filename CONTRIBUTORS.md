# CONTRIBUTION GUIDE

fixes & small changes are welcome. anything bigger than a bug fix, open an issue first, since most of "Down the Line" is spec'd and not open for building yet.

1. run `pnpm install` and `pnpm test` before you start, so you know the suite passes on your machine.
2. one change per pull request. a fix and a refactor are two pull requests.
3. anything that touches who can see what (`lib/visibility.js`, `lib/matter.js`, `lib/relations.js`), sign-in (`lib/auth.js`, `lib/oauth.js`) or the parser needs a test. a mistake in those leaks a private post or opens an xss hole, and the suite already covers them, so match what's there.
4. if you touch the page, run `pnpm walkthrough` and `pnpm a11y` and look at the screenshots, both themes and both widths. text needs 4.5:1 contrast, and body text stays at 16px or larger at the medium setting.
5. every word the page shows goes in `src/words.js` and gets a row in `VOCAB.md`. no themed words hardcoded in components.
6. pnpm only. no npm, yarn or bun, and a new dependency needs a reason in the pull request. this is a standard for code health.
7. comments are for the why and nothing else. no banners, no narrating the next line.
8. copy & docs are lowercase apart from proper nouns or uppercase for emphasis. a small thing, but part of the site's identity.

# LLM/AI USAGE

this software, website, copy, and everything else were all written fully by a human being. spore is, by its nature, a space for people to connect to each other, share thoughts & feelings, contribute art, and more.

i cannot stop you from using an LLM or other AI tooling, but if you do, please at least ensure that there is never anything submitted/posted to this repo without a human-in-the-loop.