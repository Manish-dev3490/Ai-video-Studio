import {ArrowRight, ChevronDown, Clock3, Monitor, Sparkles} from 'lucide-react';
import {useDispatch, useSelector} from 'react-redux';
import {useNavigate} from 'react-router-dom';
import {useState} from 'react';
import {setDuration, setPrompt, resetDraft} from '../store/index.js';
import {useCreateProjectMutation} from '../store/api.js';
import {codePoints, friendlyError} from '../lib/forms.js';
import {assistantInputError, assistantProjectTitle, assistantRoute} from '../lib/assistant.js';
import {defaultSettings} from '../lib/storyboard.js';

export const exampleIdeas = [
  {label: 'Explain a big idea', prompt: 'Explain how the JavaScript event loop works with a simple visual example.'},
  {label: 'Teach something new', prompt: 'Teach a beginner how photosynthesis turns sunlight into energy.'},
  {label: 'Tell a product story', prompt: 'Explain how a reusable water bottle makes everyday life a little more sustainable.'},
];

export function PromptComposer({capabilities, creation = false}) {
  const {prompt, durationSec} = useSelector(state => state.draft);
  const dispatch = useDispatch();
  const navigate = useNavigate();
  const [createProject, {isLoading}] = useCreateProjectMutation();
  const [error, setError] = useState('');
  const count = codePoints(prompt);
  const supported = capabilities?.durationsSec || [];
  const invalid = count > 2000;
  async function startChat() {
    const invalidInput = assistantInputError(prompt);
    if (invalidInput) {setError(invalidInput); return;}
    if (isLoading || !supported.includes(durationSec)) return;
    setError('');
    try {
      const project = await createProject({title: assistantProjectTitle(prompt), prompt: prompt.trim(), settings: defaultSettings(durationSec)}).unwrap();
      dispatch(resetDraft());
      navigate(assistantRoute(project.id));
    } catch (failure) {setError(friendlyError(failure, 'Your idea could not be saved. Your text is still here. Please try again.'));}
  }
  return <div className="composer-wrap">
    <div className="prompt-composer">
      <div className="composer-label"><span className="assistant-icon"><Sparkles size={15} strokeWidth={1.5} /></span><span>A little direction goes a long way.</span><span className="draft-indicator">UNSAVED IDEA</span></div>
      <label className="sr-only" htmlFor="video-prompt">What would you like to explain?</label>
      <textarea id="video-prompt" value={prompt} disabled={!creation && isLoading} onChange={event => dispatch(setPrompt(event.target.value))} placeholder="What would you like to explain? Start with an idea, a topic, or a story…" aria-describedby="prompt-note prompt-count" aria-invalid={invalid} rows={4} />
      <div className="composer-bottom"><div className="composer-settings"><div className="duration-segment" role="group" aria-label="Target video duration"><Clock3 size={13} />{(supported.length ? supported : [30, 60, 90]).map(duration => <button key={duration} type="button" onClick={() => dispatch(setDuration(duration))} disabled={!supported.includes(duration)} aria-pressed={durationSec === duration} className={durationSec === duration ? 'is-selected' : ''}>{duration}s</button>)}</div><span className="setting-chip"><Monitor size={13} />{capabilities?.aspectRatios?.includes('16:9') ? '16:9' : 'Unavailable'}</span><span className="setting-chip language-chip">{capabilities?.languages?.includes('en') ? 'English' : 'Unavailable'}<ChevronDown size={11} aria-hidden="true" /></span></div><span id="prompt-count" className={`prompt-count ${invalid ? 'is-invalid' : ''}`}>{count.toLocaleString()} / 2,000</span></div>
      {!creation && <div className="composer-action"><p id="prompt-note">Save the idea, then shape it in chat.<br /><span>You choose which suggestions to apply.</span></p><button className="button button-primary" disabled={!prompt.trim() || invalid || !capabilities || isLoading} onClick={startChat}>{isLoading ? 'Saving your idea…' : 'Save idea & start chat'} <ArrowRight size={16} /></button></div>}
      {creation && <p className="draft-note" id="prompt-note">Your idea is not saved until you choose Save project.</p>}
    </div>
    {!creation && error && <div className="form-alert" role="alert">{error}</div>}
    {!creation && <div className="prompt-suggestions"><span>Try an idea</span>{exampleIdeas.map(idea => <button key={idea.label} onClick={() => dispatch(setPrompt(idea.prompt))}>{idea.label}<ArrowRight size={12} /></button>)}</div>}
  </div>;
}
