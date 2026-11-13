import { defineHandler } from 'nitro'

// The one-time token stays in the fragment, outside requests, referrers and logs.
// This page loads no site assets before exchanging it for Better Auth's cookie.
export default defineHandler(() => {
  const nonce = crypto.randomUUID()
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Open your editor</title>
<style nonce="${nonce}">body{font:1rem system-ui,sans-serif;margin:0;padding:2rem;color:#1f2447}main{max-width:30rem;margin:18vh auto 0}button{font:inherit;color:white;background:#1f2447;border:0;border-radius:.5rem;padding:.75rem 1.25rem}</style>
<main><h1>Open your editor</h1><p id="status" role="status">Checking your sign-in…</p><button id="continue" hidden>Continue with app account</button>
<noscript>Return to the KrabiClaw app to open your editor.</noscript></main>
<script nonce="${nonce}">
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname + location.search);
const token = params.get('token');
const path = params.get('redirect');
const user = params.get('user');
const status = document.getElementById('status');
const button = document.getElementById('continue');
if (!token || !user || !path || !/^\\/dashboard\\/[a-z0-9-]+\\/products\\/[a-zA-Z0-9-]+(?:\\?location_id=[a-zA-Z0-9-]+)?$/.test(path)) {
  status.textContent = 'Return to the app and open the editor again.';
} else {
  const unavailable = () => {
    button.hidden = true;
    status.textContent = 'This link couldn’t open the editor. Return to the app and try again.';
  };
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      const response = await fetch('/api/auth/one-time-token/verify', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token })
      });
      if (!response.ok) throw new Error('Editor link expired');
      location.replace(path);
    } catch { unavailable(); }
  });
  fetch('/api/auth/get-session', { cache: 'no-store' })
    .then(response => {
      if (!response.ok) throw new Error('Browser session could not be read');
      return response.json();
    }).then(session => {
      if (session?.user?.id === user) return location.replace(path);
      status.textContent = session?.user?.id
        ? 'Your browser is signed into a different account. Continue with the account from the KrabiClaw app.'
        : 'Continue with the account from the KrabiClaw app.';
      button.hidden = false;
    }).catch(unavailable);
}
</script></html>`, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-robots-tag': 'noindex',
      'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  })
})
