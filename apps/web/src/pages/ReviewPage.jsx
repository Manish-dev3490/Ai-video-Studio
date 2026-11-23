import {useEffect, useRef, useState} from 'react';
import {ArrowLeft, ArrowRight, Check, CheckCircle2, Plus, Save, Sparkles} from 'lucide-react';
import {Link, useNavigate, useParams, useSearchParams} from 'react-router-dom';
import {useApproveStoryboardMutation, useEditStoryboardMutation, useGenerateStoryboardMutation, useGetCapabilitiesQuery, useGetCurrentStoryboardQuery, useGetGenerationQuery, useGetProjectQuery, useGetStoryboardQuery, useStartGenerationMutation, useUpdateProjectMutation} from '../store/api.js';
import {ErrorPanel, LoadingScreen} from '../components/ui.jsx';
import {ConfirmDialog} from '../components/ConfirmDialog.jsx';
import {SceneEditor} from '../components/SceneEditor.jsx';
import {friendlyError} from '../lib/forms.js';
import {admissionKey, defaultVisualProps, editorErrors, forgetAdmission, moveScene, storyboardSelected} from '../lib/storyboard.js';
import {assistantRoute} from '../lib/assistant.js';
import {ReportMisuse} from '../components/ReportMisuse.jsx';
import {DurationFeedback} from '../components/DurationFeedback.jsx';
import {durationRevisionRequired, narrationWordCount} from '../lib/duration.js';

