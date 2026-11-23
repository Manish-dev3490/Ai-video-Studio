import {useEffect, useLayoutEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, CheckCircle2, KeyRound, MailCheck, ShieldCheck} from 'lucide-react';
import {Link, useLocation} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {Brand} from '../components/ui.jsx';
import {studioApi} from '../store/api.js';
import {resetDraft} from '../store/index.js';
import {notifyAccountUpdated, notifySessionChanged} from '../lib/session-events.js';
import {accountError, actionTokenFromFragment, captureActionLocation, emailAddressError, recoveryPasswordErrors, requestAccountAction} from '../lib/account-actions.js';

const copy = {
  forgot: {title: 'Reset your password', eyebrow: 'A WAY BACK TO YOUR WORKSPACE', intro: 'Enter your account email to request a password reset link.'},
  reset: {title: 'Choose a new password', eyebrow: 'A FRESH START', intro: 'Use a memorable passphrase. This link can be used once and expires after 30 minutes.', route: '/auth/reset-password', label: 'Reset password'},
  verify: {title: 'Confirm your email', eyebrow: 'YOUR ADDRESS, CONFIRMED', intro: 'Confirm that this email address belongs to you. Open the link from your email, then confirm below.', route: '/auth/verify-email', label: 'Verify email'},
  email: {title: 'Confirm your new email', eyebrow: 'KEEP YOUR ACCOUNT YOURS', intro: 'Confirm your new sign-in address. After confirmation, all previous sessions end and you will sign in with the new address.', route: '/auth/confirm-email-change', label: 'Confirm email change'},
};

