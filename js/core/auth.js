// Auth: email one-time-code as the real path, guest as the zero-friction path.
// The OTP screen is a state machine (idle -> sent -> verifying) with a resend
// cooldown, because a code screen that silently does nothing is the fastest way
// to lose someone at the door.
import { sb, session } from '../sb.js';
import { api, tryRpc } from '../api.js';
import { store } from '../store.js';
import { $, el, esc } from '../util.js';
import { toast } from '../ui.js';

const RESEND_SECONDS = 45;
let resendTimer = null;

const show = (id) => { $(id).classList.remove('hidden'); };
const hide = (id) => { $(id).classList.add('hidden'); };

function authError(msg) {
  const e = $('authErr');
  e.textContent = msg || '';
  e.classList.toggle('hidden', !msg);
}

function busy(btn, on, label) {
  btn.disabled = on;
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = on ? '…' : (label || btn.dataset.label);
}

// Supabase decides between a sign-in LINK and a numeric CODE purely from the
// email template, and template editing is locked until a custom SMTP provider is
// configured. So on the default mailer people receive a link, not a code, and a
// screen that only offers a code box looks broken. Support both: the link signs
// them in on return (detectSessionInUrl), and the code box stays for when the
// template is switched to {{ .Token }}.
export function readAuthCallback() {
  const h = new URLSearchParams((location.hash || '').replace(/^#/, ''));
  const q = new URLSearchParams(location.search || '');
  const err = h.get('error_description') || h.get('error') || q.get('error_description');
  const hasToken = !!(h.get('access_token') || q.get('code'));
  if (err) {
    // Clear it so a refresh does not resurrect a dead error.
    history.replaceState(null, '', location.pathname + location.search);
    return { error: decodeURIComponent(err.replace(/\+/g, ' ')) };
  }
  return { hasToken };
}

export function initAuth(onSignedIn) {
  // Someone clicked an expired or already-used sign-in link. Without this they
  // land on a blank sign-in screen with no idea why nothing happened.
  const cb = readAuthCallback();
  if (cb.error) {
    authError(/expired|invalid/i.test(cb.error)
      ? 'That sign-in link has expired or was already used. Request a new one below.'
      : cb.error);
  }

  // ---- guest ----
  $('guestBtn').onclick = async () => {
    const name = $('displayName').value.trim() || 'Guest ' + Math.floor(1000 + Math.random() * 9000);
    const btn = $('guestBtn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInAnonymously();
      if (error) throw error;
      await api.setProfile({ display_name: name });
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not start a guest session');
      busy(btn, false);
    }
  };

  // ---- password sign-in ----
  // The interim path while the organisations finish their own mailer: accounts
  // are provisioned in bulk with a temporary password, and the first sign-in
  // forces a real one.
  const passwordSignIn = async () => {
    const email = $('email').value.trim();
    const password = $('password').value;
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    if (!password) return authError('Enter your password');
    const btn = $('pwSignIn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;
      if (await needsPasswordSetup()) { showSetPassword(email); return; }
      await onSignedIn();
    } catch (e) {
      authError(/invalid login/i.test(e.message || '')
        ? 'That email and password do not match. Check with whoever set up your account.'
        : e.message);
      busy(btn, false);
    }
  };
  $('pwSignIn').onclick = passwordSignIn;
  $('password').addEventListener('keydown', (e) => { if (e.key === 'Enter') passwordSignIn(); });

  // ---- forced password change ----
  const savePassword = async () => {
    const a = $('newPw').value;
    const b = $('newPw2').value;
    if (a.length < 8) return authError('Use at least 8 characters');
    if (a !== b) return authError('Those two passwords do not match');
    const btn = $('pwSave');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.updateUser({ password: a });
      if (error) throw error;
      // Only drop the latch once GoTrue has actually accepted the new password.
      await api.completePasswordSetup();
      await onSignedIn();
    } catch (e) {
      authError(e.message || 'Could not set that password');
      busy(btn, false);
    }
  };
  $('pwSave').onclick = savePassword;
  $('newPw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') savePassword(); });
  $('newPw').addEventListener('input', () => paintStrength($('newPw').value));

  // ---- request a code ----
  const sendCode = async () => {
    const email = $('email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    const btn = $('otpSend');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: true,
          // The link has to come back to THIS page, including when the mail app
          // opens it in a fresh tab.
          emailRedirectTo: location.origin + location.pathname,
        },
      });
      if (error) throw error;
      $('otpTarget').textContent = email;
      show('otpStep');
      hide('emailStep');
      $('code').focus();
      startCooldown();
    } catch (e) {
      const msg = /rate|limit|seconds/i.test(e.message || '')
        ? 'Too many codes requested. Wait a minute and try again, or continue as a guest.'
        : e.message;
      authError(msg);
    } finally { busy(btn, false); }
  };
  $('otpSend').onclick = sendCode;
  $('email').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendCode(); });

  // ---- verify ----
  const verify = async () => {
    const email = $('email').value.trim();
    const token = $('code').value.replace(/\s/g, '');
    if (token.length < 6) return authError('Enter the 6-digit code from your email');
    const btn = $('otpVerifyBtn');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.verifyOtp({ email, token, type: 'email' });
      if (error) throw error;
      const name = $('displayName').value.trim();
      if (name) await api.setProfile({ display_name: name });
      await onSignedIn();
    } catch (e) {
      authError(/expired|invalid/i.test(e.message || '')
        ? 'That code is wrong or expired. Request a new one.'
        : e.message);
      busy(btn, false);
    }
  };
  $('otpVerifyBtn').onclick = verify;
  $('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });
  $('code').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '').slice(0, 8);
    if (e.target.value.length === 6) verify();
  });

  $('otpBack').onclick = () => {
    hide('otpStep');
    show('emailStep');
    authError('');
    stopCooldown();
  };
  $('otpResend').onclick = () => { if (!$('otpResend').disabled) sendCode(); };

  // ---- sign out ----
  // Sign out lives in the user menu now (js/shell.js). The old top-level button
  // is gone, so bind only if some surface still offers one.
  const so = $('signout');
  if (so) {
    so.onclick = async () => {
      // Same as the user menu: the cached conversations come off the device.
      await Promise.all([
        import('../lib/pagecache.js').then((m) => m.wipe()),
        import('../lib/readcache.js').then((m) => m.wipe()),
      ]).catch(() => { /* signing out must not be blocked by storage */ });
      await sb.auth.signOut();
      location.hash = '';
      location.reload();
    };
  }
}

