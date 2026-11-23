import {useEffect, useMemo, useState} from 'react';
import {FolderOpen, Search, SlidersHorizontal} from 'lucide-react';
import {useDeleteProjectMutation, useGetProjectsQuery} from '../store/api.js';
import {friendlyError} from '../lib/forms.js';
import {EmptyProjects, ErrorPanel, ProjectCard} from '../components/ui.jsx';
import {ConfirmDialog} from '../components/ConfirmDialog.jsx';

export function ProjectsPage() {
  const [cursor, setCursor] = useState(undefined);
  const [loaded, setLoaded] = useState([]);
  const [search, setSearch] = useState('');
  const [phase, setPhase] = useState('ALL');
  const query = useGetProjectsQuery({cursor, limit: 20});
  const [selected, setSelected] = useState(null);
  const [deletionError, setDeletionError] = useState('');
  const [remove, deleting] = useDeleteProjectMutation();
  useEffect(() => { document.title = 'My projects · AI Video Studio'; }, []);
  useEffect(() => { if (query.currentData) setLoaded(previous => cursor ? [...new Map([...previous, ...query.currentData.projects].map(project => [project.id, project])).values()] : query.currentData.projects); }, [query.currentData, cursor]);
  async function deleteSelected() {setDeletionError(''); try {await remove(selected.id).unwrap(); setLoaded(previous => previous.filter(project => project.id !== selected.id)); setCursor(undefined); setSelected(null);} catch (error) {setDeletionError(friendlyError(error, 'This project could not be deleted. Please try again.'));}}
  const projects = useMemo(() => loaded.filter(project => project.title.toLocaleLowerCase().includes(search.toLocaleLowerCase()) && (phase === 'ALL' || project.phase === phase)), [loaded, search, phase]);
  return <>
    <div className="page-heading"><p className="eyebrow">YOUR WORK, IN ONE PLACE</p><h1>My projects<span className="heading-count">{loaded.length}</span></h1><p>A home for the ideas you are bringing to life.</p></div>
    <div className="project-toolbar"><label className="search-input"><Search size={17} /><span className="sr-only">Search loaded projects by title</span><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search loaded projects…" /></label><label className="filter-select"><SlidersHorizontal size={15} /><span className="sr-only">Filter by project status</span><select value={phase} onChange={event => setPhase(event.target.value)}><option value="ALL">All statuses</option><option value="DRAFT">Draft</option><option value="REVIEW">Ready for review</option><option value="RENDERING">Rendering</option><option value="HAS_OUTPUT">Has output</option></select></label></div>
    {query.error && <ErrorPanel message={friendlyError(query.error)} onRetry={query.refetch} />}
    {query.isLoading ? <div className="project-skeletons"><div className="skeleton" /><div className="skeleton" /></div> : !loaded.length && !query.error ? <div className="projects-empty-panel"><EmptyProjects /><div className="empty-project-footer"><FolderOpen size={15} />Projects are private to your account.</div></div> : projects.length ? <div className="project-grid projects-page-grid">{projects.map(project => <ProjectCard key={project.id} project={project} onDelete={project => {setSelected(project); setDeletionError('');}} />)}</div> : loaded.length > 0 && <div className="no-results"><h2>No matching projects</h2><p>Try another title or clear your filters.</p><button className="button button-secondary" onClick={() => { setSearch(''); setPhase('ALL'); }}>Clear filters</button></div>}
    {query.data?.nextCursor && <div className="load-more"><button className="button button-secondary" disabled={query.isFetching} onClick={() => setCursor(query.data.nextCursor)}>{query.isFetching ? 'Loading…' : 'Load more projects'}</button></div>}
    {selected && <ConfirmDialog title={`Delete “${selected.title}”?`} confirmLabel="Delete project" busy={deleting.isLoading} onConfirm={deleteSelected} onDismiss={() => setSelected(null)}><p>This removes the project from your workspace and revokes access to its outputs. Finish or cancel any active generation before deleting. This cannot be undone.</p>{deletionError && <p className="inline-error" role="alert">{deletionError}</p>}</ConfirmDialog>}
  </>;
}
