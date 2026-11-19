/// <reference types="@cloudflare/workers-types" />

import { Hono } from 'hono';
import { Env } from '../types/env';

export const goalsRoutes = new Hono<{ Bindings: Env }>();

// Helper to get date ranges for different goal types
function getDateRange(goalType: string, date: string): { start: string; end: string } {
  const d = new Date(date + 'T12:00:00Z');
  
  switch (goalType) {
    case 'daily':
      return { start: date, end: date };
    case 'weekly': {
      // Get Monday of the week
      const day = d.getDay();
      const diff = d.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(d);
      monday.setDate(diff);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      return {
        start: monday.toISOString().split('T')[0],
        end: sunday.toISOString().split('T')[0]
      };
    }
    case 'monthly': {
      const firstDay = new Date(d.getFullYear(), d.getMonth(), 1);
      const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      return {
        start: firstDay.toISOString().split('T')[0],
        end: lastDay.toISOString().split('T')[0]
      };
    }
    case 'yearly': {
      return {
        start: `${d.getFullYear()}-01-01`,
        end: `${d.getFullYear()}-12-31`
      };
    }
    default:
      return { start: date, end: date };
  }
}

// Smart goal creation with AI
goalsRoutes.post('/smart', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const { input, goal_type = 'daily' } = await c.req.json();

  if (!input || !input.trim()) {
    return c.json({ error: 'Goal input is required' }, 400);
  }

  // Use AI to process the goal
  const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/compat/chat/completions';
  const cfToken = c.env.CF_API_TOKEN;

  let title = input.trim();
  let summary = '';
  let tips: string[] = [];
  let category = 'personal';

  if (cfToken) {
    try {
      const prompt = `You are a goal-setting coach. The user wants to set a ${goal_type} goal:

"${input}"

Analyze this goal and respond with ONLY valid JSON (no other text):
{
  "title": "clean, concise version of the goal (max 50 chars)",
  "summary": "one sentence explaining why this goal matters or what it will help achieve",
  "tips": ["actionable tip 1", "actionable tip 2", "actionable tip 3"],
  "category": "one of: fitness, nutrition, habits, personal, work, other"
}

Make tips specific and actionable for a ${goal_type} timeframe.`;

      const response = await fetch(AI_GATEWAY_URL, {
        method: 'POST',
        headers: {
          'cf-aig-authorization': `Bearer ${cfToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'openai/gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          max_tokens: 400,
          temperature: 0.7
        }),
      });

      if (response.ok) {
        const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
        const content = data.choices?.[0]?.message?.content;
        
        if (content) {
          const jsonMatch = content.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            title = parsed.title || title;
            summary = parsed.summary || '';
            tips = parsed.tips || [];
            category = parsed.category || 'personal';
          }
        }
      }
    } catch (error) {
      console.error('AI processing failed:', error);
      // Continue with original input as fallback
    }
  }

  // Determine target_date based on goal_type
  const today = new Date();
  let targetDate: string;
  
  switch (goal_type) {
    case 'daily':
      targetDate = today.toISOString().split('T')[0];
      break;
    case 'weekly': {
      const day = today.getDay();
      const diff = today.getDate() - day + (day === 0 ? -6 : 1);
      const monday = new Date(today);
      monday.setDate(diff);
      targetDate = monday.toISOString().split('T')[0];
      break;
    }
    case 'monthly':
      targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
      break;
    case 'yearly':
      targetDate = `${today.getFullYear()}-01-01`;
      break;
    default:
      targetDate = today.toISOString().split('T')[0];
  }

  // Create the goal
  const goalId = crypto.randomUUID();
  
  await c.env.DB.prepare(`
    INSERT INTO goals (id, user_id, title, description, goal_type, category, target_date, priority, ai_summary, ai_tips)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'medium', ?, ?)
  `).bind(
    goalId,
    userId,
    title,
    summary,
    goal_type,
    category,
    targetDate,
    summary,
    JSON.stringify(tips)
  ).run();

  // Track analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'goal_created_smart', goal_type],
    doubles: [1],
    indexes: [userId]
  });

  return c.json({
    id: goalId,
    title,
    summary,
    tips,
    category,
    goal_type,
    success: true
  });
});

// Get goals by type and date
goalsRoutes.get('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalType = c.req.query('type'); // daily, weekly, monthly, yearly
  const date = c.req.query('date') || new Date().toISOString().split('T')[0];
  const status = c.req.query('status'); // pending, completed, all

  let query = 'SELECT * FROM goals WHERE user_id = ?';
  const bindings: (string | number)[] = [userId];

  if (goalType) {
    query += ' AND goal_type = ?';
    bindings.push(goalType);
    
    // For specific date ranges
    const range = getDateRange(goalType, date);
    query += ' AND target_date >= ? AND target_date <= ?';
    bindings.push(range.start, range.end);
  }

  if (status && status !== 'all') {
    query += ' AND status = ?';
    bindings.push(status);
  }

  query += ' ORDER BY priority DESC, created_at ASC';

  const goals = await c.env.DB.prepare(query).bind(...bindings).all();

  return c.json(goals.results || []);
});

// Get today's daily goals (with rollover from yesterday)
goalsRoutes.get('/today', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];
  const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];

  // Get today's goals
  const todayGoals = await c.env.DB.prepare(`
    SELECT * FROM goals 
    WHERE user_id = ? AND goal_type = 'daily' AND target_date = ?
    ORDER BY priority DESC, created_at ASC
  `).bind(userId, today).all();

  // Check for uncompleted goals from yesterday that need rollover
  const yesterdayUncompleted = await c.env.DB.prepare(`
    SELECT * FROM goals 
    WHERE user_id = ? AND goal_type = 'daily' AND target_date = ? AND status = 'pending'
  `).bind(userId, yesterday).all();

  // Auto-rollover uncompleted daily goals
  const rolledOver: string[] = [];
  for (const goal of (yesterdayUncompleted.results || [])) {
    // Check if already rolled over
    const existing = await c.env.DB.prepare(`
      SELECT id FROM goals WHERE rolled_from_id = ?
    `).bind(goal.id).first();

    if (!existing) {
      const newId = crypto.randomUUID();
      await c.env.DB.prepare(`
        INSERT INTO goals (id, user_id, title, description, goal_type, category, target_value, target_unit, current_value, target_date, status, priority, is_recurring, recurrence_pattern, rolled_from_id)
        VALUES (?, ?, ?, ?, 'daily', ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)
      `).bind(
        newId,
        userId,
        goal.title,
        goal.description,
        goal.category,
        goal.target_value,
        goal.target_unit,
        goal.current_value || 0,
        today,
        goal.priority,
        goal.is_recurring,
        goal.recurrence_pattern,
        goal.id
      ).run();

      // Mark original as rolled over
      await c.env.DB.prepare(`
        UPDATE goals SET status = 'rolled_over', updated_at = datetime('now') WHERE id = ?
      `).bind(goal.id).run();

      rolledOver.push(goal.title as string);
    }
  }

  // Re-fetch today's goals after rollover
  const updatedGoals = await c.env.DB.prepare(`
    SELECT * FROM goals 
    WHERE user_id = ? AND goal_type = 'daily' AND target_date = ?
    ORDER BY status ASC, priority DESC, created_at ASC
  `).bind(userId, today).all();

  return c.json({
    date: today,
    goals: updatedGoals.results || [],
    rolled_over: rolledOver,
    completed_count: (updatedGoals.results || []).filter((g: Record<string, unknown>) => g.status === 'completed').length,
    total_count: (updatedGoals.results || []).length
  });
});

// Get goal summary (counts by type and status)
goalsRoutes.get('/summary', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const today = new Date().toISOString().split('T')[0];
  const weekRange = getDateRange('weekly', today);
  const monthRange = getDateRange('monthly', today);
  const yearRange = getDateRange('yearly', today);

  const [daily, weekly, monthly, yearly] = await Promise.all([
    c.env.DB.prepare(`
      SELECT status, COUNT(*) as count FROM goals 
      WHERE user_id = ? AND goal_type = 'daily' AND target_date = ?
      GROUP BY status
    `).bind(userId, today).all(),
    
    c.env.DB.prepare(`
      SELECT status, COUNT(*) as count FROM goals 
      WHERE user_id = ? AND goal_type = 'weekly' AND target_date >= ? AND target_date <= ?
      GROUP BY status
    `).bind(userId, weekRange.start, weekRange.end).all(),
    
    c.env.DB.prepare(`
      SELECT status, COUNT(*) as count FROM goals 
      WHERE user_id = ? AND goal_type = 'monthly' AND target_date >= ? AND target_date <= ?
      GROUP BY status
    `).bind(userId, monthRange.start, monthRange.end).all(),
    
    c.env.DB.prepare(`
      SELECT status, COUNT(*) as count FROM goals 
      WHERE user_id = ? AND goal_type = 'yearly' AND target_date >= ? AND target_date <= ?
      GROUP BY status
    `).bind(userId, yearRange.start, yearRange.end).all()
  ]);

  const summarize = (results: Record<string, unknown>[] | null) => {
    const summary = { pending: 0, completed: 0, total: 0 };
    for (const row of (results || [])) {
      const count = row.count as number;
      summary.total += count;
      if (row.status === 'pending') summary.pending = count;
      if (row.status === 'completed') summary.completed = count;
    }
    return summary;
  };

  return c.json({
    daily: summarize(daily.results),
    weekly: summarize(weekly.results),
    monthly: summarize(monthly.results),
    yearly: summarize(yearly.results)
  });
});

// Create a new goal
goalsRoutes.post('/', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const data = await c.req.json();
  const goalId = crypto.randomUUID();
  
  // Determine target_date based on goal_type if not provided
  let targetDate = data.target_date;
  if (!targetDate) {
    const today = new Date();
    switch (data.goal_type) {
      case 'daily':
        targetDate = today.toISOString().split('T')[0];
        break;
      case 'weekly': {
        const day = today.getDay();
        const diff = today.getDate() - day + (day === 0 ? -6 : 1);
        today.setDate(diff);
        targetDate = today.toISOString().split('T')[0];
        break;
      }
      case 'monthly':
        targetDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-01`;
        break;
      case 'yearly':
        targetDate = `${today.getFullYear()}-01-01`;
        break;
    }
  }

  await c.env.DB.prepare(`
    INSERT INTO goals (id, user_id, title, description, goal_type, category, target_value, target_unit, target_date, priority, is_recurring, recurrence_pattern)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    goalId,
    userId,
    data.title,
    data.description || null,
    data.goal_type || 'daily',
    data.category || 'personal',
    data.target_value || null,
    data.target_unit || null,
    targetDate,
    data.priority || 'medium',
    data.is_recurring ? 1 : 0,
    data.recurrence_pattern ? JSON.stringify(data.recurrence_pattern) : null
  ).run();

  // Track analytics
  c.env.ANALYTICS.writeDataPoint({
    blobs: [userId, 'goal_created', data.goal_type],
    doubles: [1],
    indexes: [userId]
  });

  return c.json({ id: goalId, success: true });
});

// Toggle goal completion (checkbox style)
goalsRoutes.post('/:id/toggle', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');

  // Get current status
  const goal = await c.env.DB.prepare(
    'SELECT status FROM goals WHERE id = ? AND user_id = ?'
  ).bind(goalId, userId).first();

  if (!goal) {
    return c.json({ error: 'Goal not found' }, 404);
  }

  const newStatus = goal.status === 'completed' ? 'pending' : 'completed';
  const completedAt = newStatus === 'completed' ? new Date().toISOString() : null;

  await c.env.DB.prepare(`
    UPDATE goals SET status = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(newStatus, completedAt, goalId).run();

  // Track analytics
  if (newStatus === 'completed') {
    c.env.ANALYTICS.writeDataPoint({
      blobs: [userId, 'goal_completed', 'toggle'],
      doubles: [1],
      indexes: [userId]
    });
  }

  return c.json({ id: goalId, status: newStatus, completed_at: completedAt });
});

// Update goal progress (for measurable goals)
goalsRoutes.put('/:id/progress', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');
  const { current_value } = await c.req.json();

  // Get goal to check if target is met
  const goal = await c.env.DB.prepare(
    'SELECT target_value FROM goals WHERE id = ? AND user_id = ?'
  ).bind(goalId, userId).first();

  if (!goal) {
    return c.json({ error: 'Goal not found' }, 404);
  }

  // Auto-complete if target is reached
  const targetMet = goal.target_value && current_value >= (goal.target_value as number);
  const newStatus = targetMet ? 'completed' : 'pending';
  const completedAt = targetMet ? new Date().toISOString() : null;

  await c.env.DB.prepare(`
    UPDATE goals SET current_value = ?, status = ?, completed_at = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(current_value, newStatus, completedAt, goalId).run();

  return c.json({ 
    id: goalId, 
    current_value, 
    status: newStatus, 
    target_met: targetMet 
  });
});

// Update a goal
goalsRoutes.put('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');
  const updates = await c.req.json();

  await c.env.DB.prepare(`
    UPDATE goals SET
      title = COALESCE(?, title),
      description = COALESCE(?, description),
      category = COALESCE(?, category),
      target_value = COALESCE(?, target_value),
      target_unit = COALESCE(?, target_unit),
      priority = COALESCE(?, priority),
      updated_at = datetime('now')
    WHERE id = ? AND user_id = ?
  `).bind(
    updates.title || null,
    updates.description || null,
    updates.category || null,
    updates.target_value || null,
    updates.target_unit || null,
    updates.priority || null,
    goalId,
    userId
  ).run();

  return c.json({ success: true });
});

// Delete a goal
goalsRoutes.delete('/:id', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');

  await c.env.DB.prepare(
    'DELETE FROM goals WHERE id = ? AND user_id = ?'
  ).bind(goalId, userId).run();

  return c.json({ success: true });
});

// AI-powered goal breakdown (break monthly/yearly goals into weekly chunks)
goalsRoutes.post('/:id/breakdown', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');

  // Get the goal
  const goal = await c.env.DB.prepare(
    'SELECT * FROM goals WHERE id = ? AND user_id = ?'
  ).bind(goalId, userId).first();

  if (!goal) {
    return c.json({ error: 'Goal not found' }, 404);
  }

  if (goal.goal_type !== 'monthly' && goal.goal_type !== 'yearly') {
    return c.json({ error: 'Breakdown only available for monthly or yearly goals' }, 400);
  }

  // Calculate breakdown
  const targetDate = goal.target_date as string;
  const targetValue = goal.target_value as number | null;
  const goalType = goal.goal_type as string;
  
  let breakdown: { week: number; target: string; start_date: string; end_date: string }[] = [];
  
  if (goalType === 'monthly') {
    // Break into 4 weeks
    const monthStart = new Date(targetDate + 'T12:00:00Z');
    const monthEnd = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0);
    const totalDays = monthEnd.getDate();
    const weeksInMonth = Math.ceil(totalDays / 7);
    
    for (let i = 0; i < weeksInMonth; i++) {
      const weekStart = new Date(monthStart);
      weekStart.setDate(weekStart.getDate() + (i * 7));
      const weekEnd = new Date(weekStart);
      weekEnd.setDate(Math.min(weekStart.getDate() + 6, monthEnd.getDate()));
      
      if (weekStart <= monthEnd) {
        breakdown.push({
          week: i + 1,
          target: targetValue ? `${Math.round(targetValue / weeksInMonth)} ${goal.target_unit || ''}`.trim() : `Week ${i + 1} milestone`,
          start_date: weekStart.toISOString().split('T')[0],
          end_date: weekEnd.toISOString().split('T')[0]
        });
      }
    }
  } else if (goalType === 'yearly') {
    // Break into 12 months
    const year = parseInt(targetDate.split('-')[0]);
    for (let i = 0; i < 12; i++) {
      const monthStart = new Date(year, i, 1);
      const monthEnd = new Date(year, i + 1, 0);
      breakdown.push({
        week: i + 1, // actually month
        target: targetValue ? `${Math.round(targetValue / 12)} ${goal.target_unit || ''}`.trim() : `Month ${i + 1} milestone`,
        start_date: monthStart.toISOString().split('T')[0],
        end_date: monthEnd.toISOString().split('T')[0]
      });
    }
  }

  // Store breakdown
  await c.env.DB.prepare(`
    UPDATE goals SET breakdown = ?, updated_at = datetime('now') WHERE id = ?
  `).bind(JSON.stringify(breakdown), goalId).run();

  return c.json({ 
    goal_id: goalId,
    breakdown,
    suggestion: `To achieve "${goal.title}", aim for these ${goalType === 'monthly' ? 'weekly' : 'monthly'} milestones.`
  });
});

// Create sub-goals from breakdown
goalsRoutes.post('/:id/create-subgoals', async (c) => {
  const userId = c.req.header('X-User-Id');
  if (!userId) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const goalId = c.req.param('id');

  // Get the goal with breakdown
  const goal = await c.env.DB.prepare(
    'SELECT * FROM goals WHERE id = ? AND user_id = ?'
  ).bind(goalId, userId).first();

  if (!goal || !goal.breakdown) {
    return c.json({ error: 'Goal not found or no breakdown available' }, 404);
  }

  const breakdown = JSON.parse(goal.breakdown as string) as Array<{
    week: number;
    target: string;
    start_date: string;
    end_date: string;
  }>;
  const parentType = goal.goal_type as string;
  const subGoalType = parentType === 'yearly' ? 'monthly' : 'weekly';

  const createdIds: string[] = [];

  for (const item of breakdown) {
    const subGoalId = crypto.randomUUID();
    await c.env.DB.prepare(`
      INSERT INTO goals (id, user_id, title, description, goal_type, category, target_date, priority)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      subGoalId,
      userId,
      `${goal.title} - ${subGoalType === 'weekly' ? 'Week' : 'Month'} ${item.week}`,
      `Target: ${item.target}`,
      subGoalType,
      goal.category,
      item.start_date,
      goal.priority
    ).run();
    createdIds.push(subGoalId);
  }

  return c.json({ 
    success: true, 
    created: createdIds.length,
    sub_goal_type: subGoalType
  });
});
