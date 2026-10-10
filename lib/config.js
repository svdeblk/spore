import path from 'node:path';

const SIGNUP_MODES = ['open', 'allowlist', 'closed'];

const list = (value) => (value || '').split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);

// production start refuses to run w/o each named for obvious fix
export function productionProblems(config) {
  if (!config.production) return [];
  const problems = [];
  if (!config.domain.startsWith('https://')) problems.push(`DOMAIN has to be https, not ${config.domain}`);
  if (config.apiOrigin !== config.domain && !config.apiOrigin.startsWith('https://')) problems.push(`API_ORIGIN has to be https, not ${config.apiOrigin}`);
  if (config.mailTransport === 'resend' && !config.resendApiKey) problems.push('RESEND_API_KEY is missing');
  if (!config.signupModeSet) problems.push('SIGNUP_MODE has to be set on purpose: open, allowlist or closed');
  if (config.adminEmails.length === 0) problems.push('ADMIN_EMAILS is empty');
  for (const [name, keys] of Object.entries(config.oauth)) {
    const set = Object.entries(keys).filter(([, value]) => value);
    if (set.length > 0 && set.length < Object.keys(keys).length) problems.push(`${name} sign-in is half configured`);
  }
  return problems;
}

export function loadConfig(env = process.env) {
  const port = Number(env.PORT) || 3000;
  const production = env.NODE_ENV === 'production';
  const signupMode = env.SIGNUP_MODE || 'open';
  if (!SIGNUP_MODES.includes(signupMode)) {
    throw new Error(`SIGNUP_MODE must be one of ${SIGNUP_MODES.join(', ')}, not ${signupMode}`);
  }

  return {
    port,
    production,
    domain: env.DOMAIN || `http://localhost:${port}`,
    // api answers for a page living at DOMAIN
    // for prod the api has its own host
    apiOrigin: env.API_ORIGIN || env.DOMAIN || `http://localhost:${port}`,
    dbPath: env.DB_PATH || path.join(import.meta.dirname, '..', 'spore.db'),
    mailTransport: env.MAIL_TRANSPORT || (production ? 'resend' : 'console'),
    resendApiKey: env.RESEND_API_KEY,
    fromEmail: env.FROM_EMAIL || 'nomatter@spore.bond',
    signupMode,
    signupModeSet: Boolean(env.SIGNUP_MODE),
    signupAllowlist: list(env.SIGNUP_ALLOWLIST),
    adminEmails: list(env.ADMIN_EMAILS),
    maxPostChars: Number(env.MAX_POST_CHARS) || 1000,
    maxMorelChars: Number(env.MAX_MOREL_CHARS) || 20000,
    passwordCost: Number(env.PASSWORD_COST) || 17,
    host: env.HOST || '127.0.0.1',
    // behind CF tunnel every request arrives from cloudflared on this machine
    // visitor addr, last one CF appended to X-Forwarded-For
    trustProxy: env.TRUST_PROXY ?? 'loopback',
    oauth: {
      github: { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET },
      google: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET },
    },
  };
}