import { Link } from '../router.jsx';
import { words } from '../words.js';

const CONTACT = 'hi@spore.bond';
const MIN_AGE = 13;
const TERMS_UPDATED = '2026-10-09';

const Mail = () => <a href={`mailto:${CONTACT}`}>{CONTACT}</a>;

export function AboutScreen() {
  return (
    <section aria-labelledby="about-heading" className="prose">
      <h1 id="about-heading">about</h1>
      <p>spore.bond is a small microblog. you release {words.post}, people {words.germinate} on it, and who sees what is yours to set.</p>
      <p>it's a beta, so words, pages & rules still change. everything built so far is on the <Link to="/">{words.feed}</Link>, in your {words.soil} & in the <Link to="/privacy">privacy</Link> page.</p>
      <p>it's made & run by SVDE, one person. the code is open source under the MIT license at <a href="https://github.com/svdeblk/spore" rel="noopener">github.com/svdeblk/spore</a>.</p>
      <p>there are no ads, and nothing about you is sold. questions go to the <Link to="/contact">contact</Link> page.</p>
    </section>
  );
}

export function TermsScreen() {
  return (
    <section aria-labelledby="terms-heading" className="prose">
      <h1 id="terms-heading">terms</h1>
      <p>last updated {TERMS_UPDATED}. these are the rules for using spore.bond. by making an account or using the site you agree to them. if you don't, please don't use it.</p>

      <h2>the beta</h2>
      <p>spore.bond is a beta. it can change, break, lose data or shut down. nothing here promises uptime. your spore print is a full copy of what you wrote, so take one now & then.</p>

      <h2>who can use it</h2>
      <p>you have to be at least {MIN_AGE} years old. if i find out an account belongs to someone younger, i'll delete it.</p>

      <h2>your account</h2>
      <p>you sign in by emailed link, password, or a linked github or google account. keep those safe. what happens under your account is on you. your handle is permanent for the beta & can't be changed.</p>

      <h2>your {words.post}</h2>
      <p>what you write is yours. by posting it you let spore.bond store it & show it to the people your tiers allow, which is how the site works. only post what you have the right to post.</p>

      <h2>your data</h2>
      <p>how your data is handled is on the <Link to="/privacy">privacy</Link> page. you can export it & delete it any time.</p>

      <h2>what isn't allowed</h2>
      <p>harassment, threats, hate aimed at people for who they are, sexual content involving minors, other people's private information, spam, pretending to be the site or its {words.stewards}, and anything illegal. don't try to break the site or get into anyone else's account.</p>

      <h2>{words.stewards}</h2>
      <p>{words.stewards} can {words.rot} matter and disable accounts that break these terms, without warning when it's harmful or illegal. a disabled account is signed out everywhere & its matter is hidden. if you think a decision was wrong, use the <Link to="/contact">contact</Link> page.</p>

      <h2>leaving</h2>
      <p>you can delete your account any time in your {words.soil}. everything goes: your matter, your {words.germination}s elsewhere, and every bond. i can also end an account or the site.</p>

      <h2>no warranty, limited liability</h2>
      <p>spore.bond is provided as it is, with no warranty of any kind. matter is written by its authors, not by me. to the extent the law allows, i'm not liable for losses that come from using the site or from what other people post.</p>

      <h2>governing law</h2>
      <p>these terms are governed by the laws of the state of california, without regard to its conflict of law rules. any dispute goes to the state or federal courts located in california, and you agree to their jurisdiction.</p>

      <h2>changes</h2>
      <p>i can update these terms. the date at the top changes when i do, and using the site after that means you accept the new version.</p>

      <h2>the code</h2>
      <p>the source code is a separate thing, under the MIT license in its repository. these terms are about using the site.</p>
    </section>
  );
}

export function ContactScreen() {
  return (
    <section aria-labelledby="contact-heading" className="prose">
      <h1 id="contact-heading">contact</h1>
      <p>write to <Mail /> for questions, help with your account, and anything that breaks the <Link to="/terms">terms</Link>. i'm one person, so replies can take a few days.</p>
      <p>to report {words.post} or an account, include the link to it & what's wrong. for a copyright complaint, include the link & what's yours.</p>
      <p>bugs & code questions can go to the issues on <a href="https://github.com/svdeblk/spore" rel="noopener">github.com/svdeblk/spore</a>.</p>
    </section>
  );
}
