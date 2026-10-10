import crypto from 'node:crypto';
import express from 'express';
import { accountFor, limiter, startSession } from './auth.js';

const STATE_TTL = 10 * 60 * 1000;
const random = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('base64url');

// id-tok is straight from the provider's token endpoint over tls, 
// openid connect core 3.1.3.7 accepts in place of checking the signature

function idTokenClaims(idToken) {
  const [, payload] = String(idToken).split('.');
  return JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8'));
}

function checkClaims(claims, { issuers, audience, nonce }) {
  if (!issuers.includes(claims.iss)) throw new Error('wrong issuer');
  if (claims.aud !== audience) throw new Error('wrong audience');
  if (!(claims.exp * 1000 > Date.now())) throw new Error('expired id token');
  if (nonce && claims.nonce !== nonce) throw new Error('wrong nonce');
  return {
    subject: String(claims.sub),
    email: claims.email,
    verified: claims.email_verified === true || claims.email_verified === 'true',
  };
}

// provider keys set are switched on. `urls` swaps endpoints, for tests
export function oauthProviders(config, urls = {}) {
  const providers = {};
  const { github, google } = config.oauth;

  if (github.clientId && github.clientSecret) {
    const api = urls.github?.api ?? 'https://api.github.com';
    providers.github = {
      authorizeUrl: urls.github?.authorize ?? 'https://github.com/login/oauth/authorize',
      tokenUrl: urls.github?.token ?? 'https://github.com/login/oauth/access_token',
      scope: 'read:user user:email',
      clientId: github.clientId,
      secret: () => github.clientSecret,
      async identify(tokens) {
        const headers = { authorization: `Bearer ${tokens.access_token}`, accept: 'application/vnd.github+json', 'user-agent': 'spore' };
        const [user, emails] = await Promise.all([
          fetch(`${api}/user`, { headers }).then((res) => res.json()),
          fetch(`${api}/user/emails`, { headers }).then((res) => res.json()),
        ]);
        const primary = Array.isArray(emails) ? emails.find((entry) => entry.primary) : null;
        return { subject: String(user.id), email: primary?.email, verified: primary?.verified === true };
      },
    };
  }

  if (google.clientId && google.clientSecret) {
    providers.google = {
      authorizeUrl: urls.google?.authorize ?? 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: urls.google?.token ?? 'https://oauth2.googleapis.com/token',
      scope: 'openid email',
      pkce: true,
      oidc: true,
      clientId: google.clientId,
      secret: () => google.clientSecret,
      identify: (tokens, nonce) => checkClaims(idTokenClaims(tokens.id_token), {
        issuers: ['https://accounts.google.com', 'accounts.google.com'], audience: google.clientId, nonce,
      }),
    };
  }

  return providers;
}

export function oauthRoutes({ db, config, providers }) {
  const router = express.Router();
  const callbackUrl = (name) => new URL(`/auth/oauth/${name}/callback`, config.apiOrigin).href;
  const toPage = (path) => new URL(path, config.domain).href;

  const stateCookie = {
    httpOnly: true,
    path: '/auth/oauth',
    maxAge: STATE_TTL,
    sameSite: 'lax',
    secure: config.production,
  };

  router.get('/auth/oauth/:provider', limiter(20), (req, res) => {
    const provider = providers[req.params.provider];
    if (!provider) return res.status(404).json({ error: 'not found' });

    const pending = { provider: req.params.provider, state: random(), verifier: random(), nonce: random() };
    res.cookie('oauth', Buffer.from(JSON.stringify(pending)).toString('base64url'), stateCookie);

    const url = new URL(provider.authorizeUrl);
    url.search = new URLSearchParams({
      client_id: provider.clientId,
      redirect_uri: callbackUrl(req.params.provider),
      response_type: 'code',
      scope: provider.scope,
      state: pending.state,
      ...(provider.pkce ? { code_challenge: sha256(pending.verifier), code_challenge_method: 'S256' } : {}),
      ...(provider.oidc ? { nonce: pending.nonce } : {}),
    }).toString();
    res.redirect(302, url.href);
  });

  const identityUser = db.prepare(`SELECT users.* FROM identities JOIN users ON users.id = identities.user_id
    WHERE identities.provider = ? AND identities.subject = ?`);
  const link = db.prepare('INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at) VALUES (?, ?, ?, ?)');

  async function callback(req, res) {
    const name = req.params.provider;
    const provider = providers[name];
    if (!provider) return res.status(404).json({ error: 'not found' });

    const answer = req.query;
    const fail = (reason) => res.redirect(302, toPage(`/auth#error=${reason}`));
    let pending;
    try {
      pending = JSON.parse(Buffer.from(req.cookies?.oauth ?? '', 'base64url').toString('utf8'));
    } catch {
      pending = null;
    }
    res.clearCookie('oauth', stateCookie);

    const stateMatches = pending?.provider === name && typeof answer.state === 'string'
      && answer.state.length === pending.state.length
      && crypto.timingSafeEqual(Buffer.from(answer.state), Buffer.from(pending.state));
    if (!stateMatches) return fail('expired');
    if (typeof answer.code !== 'string' || !answer.code) return fail('cancelled');

    let identity;
    try {
      const tokenResponse = await fetch(provider.tokenUrl, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code: answer.code,
          redirect_uri: callbackUrl(name),
          client_id: provider.clientId,
          client_secret: provider.secret(),
          ...(provider.pkce ? { code_verifier: pending.verifier } : {}),
        }),
      });
      const tokens = await tokenResponse.json();
      if (!tokenResponse.ok || tokens.error) throw new Error(`token exchange failed: ${tokens.error ?? tokenResponse.status}`);
      identity = await provider.identify(tokens, provider.oidc ? pending.nonce : undefined);
    } catch (err) {
      console.error(`${name} sign-in:`, err.message);
      return fail('provider');
    }

    // known prov acct signs in even if addr changed since
    let user = identityUser.get(name, identity.subject);
    if (!user) {
      if (!identity.email || !identity.verified) return fail('unverified-email');
      user = accountFor(db, config, String(identity.email).trim().toLowerCase());
      if (typeof user === 'string') return fail(user);
    }
    if (user.disabled_at) return fail('disabled');

    link.run(name, identity.subject, user.id, Date.now());
    startSession(db, config, res, user.id);
    res.redirect(302, toPage(user.handle ? '/' : '/auth#pick-handle'));
  }

  router.get('/auth/oauth/:provider/callback', limiter(20), callback);

  return router;
}
