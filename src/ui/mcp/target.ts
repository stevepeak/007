// The stand-in origin for a page that has no window to read.
//
// 007 is whitelabeled: it has no idea what anyone's deployed hostname is, and
// guessing would be worse than a placeholder, because a wrong URL that looks
// plausible gets pasted into a client config and then fails to resolve with
// nothing to connect the error to. `example.com` is reserved by RFC 2606
// precisely so it cannot be somebody's real host.
//
// This used to back a development/production picker, which offered one real URL
// beside one invented one. The page now shows only the deployment serving it —
// the one it can actually know — so the placeholder is reached in exactly one
// case: a host that server-renders this page, where there is no origin yet.

export const PLACEHOLDER = {
  development: 'http://localhost:3000',
  production: 'https://your-deployment.example.com',
} as const
