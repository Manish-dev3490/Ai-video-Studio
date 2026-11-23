import {useEffect, useMemo, useRef, useState, useSyncExternalStore} from 'react';
import {ArrowLeft, ArrowRight, Check, MessageCircle, RefreshCw, Send, Sparkles} from 'lucide-react';
import {Link, useNavigate, useParams} from 'react-router-dom';
import {useDispatch} from 'react-redux';
import {studioApi, useGenerateStoryboardMutation, useGetAssistantConversationQuery, useGetMeQuery, useGetProjectQuery, useLazyGetAssistantHistoryPageQuery, useUpdateProjectMutation} from '../store/api.js';
import {ErrorPanel, LoadingScreen} from '../components/ui.jsx';
import {codePoints, friendlyError} from '../lib/forms.js';
import {acceptAssistantSubmission, assistantDraftSession, assistantError, assistantInputError, assistantPrivacyVersion, beginAssistantSubmission, currentAssistantSession, failAssistantSubmission, initializeAssistantDraft, latestAssistantSuggestion, mergeAssistantHistory, requestAssistantMessage, sendingAssistantSubmission, settingLabel, settingText, subscribeAssistantSession, suggestedSettingsChanges, updateAssistantDraft} from '../lib/assistant.js';
import {notifyAssistantUpdated} from '../lib/session-events.js';
import {generateScriptWithRecovery} from '../lib/storyboard.js';

