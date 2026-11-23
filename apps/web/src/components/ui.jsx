import {ArrowRight, Film, RefreshCw, Trash2} from 'lucide-react';
import {Link} from 'react-router-dom';
import {projectRoute} from '../lib/storyboard.js';
import {assistantRoute} from '../lib/assistant.js';

export function Brand({compact = false}) {
  return <span className="brand"><span className="brand-mark"><Film size={21} strokeWidth={1.6} /></span>{!compact && <span>AI Video <b>Studio</b><small>IDEAS, IN MOTION.</small></span>}</span>;
}

export function LoadingScreen({message = 'Opening your studio…'}) {
  return <main className="state-screen"><Brand /><span className="loading-line" aria-hidden="true" /><p role="status">{message}</p></main>;
}

export function ErrorPanel({message, onRetry, title = 'Could not load this section'}) {
  return <div className="error-panel" role="alert"><strong>{title}</strong><p>{message}</p>{onRetry && <button className="button button-secondary button-small" onClick={onRetry}><RefreshCw size={14} />Try again</button>}</div>;
}

export function EmptyProjects({compact = false}) {
  return <div className={`empty-projects ${compact ? 'is-compact' : ''}`}>
    <div className="empty-art" aria-hidden="true"><span /><span /><span><Film size={24} strokeWidth={1.2} /></span></div>
    <h3>Your first story starts here.</h3>
    <p>Your saved projects will live here. Start by shaping an idea in your workspace.</p>
    <Link className="text-link" to="/app/create">Explore the workspace <ArrowRight size={15} /></Link>
  </div>;
}

const phaseLabels = {DRAFT: 'Draft', REVIEW: 'Ready for review', RENDERING: 'Rendering', HAS_OUTPUT: 'Has output'};
export function ProjectCard({project, onDelete}) {
  return <article className="project-card">
    <div className="project-thumbnail"><Film size={30} strokeWidth={1.1} /><span>{project.settings?.durationSec || '—'} SEC</span></div>
    <div className="project-card-copy"><span className="status-badge">{phaseLabels[project.phase] || project.phase}</span><h3>{project.title}</h3><p>{project.settings?.mode === 'FACELESS' ? 'Faceless explainer' : 'Character video'}<span>·</span>{new Date(project.updatedAt).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})}</p><div className="project-card-actions"><Link className="text-link" to={projectRoute(project)}>{project.phase === 'RENDERING' ? 'Open progress' : project.phase === 'HAS_OUTPUT' ? 'Preview video' : 'Review project'}<ArrowRight size={14} /></Link>{onDelete && <button className="icon-button" aria-label={`Delete ${project.title}`} onClick={() => onDelete(project)}><Trash2 size={16} /></button>}</div><Link className="saved-output-link" aria-label={`Chat about ${project.title}`} to={assistantRoute(project.id)}>Chat with AI</Link>{project.latestOutputAssetId && project.phase !== 'HAS_OUTPUT' && <Link className="saved-output-link" to={`/app/projects/${encodeURIComponent(project.id)}/preview`}>View saved output</Link>}</div>
  </article>;
}

export function SectionHeading({eyebrow, title, children}) {
  return <div className="section-heading"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h2>{title}</h2></div>{children}</div>;
}
