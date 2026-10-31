import { randomBytes } from 'node:crypto';
import http from 'node:http';

import { ignorePortProbe } from './port-probe.mjs';

/**
 * In-process stand-in for the parts of WorkOS User Management the account system uses: the AuthKit
 * authorize redirect, the code exchange and user deletion. `signIn(user)` mints a code for a user
 * the way a finished AuthKit page would; the authorize step answers like AuthKit with
 * `nextUser` (or the error set with `failAuthorize`). Shapes follow workos.com/docs/reference/user-management.
 */
export function createFakeWorkOS({ apiKey, clientId, onCall = () => {} }) {
  const codes = new Map(); // code → { user, method }
  const calls = [];
  let nextUser = null;
  let authorizeError = null;
  let deleteFailure = null;

  const json = (res, status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  };

  /** A WorkOS user object; `id`, `email` and `email_verified` are what the server reads. */
  function user({ id = `user_${randomBytes(8).toString('hex')}`, email, verified = true, firstName = '', lastName = '' }) {
    return { object: 'user', id, email, email_verified: verified, first_name: firstName, last_name: lastName };
  }

  function signIn(fields, method = 'GoogleOAuth') {
    const code = `code_${randomBytes(12).toString('hex')}`;
    codes.set(code, { user: fields.object === 'user' ? fields : user(fields), method });
    return code;
  }

  const server = http.createServer(async (req, res) => {
    if (ignorePortProbe(req, res)) return;
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString('utf8');
    const body = text ? JSON.parse(text) : null;
    calls.push({ method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), auth: req.headers.authorization, body });
    onCall(req.method, url.pathname);

    if (req.method === 'GET' && url.pathname === '/user_management/authorize') {
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('state', url.searchParams.get('state'));
      if (authorizeError) back.searchParams.set('error', authorizeError);
      else back.searchParams.set('code', signIn(nextUser ?? { email: 'live@example.com', firstName: '하마' }, 'MagicAuth'));
      res.writeHead(302, { Location: back.toString() });
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/user_management/authenticate') {
      if (body?.client_id !== clientId || body?.client_secret !== apiKey) return json(res, 401, { error: 'invalid_client' });
      const entry = codes.get(body?.code);
      codes.delete(body?.code);
      if (body?.grant_type !== 'authorization_code' || !entry) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'The code is invalid or expired.' });
      }
      return json(res, 200, {
        user: entry.user,
        organization_id: null,
        access_token: 'fake-access-token',
        refresh_token: 'fake-refresh-token',
        authentication_method: entry.method,
      });
    }
    const userPath = url.pathname.match(/^\/user_management\/users\/([^/]+)$/);
    if (req.method === 'DELETE' && userPath) {
      if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res, 401, { message: 'Unauthorized' });
      if (deleteFailure) return json(res, deleteFailure, { message: 'boom' });
      res.writeHead(202);
      res.end();
      return;
    }
    json(res, 404, { message: 'Not found' });
  });

  return {
    calls,
    signIn,
    user,
    setNextUser(fields) { nextUser = fields; },
    failAuthorize(error) { authorizeError = error; },
    failDelete(status) { deleteFailure = status; },
    async listen(port = 0) {
      await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close() {
      server.closeAllConnections?.();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