const copy = value => structuredClone(value);
export function ReviewPage() {
  const {projectId} = useParams();
  const [search] = useSearchParams();
  const historicalId = search.get('storyboard');
  const durationSource = /^[a-f0-9]{24}$/u.test(search.get('durationSource') || '') ? search.get('durationSource') : null;
  const navigate = useNavigate();
  const project = useGetProjectQuery(projectId);
  const failedAttemptId = durationSource || project.data?.latestGenerationId;
  const failedAttempt = useGetGenerationQuery(failedAttemptId, {skip: Boolean(historicalId) || !failedAttemptId});
  const failedJob = failedAttempt.currentData;
  const current = useGetCurrentStoryboardQuery(projectId, {skip: Boolean(historicalId)});
  const version = useGetStoryboardQuery({projectId, storyboardId: historicalId}, {skip: !historicalId});
  const storyboard = historicalId ? version : current;
  const capabilities = useGetCapabilitiesQuery(undefined, {pollingInterval: 10000, skipPollingIfUnfocused: true});
  const [generate, generating] = useGenerateStoryboardMutation();
  const [save, saving] = useEditStoryboardMutation();
  const [approve, approving] = useApproveStoryboardMutation();
  const [start, starting] = useStartGenerationMutation();
  const [patchProject, patching] = useUpdateProjectMutation();
  const [base, setBase] = useState(null);
  const [scenes, setScenes] = useState([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [conflict, setConflict] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [title, setTitle] = useState('');
  const [duration, setDuration] = useState(30);
  const [durationBusy, setDurationBusy] = useState(false);
  const dirty = Boolean(base && JSON.stringify(base.scenes) !== JSON.stringify(scenes));
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;
  const busy = generating.isLoading || saving.isLoading || approving.isLoading || starting.isLoading || patching.isLoading || durationBusy;
  const running = project.data?.phase === 'RENDERING';
  const immutable = base?.status === 'APPROVED' || Boolean(historicalId);
  function adopt(value) {setBase(copy(value)); setScenes(copy(value.scenes)); setConflict(false);}
  useEffect(() => {if (storyboard.data && !dirtyRef.current && (historicalId ? storyboard.data.id === historicalId : storyboardSelected(project.data, storyboard.data))) adopt(storyboard.data);}, [storyboard.data, project.data, historicalId]);
  useEffect(() => {if (project.data) {setTitle(project.data.title); setDuration(project.data.settings.durationSec); document.title = `${project.data.title} · Review`; }}, [project.data]);
  useEffect(() => {const prevent = event => {if (dirtyRef.current) {event.preventDefault(); event.returnValue = '';}}; window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent);}, []);
  async function failed(failure) {
    setError(friendlyError(failure));
    const code = failure.data?.error?.code;
    if (failure.status === 409 && ['REVISION_CONFLICT', 'STORYBOARD_IMMUTABLE', 'REVISION_REQUIRED'].includes(code)) {setConflict(true); await storyboard.refetch();}
    if (code === 'PROJECT_BUSY') await project.refetch();
  }
  async function generateDraft() {
    setError(''); setNotice('');
    try {const value = await generate(projectId).unwrap(); adopt(value); navigate(`/app/projects/${encodeURIComponent(projectId)}/review`, {replace: true}); setNotice('Your new draft is saved. Review every scene before approval.');}
    catch (failure) {
      setError(friendlyError(failure));
      // A dropped response does not prove planning failed. Read the selected
      // draft before another provider call, preserving an already saved result.
      try {
        const persisted = await current.refetch().unwrap();
        if (!base || persisted.id !== base.id || persisted.revision !== base.revision) {adopt(persisted); setError(''); setNotice('A saved draft was found. Review it before requesting another draft.');}
      } catch { /* The existing error remains; no automatic planning retry. */ }
    }
  }
  async function saveScenes() {
    const errors = editorErrors(scenes);
    if (errors.length) {setError(errors.join(' ')); return;}
    setError(''); setNotice('');
    try {const value = await save({projectId, storyboardId: base.id, expectedRevision: base.revision, scenes}).unwrap(); adopt(value); setNotice(`Revision ${value.revision} saved. Read it once more before approval.`);}
    catch (failure) {await failed(failure);}
  }
  async function approveSaved() {
    if (dirty || !base || !storyboardSelected(project.data, base)) return;
    setError(''); setNotice('');
    try {await approve({projectId, storyboardId: base.id, expectedRevision: base.revision}).unwrap(); const value = await storyboard.refetch().unwrap(); adopt(value); setNotice('This exact revision is approved and frozen. Start rendering when you are ready.');}
    catch (failure) {await failed(failure);}
  }
  async function render() {
    if (!storyboardSelected(project.data, base)) {setError('The selected project settings changed. Generate and approve a new script before rendering.'); return;}
    const action = `start:${projectId}:${base.id}:${base.revision}`;
    setError('');
    try {const receipt = await start({projectId, storyboardId: base.id, approvedRevision: base.revision, idempotencyKey: admissionKey(action)}).unwrap(); forgetAdmission(action); navigate(`/app/projects/${encodeURIComponent(projectId)}/generating?generation=${encodeURIComponent(receipt.generationId)}`);}
    catch (failure) {await failed(failure);}
  }
  async function reloadSaved() {
    try {const value = await storyboard.refetch().unwrap(); adopt(value); setError(''); setConfirmReload(false);} catch (failure) {setError(friendlyError(failure));}
  }
  async function saveSettings(event) {
    event.preventDefault(); setError('');
    if (dirty) {setError('Save or discard your script edits before changing project settings.'); return;}
    try {
      const updated = await patchProject({id: projectId, title: title.trim(), ...(duration !== project.data.settings.durationSec ? {settings: {durationSec: duration}} : {})}).unwrap();
      if (!historicalId && !updated.currentStoryboardId) {
        dirtyRef.current = false; setBase(null); setScenes([]); setConflict(false);
        setNotice('Project settings saved. Generate a new script for these settings, then review and approve it. Earlier approvals and outputs are preserved.');
      } else {
        if (!historicalId) await current.refetch();
        setNotice('Project details saved.');
      }
    }
    catch (failure) {setError(friendlyError(failure));}
  }
  if (project.isLoading) return <LoadingScreen message="Opening the saved project…" />;
  if (project.error) return <><ErrorPanel title="Project unavailable" message={friendlyError(project.error, 'This project was deleted or is not available to this account.')} onRetry={project.refetch} /><ReportMisuse projectId={projectId} /></>;
  const approved = base?.status === 'APPROVED';
  const saved = project.data;
  const selected = storyboardSelected(saved, base);
  return <><Link className="text-link back-link" to="/app/projects"><ArrowLeft size={14} />My projects</Link><div className="project-page-heading"><div><p className="eyebrow">IDEA → SCRIPT → RENDER → PREVIEW</p><h1>{saved.title}</h1><p>{saved.settings.durationSec}s · English · 16:9 · Faceless explainer</p></div><div className="project-heading-actions"><Link className="button button-secondary" to={assistantRoute(projectId)}>Chat with AI<ArrowRight size={15} /></Link>{saved.latestOutputAssetId && <Link className="button button-secondary" to={`/app/projects/${encodeURIComponent(projectId)}/preview`}>View saved output<ArrowRight size={15} /></Link>}</div></div>
    <details className="saved-project-details"><summary>Saved idea & project settings</summary><p className="saved-prompt">{saved.prompt}</p><form onSubmit={saveSettings} className="project-settings-form"><div className="field"><label htmlFor="saved-project-title">Project title</label><input id="saved-project-title" value={title} disabled={busy || running} onChange={event => setTitle(event.target.value)} /></div><div className="field"><label htmlFor="saved-project-duration">Target duration</label><select id="saved-project-duration" value={duration} disabled={busy || running || Boolean(historicalId)} onChange={event => setDuration(Number(event.target.value))}>{(capabilities.data?.durationsSec || [30, 60, 90]).map(value => <option key={value} value={value}>{value} seconds</option>)}</select></div><button className="button button-secondary" disabled={busy || running}>Save project settings</button></form><p className="field-hint">Changing duration clears the selected script. Generate a new draft, then review and approve it. Earlier approved scripts and available outputs are preserved.</p></details>
    {running && <div className="flow-notice" role="status">This project has an active generation. <Link className="text-link" to={`/app/projects/${encodeURIComponent(projectId)}/generating${saved.latestGenerationId ? '?generation=' + encodeURIComponent(saved.latestGenerationId) : ''}`}>Open render progress<ArrowRight size={14} /></Link></div>}
    {error && <div className="form-alert" role="alert">{error}</div>}{notice && <div className="success-message" role="status">{notice}</div>}
    {generating.isLoading && <div className="planning-state" role="status"><span className="loading-line" aria-hidden="true" /><h2>Writing your script and storyboard…</h2><p>This can take a little while. Your project is saved; no video is rendering yet.</p></div>}
    {!historicalId && durationRevisionRequired(failedJob) && failedJob.projectId === projectId && saved.currentStoryboardId === failedJob.storyboardId && <DurationFeedback project={saved} storyboard={base} job={failedJob} dirty={dirty} disabled={generating.isLoading || saving.isLoading || approving.isLoading || starting.isLoading || patching.isLoading || running} onBusyChange={setDurationBusy} />}
    {durationSource && base?.status === 'DRAFT' && base.parentStoryboardId === failedJob?.storyboardId && <div className="success-message duration-corrected-notice" role="status">A corrected draft is saved for review. Read every scene, then approve this new revision before rendering. Your earlier approved script is preserved.</div>}
    {storyboard.isLoading ? <LoadingScreen message="Loading your storyboard…" /> : !base ? <section className="storyboard-empty"><Sparkles size={28} /><h2>Your idea is saved. Let’s shape the story.</h2><p>Gemini will write an editable script and choose supported visual templates. Review the result for accuracy before rendering.</p>{storyboard.error?.status !== 404 && storyboard.error && <ErrorPanel message={friendlyError(storyboard.error)} onRetry={storyboard.refetch} />}<div className="flow-actions"><button className="button button-primary" onClick={generateDraft} disabled={busy || running}><Sparkles size={16} />{generating.isLoading ? 'Generating script…' : 'Generate script'}</button><button className="button button-secondary" disabled={busy} onClick={async () => {try {adopt(await storyboard.refetch().unwrap()); setError('');} catch {setNotice('No saved draft is available yet.');}}}>Check saved draft</button></div></section> : <>
      <section className={`review-summary ${approved ? 'is-approved' : ''}`}><span className="review-symbol">{approved ? <CheckCircle2 size={23} /> : <Sparkles size={23} />}</span><div><h2>{approved ? `Approved revision ${base.revision}` : `Review draft · revision ${base.revision}`}</h2><p>{approved ? 'This script and its settings are frozen. A new draft is needed for later edits.' : 'AI explanations can contain mistakes. Check facts, narration and visual labels before approval.'}</p></div><span className="revision-badge">{scenes.length} scenes · {base.targetDurationSec}s target</span></section>
      {historicalId && <div className="flow-notice">You are reading a preserved storyboard version. <Link className="text-link" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Open current script</Link></div>}
      {conflict && <div className="revision-conflict"><h3>The saved revision changed.</h3><p>Your edits are still in the editor below. Reload discards them; compare first if you want to keep any wording.</p><button className="button button-secondary" disabled={busy} onClick={() => dirty ? setConfirmReload(true) : reloadSaved()}>Reload saved revision</button><details><summary>Compare with saved narration</summary>{storyboard.data?.scenes.map((scene, index) => <div className="comparison-scene" key={scene.sceneId}><h4>Saved scene {index + 1}</h4><p>{scene.narration}</p></div>)}</details></div>}
      <p className="narration-budget-note">Editor narration: <strong>{narrationWordCount(scenes)} words</strong>. Scene timings are estimates; the final video uses measured speech at its natural speed.</p>
      <div className="scene-editor-list">{scenes.map((scene, index) => <SceneEditor key={scene.sceneId} scene={scene} index={index} total={scenes.length} disabled={immutable || busy || running} onChange={value => setScenes(previous => previous.map((item, itemIndex) => itemIndex === index ? value : item))} onMove={change => setScenes(previous => moveScene(previous, index, change))} onRemove={() => setScenes(previous => previous.filter((_, itemIndex) => itemIndex !== index))} />)}</div>
      {!immutable && <button className="button button-secondary add-scene" disabled={busy || running || scenes.length >= 18} onClick={() => setScenes(previous => [...previous, {sceneId: 'scene_' + crypto.randomUUID().replaceAll('-', ''), template: 'TITLE', narration: '', estimatedDurationSec: 3, visualProps: defaultVisualProps('TITLE')}])}><Plus size={16} />Add scene</button>}
      <div className="storyboard-footer"><p>{dirty ? 'Unsaved edits — save before approval.' : approved ? 'Approved content is preserved.' : 'The displayed revision is saved.'}<span>Scene durations are estimates. Final timing follows measured narration.</span></p><div className="flow-actions">{!approved && !historicalId && <><button className="button button-secondary" disabled={!dirty || busy || running || !selected} onClick={saveScenes}><Save size={16} />{saving.isLoading ? 'Saving…' : 'Save changes'}</button><button className="button button-primary" disabled={dirty || busy || running || !selected} onClick={approveSaved}><Check size={16} />{approving.isLoading ? 'Approving…' : 'Approve script'}</button></>}{approved && !historicalId && <button className="button button-primary" disabled={busy || running || !selected || !capabilities.data?.worker.available} onClick={render}>{starting.isLoading ? 'Submitting render…' : 'Start rendering'}<ArrowRight size={16} /></button>}</div></div>
      {approved && !capabilities.data?.worker.available && !historicalId && <p className="availability-note" role="status">Rendering is currently unavailable. Your approved script is saved; this page checks availability automatically.</p>}
      {!historicalId && <div className="new-draft-action"><p>Want a different explanation? A new AI draft preserves earlier approvals and outputs.</p><button className="text-link" disabled={busy || running || dirty} onClick={generateDraft}><Sparkles size={14} />Generate new draft</button></div>}
    </>}
    {confirmReload && <ConfirmDialog title="Discard local script edits?" confirmLabel="Reload saved draft" busy={storyboard.isFetching} onConfirm={reloadSaved} onDismiss={() => setConfirmReload(false)}><p>The current editor text will be replaced with the saved revision.</p></ConfirmDialog>}
    <ReportMisuse projectId={projectId} />
  </>;
}
