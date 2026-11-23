import {useEffect, useRef, useState} from 'react';
import {ArrowRight, Check, Eye, EyeOff, Layers, ShieldCheck} from 'lucide-react';
import {Link, Navigate, useLocation, useNavigate} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {studioApi, useGetMeQuery, useLoginMutation, useSignupMutation} from '../store/api.js';
import {resetDraft} from '../store/index.js';
import {friendlyError, safeReturnPath, validateAuthForm} from '../lib/forms.js';
import {Brand, LoadingScreen} from '../components/ui.jsx';
import {notifySessionChanged} from '../lib/session-events.js';

export function AuthPage({mode}) {
  const signup = mode === 'signup';
  const [values, setValues] = useState({displayName: '', email: '', password: ''});
  const [errors, setErrors] = useState({});
  const [serverError, setServerError] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const {data: user, isLoading: checkingSession, error: sessionError} = useGetMeQuery(undefined, {refetchOnMountOrArgChange: true});
  const [login, loginState] = useLoginMutation();
  const [createAccount, signupState] = useSignupMutation();
  const busy = loginState.isLoading || signupState.isLoading;
  const location = useLocation();
  const destination = safeReturnPath(location.state?.from);
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const errorRef = useRef(null);
  useEffect(() => { document.title = `${signup ? 'Create account' : 'Sign in'} · AI Video Studio`; }, [signup]);
  useEffect(() => { if (serverError) errorRef.current?.focus(); }, [serverError]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const next = validateAuthForm(values, mode);
    setErrors(next);
    setServerError('');
    if (Object.keys(next).length) { document.getElementById(Object.keys(next)[0])?.focus(); return; }
    try {
      const body = {email: values.email.trim(), password: values.password, ...(signup ? {displayName: values.displayName.trim()} : {})};
      const result = await (signup ? createAccount(body) : login(body)).unwrap();
      setValues({displayName: '', email: '', password: ''});
      dispatch(resetDraft());
      dispatch(studioApi.util.resetApiState());
      await dispatch(studioApi.util.upsertQueryData('getMe', undefined, result));
      notifySessionChanged();
      navigate(destination, {replace: true});
    } catch (error) { setServerError(friendlyError(error, signup ? 'Could not create your account. Please try again.' : 'Could not sign in. Please try again.')); }
  }

  if (checkingSession) return <LoadingScreen message="Checking your session…" />;
  if (user && !sessionError) return <Navigate to={destination} replace />;

  return <div className="auth-page">
    <aside className="auth-story">
      <Link className="auth-brand" to="/login"><Brand /></Link>
      <div className="auth-story-copy"><span className="eyebrow">YOUR IDEAS DESERVE A SCENE.</span><h1>A little spark.<br />A story in motion.</h1><p>Make room for your next idea. A calm, thoughtful workspace for creating narrated visual stories.</p>
        <div className="auth-scene" aria-hidden="true"><div className="scene-preview-top"><span><i />STORY IN PROGRESS</span><Layers size={16} /></div><div className="scene-orbit"><span /><span /><span /><i /></div><div className="scene-caption"><span>01 / THE BIG IDEA</span><strong>Start with a question.<br />Find a new perspective.</strong></div><div className="scene-timeline"><i /><i /><i /><i /></div></div>
        <div className="auth-story-points"><span><Check size={14} />Write before you render</span><span><Check size={14} />Your own private workspace</span></div>
      </div>
      <div className="auth-story-footer">A focused studio. An open canvas.</div>
    </aside>
    <main className="auth-form-side">
      <div className="auth-mobile-brand"><Brand /></div>
      <div className="auth-switch">{signup ? 'Already have an account?' : 'New to the studio?'} <Link to={signup ? '/login' : '/signup'} state={{from: destination}}>{signup ? 'Sign in' : 'Create account'}<ArrowRight size={14} /></Link></div>
      <div className="auth-form-container">
        <span className="auth-step-label">{signup ? 'MAKE IT YOURS' : 'GOOD TO SEE YOU'}</span>
        <h2>{signup ? 'Your story starts here.' : 'Welcome back.'}</h2>
        <p className="auth-intro">{signup ? 'Create your account and give your ideas a place to grow.' : 'Sign in to pick up where your ideas left off.'}</p>
        {location.state?.signedOut && !signup && <p className="success-message" role="status">You have been signed out.</p>}
        {sessionError && sessionError.status !== 401 && <p className="form-notice">We could not check your session. You can retry signing in below.</p>}
        {serverError && <div className="form-alert" role="alert" tabIndex={-1} ref={errorRef}>{serverError}</div>}
        <form onSubmit={submit} noValidate>
          {signup && <div className="field"><label htmlFor="displayName">Your name</label><input id="displayName" name="displayName" autoComplete="name" placeholder="How should we call you?" value={values.displayName} onChange={e => setValues({...values, displayName: e.target.value})} aria-invalid={Boolean(errors.displayName)} aria-describedby={errors.displayName ? 'displayName-error' : undefined} disabled={busy} />{errors.displayName && <p className="field-error" id="displayName-error">{errors.displayName}</p>}</div>}
          <div className="field"><label htmlFor="email">Email address</label><input id="email" name="email" type="email" autoComplete="email" inputMode="email" placeholder="you@example.com" value={values.email} onChange={e => setValues({...values, email: e.target.value})} aria-invalid={Boolean(errors.email)} aria-describedby={errors.email ? 'email-error' : undefined} disabled={busy} />{errors.email && <p className="field-error" id="email-error">{errors.email}</p>}</div>
          <div className="field"><label htmlFor="password">Password</label><div className="password-input"><input id="password" name="password" type={showPassword ? 'text' : 'password'} autoComplete={signup ? 'new-password' : 'current-password'} placeholder={signup ? 'A memorable passphrase' : 'Enter your password'} value={values.password} onChange={e => setValues({...values, password: e.target.value})} aria-invalid={Boolean(errors.password)} aria-describedby={errors.password ? 'password-error' : signup ? 'password-hint' : undefined} disabled={busy} /><button type="button" className="icon-button" onClick={() => setShowPassword(!showPassword)} aria-label={showPassword ? 'Hide password' : 'Show password'} aria-pressed={showPassword}>{showPassword ? <EyeOff size={17} /> : <Eye size={17} />}</button></div>{errors.password ? <p className="field-error" id="password-error">{errors.password}</p> : signup && <p className="field-hint" id="password-hint">15–128 characters. Spaces and symbols are welcome.</p>}</div>
          {!signup && <div className="auth-recovery-link"><Link className="text-link" to="/forgot-password">Forgot password?</Link></div>}
          <button className="button button-primary auth-submit" type="submit" disabled={busy}>{busy ? signup ? 'Creating your account…' : 'Signing you in…' : signup ? 'Create account' : 'Sign in'}{!busy && <ArrowRight size={17} />}</button>
        </form>
        {signup && <p className="field-hint auth-verification-hint">After signup, open Account to confirm your email address.</p>}
        <p className="auth-security"><ShieldCheck size={15} />Your session stays private and secure.</p>
        <div className="auth-fine-print">Create at your own pace.<br />No billing or paid plan is required.</div>
      </div>
      <footer className="auth-form-footer">AI Video Studio <span>IDEAS, IN MOTION.</span></footer>
    </main>
  </div>;
}
