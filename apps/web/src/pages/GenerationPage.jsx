import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Check, CheckCircle2, Circle, RefreshCw, Square, XCircle} from 'lucide-react';
import {Link, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {studioApi, useCancelGenerationMutation, useGetCapabilitiesQuery, useGetGenerationQuery, useGetGenerationsQuery, useGetProjectQuery, useRetryGenerationMutation} from '../store/api.js';
import {ConfirmDialog} from '../components/ConfirmDialog.jsx';
import {ErrorPanel, LoadingScreen} from '../components/ui.jsx';
import {friendlyError} from '../lib/forms.js';
import {activeGeneration, admissionKey, forgetAdmission, generationPollInterval, retryAllowed, stageNames, stageOrder} from '../lib/storyboard.js';
import {DurationFeedback} from '../components/DurationFeedback.jsx';
import {durationRevisionRequired} from '../lib/duration.js';

const statusNames = {QUEUED: 'Waiting in the queue', PROCESSING: 'Your story is taking shape', CANCEL_REQUESTED: 'Stopping your generation', CANCELLED: 'Generation cancelled', COMPLETED: 'Your video is ready', FAILED: 'This attempt needs attention'};
export function GenerationPage() {
  const {projectId} = useParams();
  const [search] = useSearchParams();
  const project = useGetProjectQuery(projectId);
  const generationId = search.get('generation') || project.data?.latestGenerationId;
  const [pollingInterval, setPollingInterval] = useState(3000);
  const generation = useGetGenerationQuery(generationId, {skip: !generationId, pollingInterval, skipPollingIfUnfocused: true});
  const job = generation.currentData || (generation.data?.id === generationId ? generation.data : null);
  const history = useGetGenerationsQuery({projectId, limit: 20});
  const capabilities = useGetCapabilitiesQuery(undefined, {pollingInterval: 10000, skipPollingIfUnfocused: true});
  const [cancel, cancelling] = useCancelGenerationMutation();
  const [retry, retrying] = useRetryGenerationMutation();
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [error, setError] = useState('');
  const terminalSeen = useRef('');
  const dispatch = useDispatch();
  const navigate = useNavigate();
  useEffect(() => {setPollingInterval(3000); setError('');}, [generationId]);
  useEffect(() => {
    setPollingInterval(generationPollInterval(job, generation.error));
    if (job && !activeGeneration(job)) {
      const identity = job.id + ':' + job.status;
      if (terminalSeen.current !== identity) {terminalSeen.current = identity; dispatch(studioApi.util.invalidateTags(['Projects', 'Usage', 'Capabilities', {type: 'Project', id: projectId}, {type: 'Generations', id: projectId}]));}
    }
  }, [job, generation.error, dispatch, projectId]);
  useEffect(() => {document.title = `${job ? statusNames[job.status] : 'Render progress'} · AI Video Studio`;}, [job?.status]);
  async function requestCancel() {
    setError('');
    try {await cancel(generationId).unwrap(); setConfirmCancel(false); await generation.refetch();}
    catch (failure) {setError(friendlyError(failure, 'Cancellation could not be requested. Refresh the current status and try again.'));}
  }
  async function requestRetry() {
    const action = `retry:${generationId}`;
    setError('');
    try {const receipt = await retry({generationId, idempotencyKey: admissionKey(action)}).unwrap(); forgetAdmission(action); navigate(`/app/projects/${encodeURIComponent(projectId)}/generating?generation=${encodeURIComponent(receipt.generationId)}`);}
    catch (failure) {setError(friendlyError(failure));}
  }
  if (project.isLoading) return <LoadingScreen message="Opening render progress…" />;
  if (project.error) return <ErrorPanel title="Project unavailable" message={friendlyError(project.error, 'This project is not available to this account.')} onRetry={project.refetch} />;
  if (!generationId) return <section className="storyboard-empty"><h1>No render has started yet.</h1><p>Review and approve a script first.</p><Link className="button button-primary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Review script<ArrowRight size={16} /></Link></section>;
  if (generation.isLoading || !job && !generation.error) return <LoadingScreen message="Checking the saved generation state…" />;
  if (job && job.projectId !== projectId) return <ErrorPanel title="Generation unavailable" message="This generation does not belong to the selected project." />;
  const active = activeGeneration(job);
  const revisionRequired = ['DURATION_REVISION_REQUIRED', 'REVISION_REQUIRED'].includes(job?.error?.code);
  return <><Link className="text-link back-link" to={`/app/projects/${encodeURIComponent(projectId)}/review`}><ArrowLeft size={14} />Back to script</Link><div className="project-page-heading"><div><p className="eyebrow">BACKGROUND GENERATION</p><h1>{project.data.title}</h1><p>Your exact approved script is preserved for this attempt.</p></div><Link className="text-link" to="/app/projects">My projects<ArrowRight size={15} /></Link></div>
    {error && <div className="form-alert" role="alert">{error}</div>}{generation.error && <ErrorPanel title="Progress could not be refreshed" message={friendlyError(generation.error)} onRetry={generation.refetch} />}
    {job && <><section className={`generation-summary status-${job.status.toLowerCase()}`} role="status" aria-live="polite"><span className="generation-status-symbol">{job.status === 'COMPLETED' ? <CheckCircle2 size={30} /> : ['FAILED', 'CANCELLED'].includes(job.status) ? <XCircle size={30} /> : <span className="generation-pulse" />}</span><p className="eyebrow">{job.status.replaceAll('_', ' ')}</p><h2>{statusNames[job.status]}</h2><p>{job.status === 'QUEUED' ? 'The job is saved and waiting for a render slot.' : job.status === 'CANCEL_REQUESTED' ? 'Cancellation is requested. The attempt ends only after its work has stopped.' : job.status === 'COMPLETED' ? 'The MP4 and caption track passed validation and are ready to preview.' : job.status === 'CANCELLED' ? 'The background work has stopped. Your approved script is still saved.' : job.status === 'FAILED' ? revisionRequired ? 'The narration did not fit this duration. Revise the script and approve a new draft before rendering again.' : job.error?.message || 'The attempt could not finish. Your approved script remains saved.' : stageNames[job.stage]}</p><div className="generation-stage-count">{job.progress.completedStages} of {job.progress.totalStages} stages completed</div>{active && <p className="generation-background-note">You can leave this page. Generation continues in the background.</p>}</section>
      {durationRevisionRequired(job) && <DurationFeedback project={project.data} job={job} />}
      <ol className="generation-stages">{stageOrder.map((stage, index) => {const done = index < job.progress.completedStages; const current = job.stage === stage && job.status === 'PROCESSING'; return <li key={stage} className={`${done ? 'is-complete' : ''} ${current ? 'is-current' : ''}`}><span>{done ? <Check size={17} /> : <Circle size={17} />}</span><div><strong>{stageNames[stage]}</strong>{current && <small>In progress</small>}{done && <small>Completed</small>}</div></li>;})}</ol>
      <div className="generation-actions"><Link className="button button-secondary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Open script</Link>{job.status === 'COMPLETED' && <Link className="button button-primary" to={`/app/projects/${encodeURIComponent(projectId)}/preview?generation=${encodeURIComponent(job.id)}`}>Preview video<ArrowRight size={16} /></Link>}{active && <button className="button button-secondary" disabled={cancelling.isLoading || job.status === 'CANCEL_REQUESTED'} onClick={() => setConfirmCancel(true)}><Square size={14} />{job.status === 'CANCEL_REQUESTED' ? 'Cancellation requested' : 'Cancel generation'}</button>}{retryAllowed(job) && <button className="button button-primary" disabled={retrying.isLoading || !capabilities.data?.worker.available} onClick={requestRetry}><RefreshCw size={15} />{retrying.isLoading ? 'Submitting new attempt…' : 'Retry generation'}</button>}{revisionRequired && <Link className="button button-primary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Revise script<ArrowRight size={16} /></Link>}</div>
      {retryAllowed(job) && !capabilities.data?.worker.available && <p className="availability-note">Rendering is currently unavailable. Retry when the worker is online.</p>}
      <p className="generation-quota-note">Each accepted attempt reserves one daily slot. A user cancellation uses the slot if video rendering has already started.</p>
    </>}
    {history.data?.generations.length > 1 && <details className="generation-history"><summary>Earlier attempts</summary>{history.data.generations.map(attempt => <Link key={attempt.id} to={`/app/projects/${encodeURIComponent(projectId)}/generating?generation=${encodeURIComponent(attempt.id)}`}><span>{attempt.status.replaceAll('_', ' ')}</span><span>Revision {attempt.approvedRevision}</span><time dateTime={attempt.createdAt}>{new Date(attempt.createdAt).toLocaleString()}</time><ArrowRight size={14} /></Link>)}</details>}
    {confirmCancel && <ConfirmDialog title="Stop this generation?" confirmLabel="Request cancellation" busy={cancelling.isLoading} onConfirm={requestCancel} onDismiss={() => setConfirmCancel(false)}><p>The request waits for background work to stop. If video rendering has started, this attempt still uses its daily slot. Your approved script is preserved.</p></ConfirmDialog>}
  </>;
}
