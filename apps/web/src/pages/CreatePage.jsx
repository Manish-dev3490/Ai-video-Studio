import {useEffect, useState} from 'react';
import {ArrowLeft, ArrowRight, Check, Layers, Save} from 'lucide-react';
import {Link, useNavigate} from 'react-router-dom';
import {useDispatch, useSelector} from 'react-redux';
import {useCreateProjectMutation, useGetCapabilitiesQuery} from '../store/api.js';
import {resetDraft} from '../store/index.js';
import {PromptComposer} from '../components/PromptComposer.jsx';
import {ErrorPanel} from '../components/ui.jsx';
import {codePoints, friendlyError} from '../lib/forms.js';
import {defaultSettings} from '../lib/storyboard.js';
import {assistantInputError, assistantRoute} from '../lib/assistant.js';

export function CreatePage() {
  const capabilities = useGetCapabilitiesQuery();
  const draft = useSelector(state => state.draft);
  const dispatch = useDispatch();
  const [title, setTitle] = useState('');
  const [error, setError] = useState('');
  const [createProject, {isLoading}] = useCreateProjectMutation();
  const navigate = useNavigate();
  useEffect(() => { document.title = 'Create video · AI Video Studio'; }, []);
  async function save(event, destination = 'review') {
    event.preventDefault();
    const cleanTitle = title.trim();
    if (!cleanTitle || codePoints(cleanTitle) > 120) {setError('Give your project a title between 1 and 120 characters.'); return;}
    if (!draft.prompt.trim() || codePoints(draft.prompt) > 2000) {setError('Describe your idea in 1–2,000 characters.'); return;}
    if (destination === 'assistant' && assistantInputError(draft.prompt)) {setError(assistantInputError(draft.prompt)); return;}
    if (!capabilities.data?.durationsSec.includes(draft.durationSec)) {setError('Choose an available duration before saving.'); return;}
    setError('');
    try {
      const project = await createProject({title: cleanTitle, prompt: draft.prompt.trim(), settings: defaultSettings(draft.durationSec)}).unwrap();
      dispatch(resetDraft());
      navigate(destination === 'assistant' ? assistantRoute(project.id) : `/app/projects/${encodeURIComponent(project.id)}/review`);
    } catch (failure) {setError(friendlyError(failure, 'Your project could not be saved. Your idea is still here. Try again.'));}
  }
  return <><Link className="text-link back-link" to="/app"><ArrowLeft size={14} />Back to overview</Link><div className="page-heading"><p className="eyebrow">FIRST, THE IDEA</p><h1>What should we create?</h1><p>Save your idea, shape the script, then approve every scene.</p></div><form className="create-grid" onSubmit={save}><div><div className="field project-title-field"><label htmlFor="project-title">Project title</label><input id="project-title" placeholder="A name for your next story" value={title} onChange={event => setTitle(event.target.value)} disabled={isLoading} /><span className="field-hint">A private name you can change later.</span></div><PromptComposer capabilities={capabilities.data} creation />{capabilities.error && <ErrorPanel message={friendlyError(capabilities.error)} onRetry={capabilities.refetch} />}{error && <div className="form-alert" role="alert">{error}</div>}<div className="project-save-bar"><p><Save size={16} />Saving keeps your idea and settings in your private account.</p><div className="flow-actions"><button className="button button-secondary" type="button" disabled={isLoading || !capabilities.data || !draft.prompt.trim()} onClick={event => save(event, 'assistant')}>Save & chat with AI</button><button className="button button-primary" type="submit" disabled={isLoading || !capabilities.data || !draft.prompt.trim()}>{isLoading ? 'Saving project…' : 'Save project'}<ArrowRight size={16} /></button></div></div></div><aside className="creation-inspector"><span className="eyebrow">THE SHAPE OF YOUR STORY</span><h2>Simple by design.</h2><p>Your idea stays private to your account. Script generation sends its text and selected settings to Gemini.</p><div className="creation-step"><span>01</span><div><strong>Save your idea</strong><p>Choose a title and duration.</p></div><Check size={15} /></div><div className="creation-step is-upcoming"><span>02</span><div><strong>Review the script</strong><p>Read, edit and approve the exact saved revision.</p></div></div><div className="creation-step is-upcoming"><span>03</span><div><strong>Render your video</strong><p>Follow background progress, then preview and download.</p></div></div><div className="inspector-footer"><Layers size={17} /><p>Faceless explainers<br /><span>English · landscape</span></p></div></aside></form></>;
}
