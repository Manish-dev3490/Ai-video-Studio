import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {Router} from 'express';
import mongoose from 'mongoose';
import {ApiError, sendData} from './http.js';

const missing = () => new ApiError(404, 'ASSET_UNAVAILABLE', 'This media is no longer available.');
const inside = (root, target) => {const relative = path.relative(root, target); return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));};
const objectId = value => {if (typeof value !== 'string' || !/^[a-f0-9]{24}$/u.test(value)) throw missing(); return new mongoose.Types.ObjectId(value);};

export async function privateAssetPath(storageRoot, key) {
  if (typeof key !== 'string' || key.length > 512 || !/^exports\/[a-f0-9]{24}\/[a-f0-9]{24}\.(mp4|vtt)$/u.test(key)) throw missing();
  const base = await fsp.realpath(storageRoot);
  const candidate = path.resolve(base, ...key.split('/'));
  if (!inside(base, candidate)) throw missing();
  const info = await fsp.lstat(candidate);
  if (!info.isFile() || info.isSymbolicLink()) throw missing();
  const resolved = await fsp.realpath(candidate);
  if (!inside(base, resolved)) throw missing();
  return {file: resolved, size: info.size};
}

export function parseRange(value, size) {
  if (!value) return null;
  if (typeof value !== 'string' || value.length > 100 || !/^bytes=(\d*)-(\d*)$/u.test(value)) throw new ApiError(416, 'RANGE_NOT_SATISFIABLE', 'Choose one valid byte range.');
  const [, startText, endText] = value.match(/^bytes=(\d*)-(\d*)$/u);
  let start, end;
  if (!startText) {const suffix = Number(endText); if (!Number.isSafeInteger(suffix) || suffix <= 0) throw new ApiError(416, 'RANGE_NOT_SATISFIABLE', 'Choose one valid byte range.'); start = Math.max(0, size - suffix); end = size - 1;}
  else {start = Number(startText); end = endText ? Math.min(size - 1, Number(endText)) : size - 1;}
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= size || end < start) throw new ApiError(416, 'RANGE_NOT_SATISFIABLE', 'Choose one valid byte range.');
  return {start, end};
}

export function publicAsset(asset, availability) {
  const metadata = asset.metadata || {};
  return {id: String(asset._id), ownerId: String(asset.ownerId), projectId: String(asset.projectId), generationId: String(asset.generationId), kind: asset.kind, mimeType: asset.mimeType, sizeBytes: asset.byteSize, status: asset.status, aiGenerated: true, ...(asset.kind === 'VIDEO_EXPORT' ? {durationSec: metadata.durationSec, width: metadata.width, height: metadata.height} : {}), createdAt: asset.createdAt.toISOString(), updatedAt: asset.updatedAt.toISOString(), expiresAt: asset.expiresAt.toISOString(), availability};
}

export function validExportPair(job, pair) {
  if (!job?.outputAssetId || !job?.captionAssetId || pair.length !== 2 || String(job.outputAssetId) === String(job.captionAssetId)) return false;
  return [['VIDEO_EXPORT', 'video/mp4', job.outputAssetId, 'mp4'], ['CAPTION_TRACK', 'text/vtt', job.captionAssetId, 'vtt']].every(([kind, mime, id, extension]) => {
    const entry = pair.find(asset => String(asset._id) === String(id));
    return entry?.kind === kind && entry.mimeType === mime && entry.byteSize > 0 && String(entry.generationId) === String(job._id) && String(entry.projectId) === String(job.projectId) && String(entry.ownerId) === String(job.ownerId) && entry.storage?.provider === 'LOCAL' && entry.storage.key === `exports/${job._id}/${id}.${extension}`;
  });
}

