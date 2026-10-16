// What kind of failure an agent error is, from its (Turkish, adapter-described) message:
//   'limit'     usage limit / quota — wait for the reset, keep the session
//   'transient' worth retrying in a moment (overload, network, token refresh race…)
//   'auth'      the user must sign in again
//   'session'   the saved session is gone — start a new one
//   'other'

const SESSION = /oturumu bulunamadı|no conversation found|session .*not found|could not find session|thread .*not found|no rollout found|no saved session/i;
const LIMIT = /limiti? doldu|kotası doldu|usage limit|rate.?limit|limit reached|hit your limit|out of (extra )?usage|\b429\b|too many requests|quota|resource_exhausted/i;
const TRANSIENT = /failed to refresh oauth token|another claude code process|server_error|overloaded|aşırı yoğun|\b(500|502|503|504|529)\b|econnreset|etimedout|econnrefused|socket hang up|stream disconnected|bağlantı hatası|temporarily unavailable|cevap vermedi/i;
const AUTH = /oturumu yok|auth login|codex login|oturum aç|giriş yap|not logged in|please (log ?in|sign in)|login required|\b401\b|unauthorized|invalid api key/i;

export function errorKind(err) {
  const m = String(err?.message || err || '');
  if (SESSION.test(m)) return 'session';
  if (LIMIT.test(m)) return 'limit';
  if (TRANSIENT.test(m)) return 'transient';
  if (AUTH.test(m)) return 'auth';
  return 'other';
}

/** Retrying without the saved session can only help when the session itself may be the problem. */
export const mayBeStaleSession = (err) => ['session', 'other'].includes(errorKind(err));
