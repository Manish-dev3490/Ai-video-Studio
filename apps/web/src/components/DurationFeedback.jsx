import {useEffect, useRef, useState} from 'react';
import {ArrowRight, Clock3, RefreshCw, Sparkles} from 'lucide-react';
import {Link, useNavigate} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {studioApi, useGetMeQuery, useGetNarrationFeedbackQuery, useReviseDurationMutation} from '../store/api.js';
import {checkedDurationFeedback, durationCorrectionAvailable, durationPrivacyVersion, durationRequest, durationRevisionRequired, durationRoute, subscribeDurationPrivacy, uncertainDurationOutcome} from '../lib/duration.js';
import {friendlyError} from '../lib/forms.js';

export function DurationFeedback({project, job, storyboard, dirty = false, disabled = false, onBusyChange}) {
  const identity = useGetMeQuery();
  const ownerId = identity.data?.id;
  const validJob = durationRevisionRequired(job) && job.projectId === project?.id;
  const feedback = useGetNarrationFeedbackQuery(job?.id, {skip: !validJob});
  const [revise] = useReviseDurationMutation();
  const [pending, setPending] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const operation = useRef(null);
  const latestOwner = useRef(ownerId); latestOwner.current = ownerId;
  const navigate = useNavigate();
  const dispatch = useDispatch();
  const saved = checkedDurationFeedback(feedback.currentData, job);
  const selectedCorrection = Boolean(saved?.correctedStoryboardId);
  const eligible = durationCorrectionAvailable({project, storyboard, job, dirty});
  useEffect(() => {
    const reset = () => {
      operation.current?.abort?.(); operation.current = null;
      setPending(false); setChecking(false); setError(''); setUncertain(false);
    };
    reset();
    const unsubscribe = subscribeDurationPrivacy(reset);
    return () => {unsubscribe(); operation.current?.abort?.(); operation.current = null;};
  }, [ownerId, job?.id, project?.id]);
  useEffect(() => {onBusyChange?.(pending || checking); return () => onBusyChange?.(false);}, [pending, checking, onBusyChange]);
  const open = () => {dispatch(studioApi.util.invalidateTags(['Projects', {type: 'Project', id: project.id}, {type: 'Storyboard', id: project.id}])); navigate(durationRoute(project.id, job.id));};
  async function reviseNarration() {
    if (operation.current || pending || checking || uncertain || !eligible || !saved || !ownerId || disabled) return;
    const version = durationPrivacyVersion();
    const task = revise(durationRequest(project.id, job));
    operation.current = task; setPending(true); setError('');
    const current = () => operation.current === task && latestOwner.current === ownerId && version === durationPrivacyVersion();
    try {
      const draft = await task.unwrap();
      if (!current()) return;
      if (draft?.status !== 'DRAFT' || draft.parentStoryboardId !== job.storyboardId || draft.projectId !== project.id) throw {status: 'PARSING_ERROR'};
      open();
    } catch (failure) {
      if (!current()) return;
      if (uncertainDurationOutcome(failure)) {
        setUncertain(true);
        setError('The connection ended before confirmation. A corrected draft may already be saved. Check the saved result before requesting another revision.');
        try {
          const result = checkedDurationFeedback(await feedback.refetch().unwrap(), job);
          if (current() && result?.correctedStoryboardId) open();
        } catch { /* Checking the saved result never starts another AI request. */ }
      } else setError(friendlyError(failure, 'The narration could not be revised. Your approved script is preserved.'));
    } finally {
      if (current()) {operation.current = null; setPending(false);}
    }
  }
  async function checkSaved() {
    if (operation.current || checking || !ownerId) return;
    const version = durationPrivacyVersion(), token = {};
    operation.current = token; setChecking(true); setError('');
    const current = () => operation.current === token && version === durationPrivacyVersion() && latestOwner.current === ownerId;
    try {
      const value = checkedDurationFeedback(await feedback.refetch().unwrap(), job);
      if (!current()) return;
      if (value?.correctedStoryboardId) open();
      else {setUncertain(false); setError('No corrected draft is saved yet. You can try the revision again. If the earlier request is still running, the studio will ask you to wait.');}
    } catch (failure) {if (current()) setError(friendlyError(failure, 'The saved result could not be checked. Please try this check again.'));}
    finally {if (current()) {operation.current = null; setChecking(false);}}
  }
  if (!validJob) return null;
  return <section className="duration-feedback" aria-label="Narration timing feedback"><div className="duration-feedback-heading"><Clock3 size={20} /><div><p className="eyebrow">MEASURED SPEECH</p><h2>Let’s fit the narration to your video.</h2></div></div>
    <p>The narration was measured at its natural voice speed. No speech was cut or sped up, and this attempt did not publish a video.</p>
    {feedback.isLoading ? <p role="status">Loading the measured timing…</p> : feedback.error ? <div className="duration-feedback-error"><p role="alert">{friendlyError(feedback.error, 'The measured timing could not be loaded.')}</p><button className="text-link" onClick={feedback.refetch}><RefreshCw size={13} />Check timing again</button></div> : saved ? <>
      <dl className="duration-measurements"><div><dt>Requested length</dt><dd>{saved.targetDurationSec} seconds</dd></div><div><dt>Measured length</dt><dd>{saved.measuredDurationSec.toFixed(2)} seconds</dd></div><div><dt>Saved narration</dt><dd>{saved.narrationWords} words</dd></div><div><dt>Revision guide</dt><dd>About {saved.suggestedNarrationWords} words</dd></div></dl>
      <p className="duration-revision-note">A new AI draft can {saved.direction === 'SHORTEN' ? 'shorten' : 'expand'} the narration using this measured pacing. Word counts are guidance; actual speech is checked again. Your earlier approval stays preserved. Review and approve the new draft before another render.</p>
      {selectedCorrection ? <Link className="button button-secondary" to={durationRoute(project.id, job.id)}>Open corrected draft<ArrowRight size={15} /></Link> : uncertain ? <button className="button button-secondary" disabled={checking || pending || disabled} onClick={checkSaved}><RefreshCw size={15} />{checking ? 'Checking saved result…' : 'Check saved correction'}</button> : eligible ? <button className="button button-primary" disabled={pending || checking || disabled || !ownerId} onClick={reviseNarration}><Sparkles size={15} />{pending ? 'Revising narration…' : 'Revise narration to fit'}</button> : <p className="field-hint">{dirty ? 'Save or discard your local edits before requesting a narration revision.' : 'This attempt belongs to an earlier script. Open the current saved draft to continue.'}</p>}
    </> : <p className="field-hint">Detailed timing is not available for this earlier attempt. You can write a new draft and review its narration before approving again.</p>}
    {pending && <p role="status">Writing a new draft with the measured pacing. Your approved script is preserved.</p>}
    {error && <p className="form-alert" role="alert">{error}</p>}
  </section>;
}
