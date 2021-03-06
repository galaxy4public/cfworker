import { BadRequestError } from '@cfworker/http-errors';
import { parseJwt } from '@cfworker/jwt';
import { Context, Cookies, Middleware } from '@cfworker/web';
import { TokenResponse } from './token-response';

export function getAuthorizeUrl({ origin, href }: URL) {
  const domain = process.env.AUTH0_DOMAIN;
  const args = {
    response_type: 'code',
    client_id: process.env.AUTH0_CLIENT_ID,
    scope: 'openid profile',
    redirect_uri: `${origin}/api/auth/callback?${new URLSearchParams({
      redirect_uri: href
    })}`
  };
  return `https://${domain}/authorize?${new URLSearchParams(args)}`;
}

async function exchangeCode(
  code: string,
  redirect_uri: string
): Promise<TokenResponse> {
  const url = `https://${process.env.AUTH0_DOMAIN}/oauth/token`;
  const body = JSON.stringify({
    grant_type: 'authorization_code',
    client_id: process.env.AUTH0_CLIENT_ID,
    client_secret: process.env.AUTH0_CLIENT_SECRET,
    code,
    redirect_uri
  });
  const init = {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-cache'
    },
    body
  };
  const response = await fetch(url, init);
  if (response.ok) {
    return response.json();
  }
  const text = await response.text();
  throw new Error(text);
}

export function setTokenCookie(
  cookies: Cookies,
  tokenResponse: TokenResponse | null
) {
  const production = String(process.env.NODE_ENV) === 'production';

  const token = tokenResponse ? tokenResponse.id_token : 'deleted';

  const secure = production;

  const expires = tokenResponse
    ? new Date(new Date().getTime() + tokenResponse.expires_in * 1000)
    : new Date('Thu, 01 Jan 1970 00:00:00 GMT');

  // Can't use SameSite=Strict in Chrome: https://bugs.chromium.org/p/chromium/issues/detail?id=696204
  // Can't use SameSite=Strict or Lax on Safari: https://github.com/IdentityServer/IdentityServer4/issues/2595
  cookies.set('token', token, { path: '/', httpOnly: true, secure, expires });
}

export async function handleTokenCallback(context: Context) {
  const code = context.url.searchParams.get('code');
  const redirect_uri = context.url.searchParams.get('redirect_uri');
  if (!code) {
    throw new BadRequestError('code is expected.');
  }
  if (!redirect_uri) {
    throw new BadRequestError('redirect_uri is expected.');
  }
  try {
    const tokenResponse = await exchangeCode(code, redirect_uri);
    setTokenCookie(context.cookies, tokenResponse);
    context.res.redirect(redirect_uri);
  } catch (err) {
    throw new BadRequestError(err.message);
  }
}

export const auth0Origin = new URL('https://' + process.env.AUTH0_DOMAIN)
  .origin;

export const authentication: Middleware = async ({ cookies, state }, next) => {
  const token = cookies.get('token');

  if (!token) {
    await next();
    return;
  }

  const result = await parseJwt(
    token,
    auth0Origin,
    process.env.AUTH0_CLIENT_ID
  );
  if (!result.valid) {
    cookies.set('reason', result.reason);
    await next();
    return;
  }
  const payload = result.payload as any;
  const { given_name, family_name, name, nickname, picture } = payload;
  state.user = {
    tenant: payload['https://auth.cumulus.care/tenant'],
    given_name,
    family_name,
    name,
    nickname,
    picture
  };

  await next();
};

export function handleSignout({ cookies, url, res }: Context) {
  const returnTo = new URL(url.origin);
  returnTo.pathname = '/signed-out';
  const signOutUrl = new URL(`https://${process.env.AUTH0_DOMAIN}/v2/logout`);
  signOutUrl.searchParams.set('client_id', process.env.AUTH0_CLIENT_ID);
  signOutUrl.searchParams.set('returnTo', returnTo.href);
  setTokenCookie(cookies, null);
  res.redirect(signOutUrl);
}