export function RecoveryPage({mode}) {
  const content = copy[mode];
  const location = useLocation();
  const [token, setToken] = useState(() => mode === 'forgot' ? null : actionTokenFromFragment(window.location.hash));
  const [values, setValues] = useState({email: '', password: '', confirmation: ''});
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [success, setSuccess] = useState(false);
  const [delivery, setDelivery] = useState(null);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const linkVersion = useRef(0);
  const previousNavigation = useRef({key: location.key, hash: location.hash});
  const errorRef = useRef(null);
  const dispatch = useDispatch();
  const expectedPath = {reset: '/reset-password', verify: '/verify-email', email: '/confirm-email-change'}[mode];
  function adoptLink(token) {
    linkVersion.current++;
    setToken(token); setSuccess(false); setError(''); setErrors({});
    setValues({email: '', password: '', confirmation: ''});
    setRetryAt(0);
  }
  function captureCurrentLink() {
    if (!expectedPath || window.location.pathname !== expectedPath) return false;
    const captured = captureActionLocation(window.location, window.history);
    if (captured.present) adoptLink(captured.token);
    return captured.present;
  }
  useLayoutEffect(() => {
    if (!expectedPath) return;
    // Native same-document hash navigation need not generate a new router key.
    // Duplicate hash events after scrubbing are ignored, including StrictMode.
    const changed = () => {captureCurrentLink();};
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, [expectedPath]);
  useLayoutEffect(() => {
    if (!expectedPath) return;
    const changed = previousNavigation.current.key !== location.key || previousNavigation.current.hash !== location.hash;
    previousNavigation.current = {key: location.key, hash: location.hash};
    const captured = captureCurrentLink();
    if (!captured && changed && !location.hash && window.location.pathname === expectedPath) adoptLink(null);
  }, [expectedPath, location.key, location.hash]);
  useEffect(() => {document.title = `${content.title} · AI Video Studio`;}, [content.title]);
  useEffect(() => {if (error) errorRef.current?.focus();}, [error]);
  useEffect(() => {if (!retryAt) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, [retryAt]);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));

  async function submit(event) {
    event.preventDefault();
    if (inFlight.current || remaining || (mode !== 'forgot' && !token)) return;
    const next = mode === 'forgot' ? (emailAddressError(values.email) ? {email: emailAddressError(values.email)} : {}) : mode === 'reset' ? recoveryPasswordErrors(values.password, values.confirmation) : {};
    setErrors(next); setError('');
    if (Object.keys(next).length) {document.getElementById('recovery-' + Object.keys(next)[0])?.focus(); return;}
    inFlight.current = true; setBusy(true);
    const submittedVersion = linkVersion.current;
    try {
      const result = await requestAccountAction(mode === 'forgot' ? '/auth/forgot-password' : content.route, mode === 'forgot' ? {email: values.email.trim()} : mode === 'reset' ? {token, password: values.password} : {token});
      if (mode === 'reset' || mode === 'email') {
        dispatch(resetDraft()); dispatch(studioApi.util.resetApiState()); notifySessionChanged();
      } else if (mode === 'verify') {
        dispatch(studioApi.util.invalidateTags(['AccountProfile', 'User'])); notifyAccountUpdated();
      }
      // A response for an older link must not overwrite a freshly opened one.
      if (submittedVersion !== linkVersion.current) return;
      setValues({email: '', password: '', confirmation: ''});
      setSuccess(true); setToken(null);
      if (mode === 'forgot') {setDelivery(result?.emailDelivery); setRetryAt(Date.now() + 60000); setNow(Date.now());}
    } catch (failure) {
      if (submittedVersion !== linkVersion.current) return;
      setError(accountError(failure, 'This request could not be completed. Please try again.'));
      if (failure?.data?.error?.code === 'INVALID_ACTION_LINK') {setToken(null); setValues(previous => ({...previous, password: '', confirmation: ''}));}
      if (failure?.status === 429) {setRetryAt(Date.now() + (failure.retryAfter || 60) * 1000); setNow(Date.now());}
    } finally {inFlight.current = false; setBusy(false);}
  }

  const invalidLink = mode !== 'forgot' && !token && !success;
  return <main className="recovery-page">
    <Link className="recovery-brand" to="/login"><Brand /></Link>
    <section className="recovery-card" aria-labelledby="recovery-title">
      <span className="recovery-symbol" aria-hidden="true">{success ? <CheckCircle2 size={25} /> : mode === 'verify' || mode === 'email' ? <MailCheck size={25} /> : <KeyRound size={25} />}</span>
      <p className="eyebrow">{content.eyebrow}</p><h1 id="recovery-title">{content.title}</h1>
      {!success && <p className="recovery-intro">{content.intro}</p>}
      {error && <div className="form-alert" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
      {success ? <div className="recovery-result" role="status">
        <h2>{mode === 'forgot' ? 'Check for reset instructions.' : mode === 'reset' ? 'Your password has been reset.' : mode === 'verify' ? 'Email verified.' : 'Your sign-in email has changed.'}</h2>
        <p>{mode === 'forgot' ? 'If an eligible account matches, password reset instructions will be queued. The message is the same for every email address.' : mode === 'verify' ? 'Your email address is confirmed. Your saved projects and studio access stay available.' : 'All previous sessions for this account have ended. Sign in again to continue.'}</p>
        {mode === 'forgot' && delivery?.mode === 'LOCAL_PREVIEW' && <p className="delivery-mode-note">This studio uses a private local email preview. No message is sent to an inbox.</p>}
        {mode === 'forgot' && delivery?.mode === 'EMAIL' && <p>Check your inbox and spam folder. Delivery may take a moment.</p>}
        {mode === 'forgot' && !delivery && <p>Check the studio’s configured email delivery channel for the link.</p>}
        <Link className="button button-primary" to={mode === 'verify' ? '/app/settings' : '/login'}>{mode === 'verify' ? 'Open account' : 'Back to sign in'}<ArrowRight size={16} /></Link>
        {mode === 'forgot' && <button type="button" className="text-link recovery-secondary" disabled={remaining > 0} onClick={() => {setSuccess(false); setError('');}}>Request another reset link{remaining > 0 ? ` (${remaining}s)` : ''}</button>}
      </div> : invalidLink ? <div className="recovery-result">
        <h2>A new link is needed.</h2><p>This link is incomplete, expired or already used. Open a fresh link from your email delivery channel. Refreshing this page clears the link for your privacy.</p>
        <Link className="button button-primary" to={mode === 'reset' ? '/forgot-password' : '/app/settings'}>{mode === 'reset' ? 'Request a new reset link' : 'Open account settings'}<ArrowRight size={16} /></Link>
      </div> : <form onSubmit={submit} noValidate>
        {mode === 'forgot' && <div className="field"><label htmlFor="recovery-email">Email address</label><input id="recovery-email" type="email" autoComplete="email" inputMode="email" value={values.email} disabled={busy} onChange={event => setValues(previous => ({...previous, email: event.target.value}))} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'recovery-email-error' : undefined} />{errors.email && <p className="field-error" id="recovery-email-error">{errors.email}</p>}</div>}
        {mode === 'reset' && <><div className="field"><label htmlFor="recovery-password">New password</label><input id="recovery-password" type="password" autoComplete="new-password" value={values.password} disabled={busy} onChange={event => setValues(previous => ({...previous, password: event.target.value}))} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? 'recovery-password-error' : 'recovery-password-hint'} />{errors.password ? <p className="field-error" id="recovery-password-error">{errors.password}</p> : <p className="field-hint" id="recovery-password-hint">15–128 characters. Spaces and symbols are welcome.</p>}</div><div className="field"><label htmlFor="recovery-confirmation">Confirm new password</label><input id="recovery-confirmation" type="password" autoComplete="new-password" value={values.confirmation} disabled={busy} onChange={event => setValues(previous => ({...previous, confirmation: event.target.value}))} aria-invalid={Boolean(errors.confirmation)} aria-describedby={errors.confirmation ? 'recovery-confirmation-error' : undefined} />{errors.confirmation && <p className="field-error" id="recovery-confirmation-error">{errors.confirmation}</p>}</div></>}
        <button className="button button-primary recovery-submit" disabled={busy || remaining > 0} type="submit">{busy ? 'Submitting…' : mode === 'forgot' ? 'Send reset link' : content.label}<ArrowRight size={16} /></button>
        {remaining > 0 && <p className="field-hint" role="status">Try again in {remaining} seconds.</p>}
      </form>}
      <div className="recovery-footer"><ShieldCheck size={15} /><p>Links work once. Account changes require your confirmation.</p></div>
      <Link className="text-link recovery-back" to="/login"><ArrowLeft size={14} />Back to sign in</Link>
    </section><p className="recovery-bottom">AI Video Studio · Ideas, in motion.</p>
  </main>;
}
