import {createApi, fetchBaseQuery} from '@reduxjs/toolkit/query/react';
import {createSessionTransport} from '../lib/session-transport.js';
import {mergeAssistantHistory} from '../lib/assistant.js';

const request = fetchBaseQuery({baseUrl: '/api/v1', credentials: 'include', timeout: 15000, prepareHeaders: headers => {headers.set('Accept', 'application/json'); return headers;}});
const baseQuery = createSessionTransport(request);

export const studioApi = createApi({
  reducerPath: 'studioApi',
  baseQuery,
  tagTypes: ['User', 'AccountProfile', 'Projects', 'Project', 'Storyboard', 'Generation', 'Generations', 'Asset', 'Usage', 'Capabilities', 'AssistantHistory'],
  refetchOnReconnect: true,
  refetchOnFocus: true,
  endpoints: builder => ({
    getMe: builder.query({query: () => '/auth/me', transformResponse: result => result.data.user, providesTags: ['User']}),
    login: builder.mutation({query: body => ({url: '/auth/login', method: 'POST', body}), transformResponse: result => result.data.user}),
    signup: builder.mutation({query: body => ({url: '/auth/signup', method: 'POST', body}), transformResponse: result => result.data.user}),
    logout: builder.mutation({query: () => ({url: '/auth/logout', method: 'POST', body: {}})}),
    getAccountProfile: builder.query({query: () => '/account/profile', transformResponse: result => result.data, providesTags: ['AccountProfile']}),
    updateAccountProfile: builder.mutation({query: body => ({url: '/account/profile', method: 'PATCH', body}), transformResponse: result => result.data, invalidatesTags: (result, error) => error ? [] : ['AccountProfile', 'User']}),
    getProjects: builder.query({query: ({cursor, limit = 20} = {}) => ({url: '/projects', params: {limit, ...(cursor ? {cursor} : {})}}), transformResponse: result => result.data, providesTags: ['Projects']}),
    getUsage: builder.query({query: () => '/usage', transformResponse: result => result.data, providesTags: ['Usage']}),
    getCapabilities: builder.query({query: () => '/capabilities', transformResponse: result => result.data, providesTags: ['Capabilities']}),
    getAssistantHistoryPage: builder.query({query: ({projectId, cursor, limit = 50}) => ({url: `/projects/${encodeURIComponent(projectId)}/assistant/messages`, params: {limit, ...(cursor ? {cursor} : {})}}), transformResponse: result => result.data, providesTags: (result, error, {projectId}) => [{type: 'AssistantHistory', id: projectId}]}),
    getAssistantConversation: builder.query({
      async queryFn(projectId, api, options, query) {
        let messages = [], cursor = null;
        for (let page = 0; page < 4; page++) {
          const result = await query({url: `/projects/${encodeURIComponent(projectId)}/assistant/messages`, params: {limit: 50, ...(cursor ? {cursor} : {})}});
          if (result.error) return {error: result.error};
          const saved = result.data?.data;
          if (!Array.isArray(saved?.messages) || (saved.nextCursor !== null && typeof saved.nextCursor !== 'string')) return {error: {status: 'CUSTOM_ERROR', error: 'Saved conversation could not be read.'}};
          messages = mergeAssistantHistory(messages, saved.messages);
          cursor = saved.nextCursor;
          if (!cursor) break;
        }
        return {data: {messages, nextCursor: cursor}};
      },
      providesTags: (result, error, projectId) => [{type: 'AssistantHistory', id: projectId}],
    }),
    createProject: builder.mutation({query: body => ({url: '/projects', method: 'POST', body}), transformResponse: result => result.data, invalidatesTags: ['Projects']}),
    getProject: builder.query({query: id => `/projects/${encodeURIComponent(id)}`, transformResponse: result => result.data, providesTags: (result, error, id) => [{type: 'Project', id}]}),
    updateProject: builder.mutation({query: ({id, ...body}) => ({url: `/projects/${encodeURIComponent(id)}`, method: 'PATCH', body}), transformResponse: result => result.data, invalidatesTags: (result, error, {id}) => error ? [] : ['Projects', {type: 'Project', id}, {type: 'Storyboard', id}]}),
    deleteProject: builder.mutation({query: id => ({url: `/projects/${encodeURIComponent(id)}`, method: 'DELETE', body: {}}), transformResponse: result => result.data, invalidatesTags: (result, error, id) => error ? [] : ['Projects', 'Usage', 'Capabilities', {type: 'Project', id}, {type: 'Storyboard', id}, {type: 'Generations', id}, {type: 'AssistantHistory', id}]}),
    getCurrentStoryboard: builder.query({query: id => `/projects/${encodeURIComponent(id)}/storyboards/current`, transformResponse: result => result.data, providesTags: (result, error, id) => [{type: 'Storyboard', id}]}),
    getStoryboard: builder.query({query: ({projectId, storyboardId}) => `/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}`, transformResponse: result => result.data, providesTags: (result, error, {projectId}) => [{type: 'Storyboard', id: projectId}]}),
    generateStoryboard: builder.mutation({query: id => ({url: `/projects/${encodeURIComponent(id)}/storyboards/generate`, method: 'POST', body: {}, timeout: 150000}), transformResponse: result => result.data, invalidatesTags: (result, error, id) => error ? [] : ['Projects', {type: 'Project', id}, {type: 'Storyboard', id}]}),
    editStoryboard: builder.mutation({query: ({projectId, storyboardId, ...body}) => ({url: `/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}`, method: 'PATCH', body}), transformResponse: result => result.data, invalidatesTags: (result, error, {projectId}) => error ? [] : [{type: 'Storyboard', id: projectId}, {type: 'Project', id: projectId}, 'Projects']}),
    approveStoryboard: builder.mutation({query: ({projectId, storyboardId, expectedRevision}) => ({url: `/projects/${encodeURIComponent(projectId)}/storyboards/${encodeURIComponent(storyboardId)}/approve`, method: 'POST', body: {expectedRevision}}), transformResponse: result => result.data, invalidatesTags: (result, error, {projectId}) => error ? [] : [{type: 'Storyboard', id: projectId}, {type: 'Project', id: projectId}, 'Projects']}),
    startGeneration: builder.mutation({query: ({projectId, idempotencyKey, ...body}) => ({url: `/projects/${encodeURIComponent(projectId)}/generations`, method: 'POST', headers: {'Idempotency-Key': idempotencyKey}, body}), transformResponse: result => result.data, invalidatesTags: (result, error, {projectId}) => error ? [] : ['Usage', 'Capabilities', 'Projects', {type: 'Project', id: projectId}, {type: 'Generations', id: projectId}]}),
    getGenerations: builder.query({query: ({projectId, cursor, limit = 20}) => ({url: `/projects/${encodeURIComponent(projectId)}/generations`, params: {limit, ...(cursor ? {cursor} : {})}}), transformResponse: result => result.data, providesTags: (result, error, {projectId}) => [{type: 'Generations', id: projectId}]}),
    getGeneration: builder.query({query: id => `/generations/${encodeURIComponent(id)}`, transformResponse: result => result.data, transformErrorResponse: (result, meta) => ({...result, retryAfter: Number(meta?.response?.headers.get('Retry-After')) || 3}), providesTags: (result, error, id) => [{type: 'Generation', id}]}),
    getNarrationFeedback: builder.query({query: id => `/generations/${encodeURIComponent(id)}/narration-feedback`, transformResponse: result => result.data, providesTags: (result, error, id) => [{type: 'Generation', id}]}),
    reviseDuration: builder.mutation({query: ({projectId, ...body}) => ({url: `/projects/${encodeURIComponent(projectId)}/storyboards/revise-duration`, method: 'POST', body, timeout: 150000}), transformResponse: result => result.data, invalidatesTags: (result, error, {projectId, generationId}) => error ? [] : ['Projects', {type: 'Project', id: projectId}, {type: 'Storyboard', id: projectId}, {type: 'Generation', id: generationId}]}),
    cancelGeneration: builder.mutation({query: id => ({url: `/generations/${encodeURIComponent(id)}/cancel`, method: 'POST', body: {}}), transformResponse: result => result.data, invalidatesTags: (result, error, id) => error ? [] : [{type: 'Generation', id}, 'Usage', 'Capabilities']}),
    retryGeneration: builder.mutation({query: ({generationId, idempotencyKey}) => ({url: `/generations/${encodeURIComponent(generationId)}/retry`, method: 'POST', headers: {'Idempotency-Key': idempotencyKey}, body: {}}), transformResponse: result => result.data, invalidatesTags: ['Projects', 'Usage', 'Capabilities', 'Generations']}),
    getAsset: builder.query({query: id => `/assets/${encodeURIComponent(id)}`, transformResponse: result => result.data, providesTags: (result, error, id) => [{type: 'Asset', id}]}),
  }),
});

export const {useGetMeQuery, useLoginMutation, useSignupMutation, useLogoutMutation, useGetProjectsQuery, useGetUsageQuery, useGetCapabilitiesQuery} = studioApi;
export const {useCreateProjectMutation, useGetProjectQuery, useUpdateProjectMutation, useDeleteProjectMutation, useGetCurrentStoryboardQuery, useGenerateStoryboardMutation, useEditStoryboardMutation, useApproveStoryboardMutation, useStartGenerationMutation, useGetGenerationsQuery, useGetGenerationQuery, useCancelGenerationMutation, useRetryGenerationMutation, useGetAssetQuery} = studioApi;
export const {useGetStoryboardQuery} = studioApi;
export const {useGetAccountProfileQuery, useUpdateAccountProfileMutation} = studioApi;
export const {useGetAssistantConversationQuery, useLazyGetAssistantHistoryPageQuery} = studioApi;
export const {useGetNarrationFeedbackQuery, useReviseDurationMutation} = studioApi;