export function buildMediaRouter({models, config, now = () => new Date()}) {
  const router = Router();
  const {MediaAsset, Project, GenerationJob} = models;
  async function lookup(req) {
    const ownerId = objectId(req.auth.userId);
    const asset = await MediaAsset.findOne({_id: objectId(req.params.assetId), ownerId}).lean();
    if (!asset || !await Project.exists({_id: asset.projectId, ownerId, deletedAt: null, safetyHoldAt: null})) throw missing();
    let availability = asset.deletedAt || ['DELETING', 'DELETED'].includes(asset.status) ? 'DELETED' : new Date(asset.expiresAt) <= now() ? 'EXPIRED' : 'UNAVAILABLE';
    let location;
    if (availability === 'UNAVAILABLE' && asset.status === 'READY') {
      const job = await GenerationJob.findOne({_id: asset.generationId, projectId: asset.projectId, ownerId, status: 'COMPLETED', deletedAt: null}).lean();
      if (job?.outputAssetId && job?.captionAssetId && [String(job.outputAssetId), String(job.captionAssetId)].includes(String(asset._id))) {
        const pair = await MediaAsset.find({_id: {$in: [job.outputAssetId, job.captionAssetId]}, ownerId, projectId: asset.projectId, generationId: asset.generationId, status: 'READY', deletedAt: null, expiresAt: {$gt: now()}}).lean();
        if (validExportPair(job, pair) && pair.every(entry => new Date(entry.expiresAt).getTime() === new Date(asset.expiresAt).getTime())) {
          try {
            const files = await Promise.all(pair.map(entry => privateAssetPath(config.storageRoot, entry.storage?.key)));
            if (files.every((file, index) => file.size === pair[index].byteSize)) {availability = 'AVAILABLE'; location = files[pair.findIndex(entry => String(entry._id) === String(asset._id))];}
          } catch { /* Metadata remains truthful if either blob has disappeared. */ }
        }
      }
    }
    return {asset, availability, location};
  }
  router.get('/assets/:assetId', async (req, res) => {
    const {asset, availability} = await lookup(req);
    return sendData(req, res, publicAsset(asset, availability));
  });
  router.get('/assets/:assetId/download', async (req, res, next) => {
    const {asset, availability, location} = await lookup(req);
    if (availability !== 'AVAILABLE' || !location) throw missing();
    let range;
    try {range = parseRange(req.get('Range'), location.size);}
    catch (error) {res.set('Content-Range', `bytes */${location.size}`); throw error;}
    res.set({'Content-Type': asset.mimeType === 'text/vtt' ? 'text/vtt; charset=utf-8' : asset.mimeType, 'Accept-Ranges': 'bytes', 'Content-Disposition': `inline; filename="video-${asset.generationId}.${asset.kind === 'VIDEO_EXPORT' ? 'mp4' : 'vtt'}"`, 'X-Content-Type-Options': 'nosniff'});
    if (range) res.status(206).set({'Content-Range': `bytes ${range.start}-${range.end}/${location.size}`, 'Content-Length': String(range.end - range.start + 1)});
    else res.set('Content-Length', String(location.size));
    const stream = fs.createReadStream(location.file, range || {});
    stream.once('error', () => {if (!res.headersSent) next(missing()); else res.destroy();});
    res.once('close', () => stream.destroy());
    const completeResponse = !range || (range.start === 0 && range.end === location.size - 1);
    if (completeResponse && req.method === 'GET') res.once('finish', async () => {
      try {
        await MediaAsset.updateOne({_id: asset._id, deletedAt: null}, {$set: {'metadata.deliveredAt': now()}});
        const pair = await MediaAsset.find({generationId: asset.generationId, status: 'READY', deletedAt: null}).lean();
        if (pair.length === 2 && pair.every(entry => entry.metadata?.deliveredAt)) await GenerationJob.updateOne({_id: asset.generationId, status: 'COMPLETED'}, {$set: {'manifest.deliveryVerifiedAt': now()}});
      } catch { /* A verification receipt can be retried on a later full read. */ }
    });
    stream.pipe(res);
  });
  return router;
}

/** Deletes only recorded private export files; metadata is retained for history. */
export async function cleanupExpiredMedia({models, config, now = new Date()}) {
  const {MediaAsset, Project} = models;
  const deletedProjectIds = await Project.find({deletedAt: {$ne: null}}).distinct('_id');
  const candidates = await MediaAsset.find({status: {$in: ['READY', 'DELETING']}, $or: [{expiresAt: {$lte: now}}, {projectId: {$in: deletedProjectIds}}, {deletedAt: {$ne: null}}]}).limit(100).lean();
  for (const asset of candidates) {
    await MediaAsset.updateOne({_id: asset._id}, {$set: {status: 'DELETING', deletedAt: asset.deletedAt || now}});
    try {const location = await privateAssetPath(config.storageRoot, asset.storage?.key); await fsp.unlink(location.file);}
    catch (error) {if (!['ENOENT'].includes(error.code) && !(error instanceof ApiError)) continue;}
    await MediaAsset.updateOne({_id: asset._id, status: 'DELETING'}, {$set: {status: 'DELETED'}});
  }
  return candidates.length;
}
