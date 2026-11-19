/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';
import { AIService } from '../services/ai';

export const progressRoutes = new Hono<{ Bindings: Env }>();

// Get progress photos
progressRoutes.get('/photos', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const limit = parseInt(c.req.query('limit') || '20');
  const offset = parseInt(c.req.query('offset') || '0');

  const photos = await c.env.DB.prepare(`
    SELECT id, photo_key, thumbnail_key, ai_analysis, weight, body_fat, 
           notes, tags, taken_at, created_at
    FROM progress_photos
    WHERE user_id = ?
    ORDER BY taken_at DESC
    LIMIT ? OFFSET ?
  `).bind(userId, limit, offset).all();

  return c.json(photos.results?.map(p => ({
    ...p,
    photo_url: `/api/progress/photo/${p.photo_key}`,
    thumbnail_url: p.thumbnail_key ? `/api/progress/photo/${p.thumbnail_key}` : null,
    ai_analysis: p.ai_analysis ? JSON.parse(p.ai_analysis as string) : null,
    tags: p.tags ? JSON.parse(p.tags as string) : []
  })));
});

// Upload progress photo
progressRoutes.post('/photos', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const formData = await c.req.formData();
  const photo = formData.get('photo');
  const notes = formData.get('notes') as string || null;
  const weight = formData.get('weight');
  const bodyFat = formData.get('body_fat');
  const tags = formData.get('tags') as string || '[]';
  const takenAt = formData.get('taken_at') as string || new Date().toISOString();

  if (!photo || typeof photo === 'string') {
    return c.json({ error: 'No photo provided' }, 400);
  }

  const photoFile = photo as unknown as File;
  const photoId = crypto.randomUUID();
  const photoKey = `progress/${userId}/${photoId}_${photoFile.name}`;
  const photoData = await photoFile.arrayBuffer();

  // Upload to R2
  await c.env.PHOTOS.put(photoKey, photoData, {
    httpMetadata: { contentType: photoFile.type }
  });

  // Insert record
  await c.env.DB.prepare(`
    INSERT INTO progress_photos (id, user_id, photo_key, weight, body_fat, notes, tags, taken_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    photoId,
    userId,
    photoKey,
    weight ? parseFloat(weight as string) : null,
    bodyFat ? parseFloat(bodyFat as string) : null,
    notes,
    tags,
    takenAt
  ).run();

  // Queue AI analysis (if queue is configured)
  if (c.env.PHOTO_QUEUE) {
    await c.env.PHOTO_QUEUE.send({
      user_id: userId,
      photo_key: photoKey,
      analysis_type: 'progress'
    });
  }

  // Track analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'progress_photo', 'uploaded'],
    doubles: [weight ? parseFloat(weight as string) : 0],
    indexes: [userId]
  });

  return c.json({
    id: photoId,
    photo_url: `/api/progress/photo/${photoKey}`,
    message: 'Photo uploaded, AI analysis in progress'
  });
});

// Get photo from R2
progressRoutes.get('/photo/*', async (c) => {
  const path = c.req.path.replace('/api/progress/photo/', '');
  const object = await c.env.PHOTOS.get(path);
  
  if (!object) {
    return c.json({ error: 'Photo not found' }, 404);
  }

  const headers = new Headers();
  headers.set('Content-Type', object.httpMetadata?.contentType || 'image/jpeg');
  headers.set('Cache-Control', 'public, max-age=31536000');
  
  return new Response(object.body, { headers });
});

// Delete progress photo
progressRoutes.delete('/photos/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const photoId = c.req.param('id');

  const photo = await c.env.DB.prepare(
    'SELECT photo_key, thumbnail_key FROM progress_photos WHERE id = ? AND user_id = ?'
  ).bind(photoId, userId).first();

  if (!photo) {
    return c.json({ error: 'Photo not found' }, 404);
  }

  // Delete from R2
  await c.env.PHOTOS.delete(photo.photo_key as string);
  if (photo.thumbnail_key) {
    await c.env.PHOTOS.delete(photo.thumbnail_key as string);
  }

  // Delete from DB
  await c.env.DB.prepare('DELETE FROM progress_photos WHERE id = ?').bind(photoId).run();

  return c.json({ success: true });
});

// Get weight history (from Whoop daily data + progress photos)
progressRoutes.get('/weight', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const days = parseInt(c.req.query('days') || '90');
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - days);
  const startDateStr = startDate.toISOString().split('T')[0];

  const weights = await c.env.DB.prepare(`
    SELECT weight_kg as weight, NULL as body_fat, NULL as muscle_mass, date as measured_at, 'whoop' as source
    FROM whoop_daily
    WHERE user_id = ? AND date >= ? AND weight_kg IS NOT NULL
    UNION ALL
    SELECT weight, body_fat, NULL as muscle_mass, taken_at as measured_at, 'photo' as source
    FROM progress_photos
    WHERE user_id = ? AND weight IS NOT NULL AND taken_at >= ?
    ORDER BY measured_at DESC
  `).bind(userId, startDateStr, userId, startDate.toISOString()).all();

  return c.json(weights.results);
});

// Get progress comparison (AI-powered)
progressRoutes.get('/compare', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const fromId = c.req.query('from');
  const toId = c.req.query('to');

  if (!fromId || !toId) {
    return c.json({ error: 'Both from and to photo IDs required' }, 400);
  }

  const [fromPhoto, toPhoto] = await Promise.all([
    c.env.DB.prepare(
      'SELECT * FROM progress_photos WHERE id = ? AND user_id = ?'
    ).bind(fromId, userId).first(),
    c.env.DB.prepare(
      'SELECT * FROM progress_photos WHERE id = ? AND user_id = ?'
    ).bind(toId, userId).first()
  ]);

  if (!fromPhoto || !toPhoto) {
    return c.json({ error: 'Photos not found' }, 404);
  }

  // Get AI analyses
  const fromAnalysis = fromPhoto.ai_analysis ? JSON.parse(fromPhoto.ai_analysis as string) : null;
  const toAnalysis = toPhoto.ai_analysis ? JSON.parse(toPhoto.ai_analysis as string) : null;

  // Calculate metrics changes
  const changes = {
    weight: {
      from: fromPhoto.weight,
      to: toPhoto.weight,
      change: toPhoto.weight && fromPhoto.weight 
        ? (toPhoto.weight as number) - (fromPhoto.weight as number) 
        : null
    },
    body_fat: {
      from: fromPhoto.body_fat,
      to: toPhoto.body_fat,
      change: toPhoto.body_fat && fromPhoto.body_fat 
        ? (toPhoto.body_fat as number) - (fromPhoto.body_fat as number) 
        : null
    },
    days_between: Math.floor(
      (new Date(toPhoto.taken_at as string).getTime() - new Date(fromPhoto.taken_at as string).getTime()) 
      / (1000 * 60 * 60 * 24)
    ),
    from_analysis: fromAnalysis,
    to_analysis: toAnalysis
  };

  return c.json(changes);
});

// Get progress summary
progressRoutes.get('/summary', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Get photo count and date range
  const photoStats = await c.env.DB.prepare(`
    SELECT COUNT(*) as count, MIN(taken_at) as first_photo, MAX(taken_at) as last_photo
    FROM progress_photos WHERE user_id = ?
  `).bind(userId).first();

  // Get weight stats from whoop_daily
  const weightStats = await c.env.DB.prepare(`
    SELECT 
      MIN(weight_kg) as min_weight,
      MAX(weight_kg) as max_weight,
      (SELECT weight_kg FROM whoop_daily WHERE user_id = ? AND weight_kg IS NOT NULL ORDER BY date ASC LIMIT 1) as starting_weight,
      (SELECT weight_kg FROM whoop_daily WHERE user_id = ? AND weight_kg IS NOT NULL ORDER BY date DESC LIMIT 1) as current_weight
    FROM whoop_daily WHERE user_id = ? AND weight_kg IS NOT NULL
  `).bind(userId, userId, userId).first();

  return c.json({
    photos: {
      count: photoStats?.count || 0,
      first_date: photoStats?.first_photo,
      last_date: photoStats?.last_photo
    },
    weight: {
      starting: weightStats?.starting_weight,
      current: weightStats?.current_weight,
      min: weightStats?.min_weight,
      max: weightStats?.max_weight,
      change: weightStats?.starting_weight && weightStats?.current_weight
        ? (weightStats.current_weight as number) - (weightStats.starting_weight as number)
        : null
    }
  });
});
