import { env } from 'cloudflare:workers';
import { getChatGPTUser, chatGPTSignInPath, chatGPTSignOutPath } from '../../chatgpt-auth';
import { handleAuthenticatedApi } from '../../../backend/local-auth.js';

export const dynamic = 'force-dynamic';
async function handle(request: Request) {
  const identity = await getChatGPTUser();
  return handleAuthenticatedApi(request, env, identity ? {
    id: identity.userId, email: identity.email, name: identity.displayName,
    signInUrl: chatGPTSignInPath('/'), signOutUrl: chatGPTSignOutPath('/')
  } : null);
}
export const GET = handle;
export const POST = handle;
export const PATCH = handle;
export const PUT = handle;
export const DELETE = handle;
