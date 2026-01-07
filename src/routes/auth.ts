/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';

export const authRoutes = new Hono<{ Bindings: Env }>();

// Simple password hashing (in production, use bcrypt or argon2)
async function hashPassword(password: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Generate JWT-like token (simplified)
async function generateToken(userId: string, secret: string): Promise<string> {
  const header = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = btoa(JSON.stringify({ 
    sub: userId, 
    iat: Date.now(),
    exp: Date.now() + 7 * 24 * 60 * 60 * 1000 // 7 days
  }));
  
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(`${header}.${payload}`)
  );
  
  const sig = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${header}.${payload}.${sig}`;
}

// Register new user
authRoutes.post('/register', async (c) => {
  const { email, password, name } = await c.req.json();
  
  if (!email || !password || !name) {
    return c.json({ error: 'Email, password, and name are required' }, 400);
  }

  // Check if user exists
  const existing = await c.env.DB.prepare(
    'SELECT id FROM users WHERE email = ?'
  ).bind(email).first();
  
  if (existing) {
    return c.json({ error: 'Email already registered' }, 400);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  
  // Create user with default goals
  await c.env.DB.prepare(`
    INSERT INTO users (id, email, password_hash, name, goals)
    VALUES (?, ?, ?, ?, ?)
  `).bind(
    userId,
    email,
    passwordHash,
    name,
    JSON.stringify({
      daily_calories: 2000,
      daily_protein: 150,
      daily_carbs: 200,
      daily_fat: 65,
      workout_days_per_week: 4
    })
  ).run();

  // Initialize streaks for the user
  const streakTypes = ['no_drinks', 'no_weed', 'workout', 'calorie_goal', 'protein_goal', 'water_goal', 'barrys'];
  for (const type of streakTypes) {
    await c.env.DB.prepare(`
      INSERT INTO streaks (id, user_id, streak_type, current_count, best_count)
      VALUES (?, ?, ?, 0, 0)
    `).bind(crypto.randomUUID(), userId, type).run();
  }

  const token = await generateToken(userId, c.env.JWT_SECRET);
  
  // Store session in KV
  await c.env.SESSIONS.put(`session:${userId}`, JSON.stringify({
    userId,
    email,
    createdAt: new Date().toISOString()
  }), { expirationTtl: 7 * 24 * 60 * 60 });

  // Track signup analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'signup', 'email'],
    doubles: [1],
    indexes: [userId]
  });

  return c.json({ 
    token, 
    user: { id: userId, email, name } 
  });
});

// Login
authRoutes.post('/login', async (c) => {
  const { email, password } = await c.req.json();
  
  if (!email || !password) {
    return c.json({ error: 'Email and password are required' }, 400);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, password_hash, goals FROM users WHERE email = ?'
  ).bind(email).first();
  
  if (!user) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const passwordHash = await hashPassword(password);
  if (passwordHash !== user.password_hash) {
    return c.json({ error: 'Invalid credentials' }, 401);
  }

  const token = await generateToken(user.id as string, c.env.JWT_SECRET);
  
  // Store session in KV
  await c.env.SESSIONS.put(`session:${user.id}`, JSON.stringify({
    userId: user.id,
    email: user.email,
    createdAt: new Date().toISOString()
  }), { expirationTtl: 7 * 24 * 60 * 60 });

  // Track login analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [user.id as string, 'login', 'email'],
    doubles: [1],
    indexes: [user.id as string]
  });

  return c.json({ 
    token, 
    user: { 
      id: user.id, 
      email: user.email, 
      name: user.name,
      goals: JSON.parse(user.goals as string)
    } 
  });
});

// Get current user
authRoutes.get('/me', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const user = await c.env.DB.prepare(
    'SELECT id, email, name, avatar_url, whoop_connected, wyze_connected, goals, created_at FROM users WHERE id = ?'
  ).bind(userId).first();
  
  if (!user) {
    return c.json({ error: 'User not found' }, 404);
  }

  return c.json({
    id: user.id,
    email: user.email,
    name: user.name,
    avatar_url: user.avatar_url,
    whoop_connected: user.whoop_connected === 1,
    wyze_connected: user.wyze_connected === 1,
    goals: JSON.parse(user.goals as string),
    created_at: user.created_at
  });
});

// Update user profile/goals
authRoutes.put('/me', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const updates = await c.req.json();
  
  // Build update query dynamically
  const allowedFields = ['name', 'avatar_url', 'timezone'];
  const setClauses: string[] = [];
  const values: (string | number)[] = [];

  for (const field of allowedFields) {
    if (updates[field] !== undefined) {
      setClauses.push(`${field} = ?`);
      values.push(updates[field]);
    }
  }

  // Handle goals separately (stored as JSON)
  if (updates.goals) {
    setClauses.push('goals = ?');
    values.push(JSON.stringify(updates.goals));
  }

  if (setClauses.length === 0) {
    return c.json({ error: 'No valid fields to update' }, 400);
  }

  setClauses.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(userId);

  await c.env.DB.prepare(`
    UPDATE users SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...values).run();

  return c.json({ success: true });
});

// Logout
authRoutes.post('/logout', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (userId) {
    await c.env.SESSIONS.delete(`session:${userId}`);
  }
  return c.json({ success: true });
});
