import {useEffect, useRef, useState} from 'react';
import {CheckCircle2, Mail, Save, UserRound} from 'lucide-react';
import {useDispatch} from 'react-redux';
import {studioApi, useGetAccountProfileQuery, useUpdateAccountProfileMutation} from '../store/api.js';
import {ErrorPanel} from './ui.jsx';
import {accountError, emailAddressError, profileNameError, requestAccountAction} from '../lib/account-actions.js';
import {notifyAccountUpdated} from '../lib/session-events.js';

export function AccountProfile() {
  const profile = useGetAccountProfileQuery(undefined, {pollingInterval: 15000, skipPollingIfUnfocused: true});
  const [updateProfile, updateState] = useUpdateAccountProfileMutation();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [fields, setFields] = useState({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState('');
  const [retryAt, setRetryAt] = useState({verify: 0, email: 0});
  const [now, setNow] = useState(Date.now());
  const inFlight = useRef(false);
  const dirtyName = useRef(false);
  const identity = useRef(null);
  const errorRef = useRef(null);
  const dispatch = useDispatch();
  const account = profile.data;
  const busy = updateState.isLoading || Boolean(action);
  const emailAvailable = Boolean(account?.emailDelivery?.available);
  const verificationRemaining = Math.max(0, Math.ceil((retryAt.verify - now) / 1000));
  const emailRemaining = Math.max(0, Math.ceil((retryAt.email - now) / 1000));
  const waiting = verificationRemaining > 0 || emailRemaining > 0;
  useEffect(() => {
    if (!account) return;
    if (identity.current !== account.user.id) {
      identity.current = account.user.id; dirtyName.current = false;
      setName(account.user.displayName); setEmail(''); setCurrentPassword(''); setFields({}); setError(''); setNotice('');
    } else if (!dirtyName.current) setName(account.user.displayName);
  }, [account]);
  useEffect(() => {if (error) errorRef.current?.focus();}, [error]);
  useEffect(() => {if (!waiting) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, [waiting]);

  function failed(failure, fallback, kind) {
    setError(accountError(failure, fallback));
    if (failure?.status === 429 && kind && kind !== 'cancel') {setRetryAt(previous => ({...previous, [kind]: Date.now() + (failure.retryAfter || 60) * 1000})); setNow(Date.now());}
    if (failure?.status === 401) dispatch(studioApi.util.invalidateTags(['User', 'AccountProfile']));
  }
  async function saveName(event) {
    event.preventDefault();
    if (busy) return;
    const message = profileNameError(name); setFields({displayName: message}); setError(''); setNotice('');
    if (message) {document.getElementById('account-name')?.focus(); return;}
    try {
      const result = await updateProfile({displayName: name.trim().normalize('NFC')}).unwrap();
      dirtyName.current = false; setName(result.user.displayName);
      await dispatch(studioApi.util.upsertQueryData('getMe', undefined, result.user));
      notifyAccountUpdated(); setNotice('Your profile has been updated.');
    } catch (failure) {failed(failure);}
  }
  async function emailAction(kind, event) {
    event?.preventDefault();
    if (busy || inFlight.current || (kind === 'verify' && verificationRemaining) || (kind === 'email' && emailRemaining)) return;
    setError(''); setNotice(''); setFields({});
    if (kind === 'email') {
      const next = {};
      if (emailAddressError(email)) next.email = emailAddressError(email);
      else if (email.trim().toLowerCase() === account.user.email.toLowerCase()) next.email = 'Choose a different email address.';
      if (!currentPassword.isWellFormed() || Array.from(currentPassword).length < 1 || Array.from(currentPassword).length > 128) next.currentPassword = 'Enter your current password (up to 128 characters).';
      if (Object.keys(next).length) {setFields(next); document.getElementById(Object.keys(next)[0] === 'email' ? 'account-new-email' : 'account-current-password')?.focus(); return;}
    }
    inFlight.current = true; setAction(kind);
    try {
      await requestAccountAction(kind === 'verify' ? '/auth/request-email-verification' : '/account/email-change', kind === 'email' ? {email: email.trim(), currentPassword} : {}, kind === 'cancel' ? 'DELETE' : 'POST');
      await profile.refetch().unwrap(); notifyAccountUpdated();
      setNotice(kind === 'verify' ? (account.emailDelivery.mode === 'LOCAL_PREVIEW' ? 'Verification requested. Check the private local email preview for the latest link.' : 'Verification requested. Check your inbox for the latest link.') : kind === 'cancel' ? 'Your pending email change has been cancelled. The current address is unchanged.' : 'Confirmation requested for your new address. Your current sign-in address stays active until the change is confirmed.');
      if (kind !== 'cancel') {setRetryAt(previous => ({...previous, [kind]: Date.now() + 60000})); setNow(Date.now());}
      if (kind === 'email') setEmail('');
    } catch (failure) {failed(failure, undefined, kind);}
    finally {inFlight.current = false; setAction(''); if (kind === 'email') setCurrentPassword('');}
  }

  return <section className="settings-card account-profile-card"><div className="settings-card-heading"><UserRound size={19} /><h2>Your profile</h2></div>
    {profile.error ? <ErrorPanel message={accountError(profile.error)} onRetry={profile.refetch} /> : !account ? <div className="skeleton settings-skeleton" /> : <>
      <p className="settings-intro">Your display name appears throughout your private workspace.</p>
      {error && <div className="form-alert account-feedback" role="alert" tabIndex={-1} ref={errorRef}>{error}</div>}
      {notice && <div className="success-message account-feedback" role="status">{notice}</div>}
      <form className="account-edit-form" onSubmit={saveName} noValidate><div className="field"><label htmlFor="account-name">Display name</label><input id="account-name" autoComplete="name" value={name} onChange={event => {dirtyName.current = true; setName(event.target.value);}} disabled={busy} aria-invalid={Boolean(fields.displayName)} aria-describedby={fields.displayName ? 'account-name-error' : 'account-name-hint'} />{fields.displayName ? <p className="field-error" id="account-name-error">{fields.displayName}</p> : <p className="field-hint" id="account-name-hint">2–80 characters.</p>}</div><button className="button button-primary" type="submit" disabled={busy || name.trim().normalize('NFC') === account.user.displayName}><Save size={15} />{updateState.isLoading ? 'Saving profile…' : 'Save profile'}</button></form>
      <dl className="profile-details"><div><dt>Sign-in email</dt><dd>{account.user.email}</dd></div><div><dt>Email status</dt><dd><span className={`email-verification-status ${account.emailVerified ? 'is-verified' : ''}`}>{account.emailVerified ? <CheckCircle2 size={15} /> : <Mail size={15} />}{account.emailVerified ? 'Verified' : 'Not verified yet'}</span></dd></div></dl>
      {account.emailDelivery?.mode === 'LOCAL_PREVIEW' ? <p className="delivery-mode-note">Local email preview is active. Messages stay in the studio’s private preview; they are not sent to an inbox.</p> : !emailAvailable && <p className="delivery-mode-note is-unavailable">Email delivery is unavailable. Your account and projects remain available; the studio operator needs to connect email delivery.</p>}
      {!account.emailVerified && <div className="account-verification-actions"><p>Confirm that this address belongs to you. Verification does not interrupt access to your saved projects.</p><button className="button button-secondary" type="button" aria-label="Send verification email" disabled={busy || !emailAvailable || verificationRemaining > 0} onClick={() => emailAction('verify')}>{action === 'verify' ? 'Requesting verification…' : 'Send verification email'}</button></div>}
      {verificationRemaining > 0 && <p className="field-hint" role="status">Another verification email can be requested in {verificationRemaining} seconds.</p>}
      <details className="account-email-details"><summary>Change sign-in email</summary><p>Your current email remains active until you confirm the new address. Confirmation ends all previous sessions.</p>
        {account.pendingEmailChange && <div className="pending-email-change"><strong>Confirmation pending</strong><p>{account.pendingEmailChange.email}</p><p>Link expires <time dateTime={account.pendingEmailChange.expiresAt}>{new Date(account.pendingEmailChange.expiresAt).toLocaleString()}</time>.</p><button type="button" className="text-link" disabled={busy} onClick={() => emailAction('cancel')}>Cancel pending email change</button></div>}
        <form onSubmit={event => emailAction('email', event)} noValidate><div className="field"><label htmlFor="account-new-email">New email address</label><input id="account-new-email" type="email" autoComplete="email" value={email} disabled={busy || !emailAvailable} onChange={event => setEmail(event.target.value)} aria-invalid={Boolean(fields.email)} aria-describedby={fields.email ? 'account-email-error' : undefined} />{fields.email && <p className="field-error" id="account-email-error">{fields.email}</p>}</div><div className="field"><label htmlFor="account-current-password">Current password</label><input id="account-current-password" type="password" autoComplete="current-password" value={currentPassword} disabled={busy || !emailAvailable} onChange={event => setCurrentPassword(event.target.value)} aria-invalid={Boolean(fields.currentPassword)} aria-describedby={fields.currentPassword ? 'account-current-password-error' : undefined} />{fields.currentPassword && <p className="field-error" id="account-current-password-error">{fields.currentPassword}</p>}</div><button className="button button-secondary" type="submit" disabled={busy || !emailAvailable || emailRemaining > 0}>{action === 'email' ? 'Requesting confirmation…' : 'Send email confirmation'}</button>{emailRemaining > 0 && <p className="field-hint" role="status">Another email confirmation can be requested in {emailRemaining} seconds.</p>}</form>
      </details>
    </>}
  </section>;
}
