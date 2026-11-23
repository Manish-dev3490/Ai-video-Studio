import {configureStore, createSlice} from '@reduxjs/toolkit';
import {setupListeners} from '@reduxjs/toolkit/query';
import {studioApi} from './api.js';

const initialDraft = {prompt: '', durationSec: 30};
const draft = createSlice({name: 'draft', initialState: initialDraft, reducers: {
  setPrompt: (state, action) => { state.prompt = action.payload; },
  setDuration: (state, action) => { if ([30, 60, 90].includes(action.payload)) state.durationSec = action.payload; },
  resetDraft: () => ({...initialDraft}),
}});
export const {setPrompt, setDuration, resetDraft} = draft.actions;
export const store = configureStore({
  reducer: {[studioApi.reducerPath]: studioApi.reducer, draft: draft.reducer},
  middleware: getDefault => getDefault().concat(studioApi.middleware),
  // Auth mutation arguments contain passwords; never expose them in DevTools.
  devTools: false,
});
setupListeners(store.dispatch);