function startCooldown() {
  let n = RESEND_SECONDS;
  const b = $('otpResend');
  b.disabled = true;
  const tick = () => {
    b.textContent = n > 0 ? `Resend in ${n}s` : 'Resend code';
    b.disabled = n > 0;
    if (n-- > 0) resendTimer = setTimeout(tick, 1000);
  };
  stopCooldown();
  tick();
}
function stopCooldown() { if (resendTimer) { clearTimeout(resendTimer); resendTimer = null; } }

// Whether this session is still on a provisioned temporary password. Failing
// open would be wrong in the other direction: if the check itself errors we do
// NOT trap someone on the reset screen, we let them in and they keep the latch
// until the next sign-in.
export async function needsPasswordSetup() {
  const [flag] = await tryRpc('must_set_password', {});
  return flag === true;
}

export function showSetPassword(email) {
  hide('emailStep');
  hide('otpStep');
  show('setPwStep');
  $('pwWho').textContent = email ? `, ${email}` : '';
  authError('');
  setTimeout(() => $('newPw').focus(), 40);
}

// A calm strength hint rather than a scolding validator: length is what actually
// matters, with a nudge for variety.
function paintStrength(v) {
  const meter = $('pwMeter');
  if (!meter) return;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
  if (/\d/.test(v) || /[^\w\s]/.test(v)) score++;
  meter.dataset.score = String(score);
  meter.querySelector('i').style.width = `${(score / 4) * 100}%`;
}

export async function currentUser() {
  const s = await session();
  return s?.user || null;
}

export function showAuth() {
  $('auth').classList.remove('hidden');
  $('chat').classList.add('hidden');
}
export function showChat() {
  $('auth').classList.add('hidden');
  $('chat').classList.remove('hidden');
}
