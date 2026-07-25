// Auth: email one-time-code as the real path, guest as the zero-friction path.
// The OTP screen is a state machine (idle -> sent -> verifying) with a resend
// cooldown, because a code screen that silently does nothing is the fastest way
// to lose someone at the door.
import { sb, session } from '../sb.js';
import { api } from '../api.js';
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

export function initAuth(onSignedIn) {
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

  // ---- request a code ----
  const sendCode = async () => {
    const email = $('email').value.trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) return authError('Enter a valid email address');
    const btn = $('otpSend');
    busy(btn, true);
    authError('');
    try {
      const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: true } });
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
  $('signout').onclick = async () => {
    await sb.auth.signOut();
    location.hash = '';
    location.reload();
  };
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
