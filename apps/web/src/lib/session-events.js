import {studioApi} from '../store/api.js';
import {resetDraft} from '../store/index.js';
import {clearAssistantSessions} from './assistant.js';
import {clearReportSessions} from './reports.js';
import {clearDurationRequests} from './duration.js';

let channel;

export function installSessionSync(store) {
  if (typeof window === 'undefined' || !window.BroadcastChannel || channel) return;
  channel = new window.BroadcastChannel('avs-session-changes');
  channel.addEventListener('message', event => {
    if (event.data?.type === 'ASSISTANT_UPDATED' && typeof event.data.projectId === 'string' && event.data.projectId.length <= 128) {
      store.dispatch(studioApi.util.invalidateTags([{type: 'AssistantHistory', id: event.data.projectId}]));
      return;
    }
    if (event.data?.type === 'ACCOUNT_UPDATED') {
      store.dispatch(studioApi.util.invalidateTags(['AccountProfile', 'User']));
      return;
    }
    if (event.data?.type !== 'SESSION_CHANGED') return;
    // Broadcast only a cache-invalidation signal. Identity and credentials are
    // read again from owner-authenticated endpoints, never sent between tabs.
    clearAssistantSessions();
    clearReportSessions();
    clearDurationRequests();
    store.dispatch(resetDraft());
    store.dispatch(studioApi.util.resetApiState());
  });
}

export function notifySessionChanged() {
  clearAssistantSessions();
  clearReportSessions();
  clearDurationRequests();
  channel?.postMessage({type: 'SESSION_CHANGED'});
}

export function notifyAssistantUpdated(projectId) {channel?.postMessage({type: 'ASSISTANT_UPDATED', projectId});}

export function notifyAccountUpdated() {
  channel?.postMessage({type: 'ACCOUNT_UPDATED'});
}