export function AssistantPage() {
  const {projectId} = useParams();
  const {data: user} = useGetMeQuery();
  const project = useGetProjectQuery(projectId);
  const history = useGetAssistantConversationQuery(projectId, {skip: !project.data, refetchOnMountOrArgChange: true});
  const [loadNext] = useLazyGetAssistantHistoryPageQuery();
  const [updateProject, updating] = useUpdateProjectMutation();
  const [generate, generating] = useGenerateStoryboardMutation();
  const privacyVersion = assistantPrivacyVersion();
  const session = useMemo(() => user ? assistantDraftSession(user.id, projectId) : null, [user?.id, projectId, privacyVersion]);
  useSyncExternalStore(listener => subscribeAssistantSession(session, listener), () => session?.version || 0);
  const [extraMessages, setExtraMessages] = useState([]);
  const [extraCursor, setExtraCursor] = useState(undefined);
  const [loadingNext, setLoadingNext] = useState(false);
  const [preparingScript, setPreparingScript] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const bottom = useRef(null), thread = useRef(null), composer = useRef(null), feedback = useRef(null);
  const mounted = useRef(true), inFlight = useRef(false), nearBottom = useRef(true), initializedView = useRef(false);
  const currentProjectId = useRef(projectId);
  currentProjectId.current = projectId;
  const navigate = useNavigate(), dispatch = useDispatch();
  const messages = useMemo(() => mergeAssistantHistory(history.data?.messages || [], extraMessages), [history.data, extraMessages]);
  const nextCursor = extraCursor === undefined ? history.data?.nextCursor : extraCursor;
  const pending = session?.pending;
  const sending = Boolean(pending?.inFlight);
  const remaining = Math.max(0, Math.ceil((retryAt - now) / 1000));
  const busy = sending || updating.isLoading || generating.isLoading || loadingNext || preparingScript;
  const latestRevision = messages.at(-1)?.conversationRevision || 0;
  const historyStale = Boolean(session && session.lastRevision > latestRevision);
  const suggestion = latestAssistantSuggestion(messages);
  const changes = suggestedSettingsChanges(project.data?.settings, suggestion);
  const changeKeys = changes ? Object.keys(changes) : [];
  const activeRender = project.data?.phase === 'RENDERING';

  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  useEffect(() => {if (project.data) document.title = `${project.data.title} · AI assistant`;}, [project.data?.title]);
  useEffect(() => {setExtraMessages([]); setExtraCursor(undefined);}, [history.data]);
  useEffect(() => {
    if (!session || !project.data || !history.data) return;
    initializeAssistantDraft(session, history.data.messages.length ? '' : project.data.prompt);
  }, [session, project.data, history.data]);
  useEffect(() => {
    if (!messages.length) return;
    if ((!initializedView.current || nearBottom.current) && thread.current) thread.current.scrollTop = thread.current.scrollHeight;
    initializedView.current = true;
  }, [messages.length, latestRevision]);
  useEffect(() => {if (error) feedback.current?.focus();}, [error]);
  useEffect(() => {if (!remaining) return; const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer);}, [remaining > 0]);

  async function submit({replayOnly = false, existing = false} = {}) {
    if (!session || inFlight.current || busy || remaining || (!existing && (history.isFetching || history.error || nextCursor || historyStale))) return;
    let request;
    try {request = existing ? session.pending : beginAssistantSubmission(session, latestRevision);} catch (failure) {setError(failure.message); composer.current?.focus(); return;}
    if (!request) return;
    inFlight.current = true; sendingAssistantSubmission(session, request, {replayOnly}); setError(''); setNotice(''); nearBottom.current = true;
    try {
      const reply = await requestAssistantMessage({projectId, message: request.message, idempotencyKey: request.key, replayOnly, signal: request.controller.signal});
      if (!acceptAssistantSubmission(session, request, reply)) return;
      dispatch(studioApi.util.invalidateTags([{type: 'AssistantHistory', id: projectId}]));
      notifyAssistantUpdated(projectId);
      if (mounted.current) {setNotice('The reply is saved to this project.'); composer.current?.focus();}
    } catch (failure) {
      if (!currentAssistantSession(session)) return;
      failAssistantSubmission(session, request, failure);
      if (!mounted.current) return;
      setError(assistantError(failure));
      if (['PROJECT_CHANGED', 'PROJECT_BUSY'].includes(failure.data?.error?.code)) dispatch(studioApi.util.invalidateTags([{type: 'Project', id: projectId}]));
      if (failure.status === 429) {const time = Date.now(); setRetryAt(time + (failure.retryAfter || 2) * 1000); setNow(time);}
      if ([401, 403, 404].includes(failure.status) && failure.data?.error?.code !== 'ASSISTANT_REQUEST_NOT_FOUND') {dispatch(studioApi.util.invalidateTags(['User', {type: 'Project', id: projectId}]));}
      else dispatch(studioApi.util.invalidateTags([{type: 'AssistantHistory', id: projectId}]));
    } finally {inFlight.current = false;}
  }
  async function moreHistory() {
    if (!nextCursor || busy) return;
    setLoadingNext(true); setError('');
    try {const next = await loadNext({projectId, cursor: nextCursor, limit: 50}).unwrap(); setExtraMessages(previous => mergeAssistantHistory(previous, next.messages)); setExtraCursor(next.nextCursor);}
    catch (failure) {setError(assistantError(failure));}
    finally {setLoadingNext(false);}
  }
  async function applySuggestion() {
    if (busy || pending || activeRender || !changeKeys.length || history.isFetching || historyStale) return;
    setError(''); setNotice('');
    try {
      await updateProject({id: projectId, settings: changes}).unwrap();
      setNotice('Suggested settings applied. Generate a new draft, then review and approve it. Earlier approved scripts and outputs are preserved.');
    } catch (failure) {setError(assistantError(failure)); if (['PROJECT_CHANGED', 'PROJECT_BUSY'].includes(failure.data?.error?.code)) project.refetch();}
  }
  async function createScript() {
    if (inFlight.current || busy || pending || activeRender || history.isFetching || history.error || nextCursor || historyStale || session?.draft.trim()) return;
    inFlight.current = true; setPreparingScript(true);
    setError(''); setNotice('');
    try {
      await generateScriptWithRecovery({
        generate: () => generate(projectId).unwrap(), projectId, previousStoryboardId: project.data?.currentStoryboardId,
        readProject: () => project.refetch().unwrap(),
        readCurrentStoryboard: () => dispatch(studioApi.endpoints.getCurrentStoryboard.initiate(projectId, {subscribe: false, forceRefetch: true})).unwrap(),
      });
      if (mounted.current && currentProjectId.current === projectId && currentAssistantSession(session)) navigate(`/app/projects/${encodeURIComponent(projectId)}/review`);
    }
    catch (failure) {setError(friendlyError(failure, 'The script could not be prepared. Open script review to check for a saved draft before generating again.')); if (['PROJECT_CHANGED', 'PROJECT_BUSY'].includes(failure.data?.error?.code)) project.refetch();}
    finally {inFlight.current = false; if (mounted.current) setPreparingScript(false);}
  }

  if (project.isLoading || !user) return <LoadingScreen message="Opening your project assistant…" />;
  if (project.error || [401, 403, 404].includes(history.error?.status)) return <ErrorPanel title="Conversation unavailable" message={friendlyError(project.error || history.error, 'This project is deleted or unavailable to your account.')} onRetry={() => {project.refetch(); if (history.data) history.refetch();}} />;
  return <>
    <Link className="text-link back-link" to="/app/projects"><ArrowLeft size={14} />My projects</Link>
    <div className="project-page-heading assistant-heading"><div><p className="eyebrow">AN IDEA, SHAPED TOGETHER</p><h1>{project.data.title}</h1><p>Chat about the explanation, then choose what goes into your script.</p></div><Link className="button button-secondary" to={`/app/projects/${encodeURIComponent(projectId)}/review`}>Review script<ArrowRight size={15} /></Link></div>
    {activeRender && <div className="flow-notice" role="status">A video is currently rendering. You can discuss future changes here; settings and script generation become available after that attempt finishes.</div>}
    <div className="assistant-grid">
      <section className="assistant-workspace" aria-label="Project conversation">
        <header className="assistant-thread-heading"><div><MessageCircle size={20} /><div><h2>AI assistant</h2><p>Saved to this project · private to your account</p></div></div><button className="text-link" disabled={busy || history.isFetching} onClick={() => history.refetch()}><RefreshCw size={14} />{history.isFetching ? 'Refreshing…' : 'Refresh history'}</button></header>
        {history.error && <ErrorPanel title="Saved conversation could not refresh" message={assistantError(history.error)} onRetry={history.refetch} />}
        {history.isLoading ? <div className="assistant-history-loading" role="status"><span className="loading-line" /><p>Opening saved messages…</p></div> : <div className="assistant-thread" ref={thread} onScroll={() => {const element = thread.current; nearBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 120;}} role="log" aria-label="Saved conversation" aria-live="polite" aria-relevant="additions text">
          {!messages.length && !history.error && <div className="assistant-empty"><span><Sparkles size={23} /></span><h3>Let’s find the story in your idea.</h3><p>Send your saved idea below. The assistant can ask clarifying questions, suggest a structure and propose supported settings.</p><p>Your first message is not sent until you choose Send message.</p></div>}
          {messages.map(message => <article className={`assistant-message is-${message.role.toLowerCase()}`} key={message.id} aria-label={`${message.role === 'USER' ? 'You' : 'Assistant'}, message ${message.conversationRevision}`}><div className="assistant-message-meta"><span>{message.role === 'USER' ? 'You' : 'AI assistant'}</span><time dateTime={message.createdAt}>{new Date(message.createdAt).toLocaleTimeString(undefined, {hour: '2-digit', minute: '2-digit'})}</time></div><p>{message.content}</p></article>)}
          {sending && <div className="assistant-thinking" role="status"><span className="loading-line" />{pending?.replayOnly ? 'Checking the saved request…' : 'The assistant is preparing a reply…'}</div>}
          <div ref={bottom} />
        </div>}
        {nextCursor && <div className="assistant-more"><p>More recent saved messages are available. Load them before continuing.</p><button className="button button-secondary" disabled={busy} onClick={moreHistory}>{loadingNext ? 'Loading messages…' : 'Load next messages'}</button></div>}
        <div className="assistant-composer">
          {error && <div className="form-alert" role="alert" tabIndex={-1} ref={feedback}>{error}</div>}
          {notice && <div className="success-message" role="status">{notice}</div>}
          {historyStale && !history.isFetching && <p className="assistant-receipt-note">A reply was saved. Refresh history to display the latest conversation.</p>}
          {pending?.uncertain && <div className="assistant-uncertain"><h3>The last submission is not confirmed.</h3><p>Your text is preserved. Check its saved receipt first, or retry the same request without creating another submission.</p><details><summary>Submitted message</summary><p>{pending.message}</p></details><div className="flow-actions"><button className="button button-secondary" disabled={busy || remaining > 0} onClick={() => submit({existing: true, replayOnly: true})}>Check saved reply</button><button className="button button-secondary" disabled={busy || remaining > 0} onClick={() => submit({existing: true})}>Retry same request</button></div></div>}
          <form onSubmit={event => {event.preventDefault(); submit();}}>
            <label htmlFor="assistant-message">Message the AI assistant</label>
            <textarea id="assistant-message" ref={composer} value={session?.draft || ''} disabled={sending || generating.isLoading} onChange={event => updateAssistantDraft(session, event.target.value)} onKeyDown={event => {if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {event.preventDefault(); if (!pending) submit();}}} rows={3} placeholder="Add a topic, answer a question, or tell us who the video is for…" aria-describedby="assistant-message-hint assistant-message-count" aria-invalid={codePoints(session?.draft || '') > 2000} />
            <div className="assistant-composer-bottom"><p id="assistant-message-hint">Enter to send · Shift + Enter for a new line<br /><span>Do not include passwords, API keys or sensitive personal information.</span></p><span id="assistant-message-count" className={codePoints(session?.draft || '') > 2000 ? 'is-invalid' : ''}>{codePoints(session?.draft || '').toLocaleString()} / 2,000</span><button className="button button-primary" type="submit" disabled={busy || Boolean(pending) || remaining > 0 || !session?.draft.trim() || Boolean(assistantInputError(session?.draft || '')) || history.isLoading || history.isFetching || Boolean(history.error) || Boolean(nextCursor) || historyStale}><Send size={16} />Send message</button></div>
            {session?.draft && assistantInputError(session.draft) && <p className="field-error">{assistantInputError(session.draft)}</p>}
            {remaining > 0 && <p className="field-hint" role="status">Requests can be retried after {new Date(retryAt).toLocaleTimeString()}.</p>}
          </form>
        </div>
      </section>
      <aside className="assistant-inspector">
        <section className="assistant-settings-card"><p className="eyebrow">THE CURRENT PLAN</p><h2>Saved video settings</h2><dl>{['durationSec', 'language', 'aspectRatio', 'mode'].map(key => <div key={key}><dt>{settingLabel(key)}</dt><dd>{settingText(key, project.data.settings[key])}</dd></div>)}</dl><details><summary>Original saved idea</summary><p>{project.data.prompt}</p></details></section>
        <section className="assistant-settings-card assistant-suggestions"><span className="assistant-card-symbol"><Sparkles size={20} /></span><h2>Suggested settings</h2>{changes === null ? <p>This suggestion does not match currently supported settings. Keep your saved settings and ask the assistant for an available option.</p> : changeKeys.length ? <><p>Review these changes before applying them.</p><dl>{changeKeys.map(key => <div key={key}><dt>{settingLabel(key)}</dt><dd><span>{settingText(key, project.data.settings[key] ?? null)}</span><ArrowRight size={12} /><strong>{settingText(key, changes[key])}</strong></dd></div>)}</dl><button className="button button-secondary" disabled={busy || Boolean(pending) || activeRender || history.isFetching || historyStale} onClick={applySuggestion}><Check size={15} />{updating.isLoading ? 'Applying settings…' : 'Apply suggested settings'}</button><p className="assistant-approval-note">Applying changes requires a new script and approval. Earlier approved scripts and available outputs are preserved.</p></> : <p>{messages.some(message => message.role === 'ASSISTANT') ? 'The latest suggestions match your saved settings. Nothing changes automatically.' : 'The assistant’s proposed changes will appear here. You decide which settings to apply.'}</p>}</section>
        <section className="assistant-next-step"><h2>Ready to shape the script?</h2><p>The draft uses your saved idea, settings and conversation. Answer any open questions, then review every scene before approval.</p><button className="button button-primary" disabled={busy || Boolean(pending) || activeRender || history.isLoading || history.isFetching || Boolean(history.error) || Boolean(nextCursor) || historyStale || Boolean(session?.draft.trim())} onClick={createScript}><Sparkles size={16} />{generating.isLoading ? 'Generating script…' : 'Generate script'}<ArrowRight size={15} /></button>{session?.draft.trim() && <p className="field-hint">Send your current message before generating a script.</p>}<p className="assistant-budget-note">Chat requests use a separate AI allowance. A failed provider attempt may count toward that allowance.</p></section>
      </aside>
    </div>
  </>;
}
