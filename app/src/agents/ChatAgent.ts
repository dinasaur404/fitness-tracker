/// <reference types="@cloudflare/workers-types" />

import { Agent, type Connection, type ConnectionContext } from 'agents';
import { Env } from '../types/env';
import { FitnessTools, toolDefinitions } from '../tools/fitness-tools';

/**
 * ChatAgent - AI-powered fitness coach chat using Cloudflare Agents SDK
 * 
 * Features:
 * - Tool calls to fetch user data (meals, workouts, recovery, habits)
 * - Persistent chat history in SQLite
 * - WebSocket for real-time chat
 * - World-class coach personality
 * - Timezone-aware date handling
 * 
 * TODO: Add Code Mode support when ctx.exports becomes available in Durable Objects
 * Code Mode would allow the LLM to generate TypeScript code that calls tools,
 * which is more effective than traditional tool calling.
 */

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: ToolCall[];
}

interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
}

interface ChatState {
  messages: ChatMessage[];
  userId: string;
  timezone: string;
  isTyping: boolean;
}

// AI Gateway URL - using the compat endpoint for better tool support
const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/openai/chat/completions';

const SYSTEM_PROMPT = `You are a world-class fitness coach and sports nutritionist named Coach. Think of yourself as a combination of a supportive friend and an elite performance coach - someone who genuinely cares but also pushes for excellence.

PERSONALITY:
- Supportive but honest - you celebrate wins but also call out when things could be better
- Knowledgeable - you understand nutrition science, recovery, and training principles
- Direct - no fluff, get to the point with actionable advice
- Motivating - you believe in the person and remind them of their potential
- Personalized - you use their actual data to give specific recommendations

COMMUNICATION STYLE:
- Keep responses concise (2-4 sentences usually, unless they ask for detail)
- Use their name occasionally to make it personal
- Reference their actual data when relevant ("I see you hit 171g protein yesterday - nice!")
- Ask follow-up questions to understand context
- Be real - if they're slacking, kindly point it out

CAPABILITIES - YOU MUST USE THESE TOOLS:
You have tools to access the user's fitness data. ALWAYS call the appropriate tool BEFORE answering.

Available tools:
- getTodaysSummary: Get today's calories, protein, carbs, fat, workout status, recovery, habits
- getMeals: Get specific meals logged for any date range  
- getWorkouts: Get workout history
- getRecoveryData: Get Whoop recovery score, HRV, sleep hours, strain
- getHabits: Get water intake, alcohol, electrolytes for a date
- getGoals: Get the user's calorie/protein/macro goals
- getWeightTrend: Get weight history
- getRemainingMacros: Get exactly how many calories/protein/carbs/fat remain for today
- getDrinkingRecoveryCorrelation: Analyze how alcohol affects recovery
- getWeeklySummary: Get summary of the past week

CRITICAL RULES FOR TOOL USAGE:
1. ALWAYS call a tool BEFORE answering questions about the user's data
2. If asked "what did I eat" -> call getMeals
3. If asked "how many calories left" or "what should I eat" -> call getRemainingMacros
4. If asked "how am I doing" -> call getTodaysSummary
5. If asked about goals -> call getGoals
6. If asked about recovery/sleep/HRV -> call getRecoveryData
7. NEVER guess or make up numbers - ALWAYS look them up first
8. When giving meal recommendations, FIRST call getRemainingMacros to know exact targets
9. For follow-up questions like "how", "what", "why" - look at the conversation context and call the relevant tool again to get fresh data
10. If the user asks for food recommendations or "what should I eat", ALWAYS call getRemainingMacros first
11. When in doubt about what the user is asking, call getTodaysSummary to have context

IMPORTANT: If a tool call fails or returns an error, tell the user there was a technical issue and ask them to try again. Do NOT give generic advice without their actual data.

CONTEXT:
- User's goal is body recomposition (lose fat, gain muscle)
- They do Barry's Bootcamp classes
- They track via Whoop for recovery/strain
- Base goals: ~1800 calories, ~135g protein on rest days (more on workout days)

Remember: You're not just an AI - you're their personal coach who has access to all their data and genuinely wants to see them succeed. USE YOUR TOOLS to give data-driven advice.`;

export class ChatAgent extends Agent<Env, ChatState> {
  private tools: FitnessTools | null = null;

  // Initialize state
  initialState: ChatState = {
    messages: [],
    userId: '',
    timezone: 'America/Los_Angeles',
    isTyping: false
  };

  async onStart() {
    try {
      // Create tables for chat history
      this.sql`
        CREATE TABLE IF NOT EXISTS chat_messages (
          id TEXT PRIMARY KEY,
          role TEXT NOT NULL,
          content TEXT NOT NULL,
          tool_calls TEXT,
          timestamp INTEGER NOT NULL
        )
      `;

      // Load existing messages
      const messages = this.sql<{
        id: string;
        role: string;
        content: string;
        tool_calls: string | null;
        timestamp: number;
      }>`SELECT * FROM chat_messages ORDER BY timestamp ASC LIMIT 50`;

      if (messages.length > 0) {
        this.setState({
          ...this.state,
          messages: messages.map(m => ({
            id: m.id,
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
            timestamp: m.timestamp,
            toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined
          }))
        });
      }
    } catch (error) {
      console.error('ChatAgent onStart error:', error);
      // Initialize with empty state on error
      this.setState({
        ...this.state,
        messages: []
      });
    }
  }

  async onConnect(connection: Connection, ctx: ConnectionContext) {
    try {
      // Extract user ID and timezone from request
      const url = new URL(ctx.request.url);
      const userId = url.searchParams.get('userId') || 'demo';
      // Get timezone from client - defaults to PT
      const timezone = url.searchParams.get('tz') || 'America/Los_Angeles';
      
      // Initialize tools with user context and their timezone
      this.tools = new FitnessTools(this.env, userId, timezone);
      
      this.setState({
        ...this.state,
        userId,
        timezone
      });

      // Send current state to the new connection
      connection.send(JSON.stringify({
        type: 'state',
        messages: this.state.messages
      }));
    } catch (error) {
      console.error('ChatAgent onConnect error:', error);
      // Still send state even on error so client knows we're connected
      connection.send(JSON.stringify({
        type: 'state',
        messages: []
      }));
    }
  }

  async onMessage(connection: Connection, message: string | ArrayBuffer) {
    if (typeof message !== 'string') return;

    try {
      const data = JSON.parse(message);
      
      if (data.type === 'chat') {
        await this.handleChatMessage(connection, data.content);
      } else if (data.type === 'clear') {
        await this.clearHistory(connection);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Failed to process message'
      }));
    }
  }

  private async handleChatMessage(connection: Connection, content: string) {
    // Add user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now()
    };

    // Save to DB
    this.sql`
      INSERT INTO chat_messages (id, role, content, timestamp)
      VALUES (${userMessage.id}, ${userMessage.role}, ${userMessage.content}, ${userMessage.timestamp})
    `;

    // Update state
    const updatedMessages = [...this.state.messages, userMessage];
    this.setState({
      ...this.state,
      messages: updatedMessages,
      isTyping: true
    });

    // Notify client
    connection.send(JSON.stringify({
      type: 'message',
      message: userMessage
    }));

    connection.send(JSON.stringify({
      type: 'typing',
      isTyping: true
    }));

    try {
      // Generate AI response with tool calls
      const response = await this.generateResponse(updatedMessages);
      
      // Add assistant message
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response.content,
        timestamp: Date.now(),
        toolCalls: response.toolCalls
      };

      // Save to DB
      this.sql`
        INSERT INTO chat_messages (id, role, content, tool_calls, timestamp)
        VALUES (${assistantMessage.id}, ${assistantMessage.role}, ${assistantMessage.content}, ${response.toolCalls ? JSON.stringify(response.toolCalls) : null}, ${assistantMessage.timestamp})
      `;

      // Update state
      this.setState({
        ...this.state,
        messages: [...updatedMessages, assistantMessage],
        isTyping: false
      });

      // Send response
      connection.send(JSON.stringify({
        type: 'message',
        message: assistantMessage
      }));

    } catch (error) {
      console.error('Error generating response:', error);
      connection.send(JSON.stringify({
        type: 'error',
        message: 'Failed to generate response'
      }));
    } finally {
      connection.send(JSON.stringify({
        type: 'typing',
        isTyping: false
      }));
    }
  }

  private async generateResponse(messages: ChatMessage[]): Promise<{ content: string; toolCalls?: ToolCall[] }> {
    const cfToken = this.env.CF_API_TOKEN;
    if (!cfToken) {
      console.error('CF_API_TOKEN is not configured!');
      throw new Error('CF_API_TOKEN not configured');
    }

    // Format messages for API
    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...messages.map(m => ({
        role: m.role,
        content: m.content
      }))
    ];

    console.log(`[ChatAgent] Sending request with ${messages.length} messages and ${toolDefinitions.length} tools`);
    const lastUserMessage = messages[messages.length - 1]?.content?.toLowerCase() || '';
    console.log(`[ChatAgent] Last user message: "${lastUserMessage.substring(0, 100)}..."`);

    // Detect if this is a data-related question that REQUIRES tool usage
    // Check both the current message and recent context
    const recentMessages = messages.slice(-4).map(m => m.content?.toLowerCase() || '').join(' ');
    const dataKeywords = [
      'calories', 'protein', 'carbs', 'fat', 'macros', 'eat', 'ate', 'food', 'meal',
      'workout', 'exercise', 'recovery', 'sleep', 'hrv', 'strain', 'whoop',
      'weight', 'progress', 'goal', 'remaining', 'left', 'today', 'yesterday',
      'how much', 'how many', 'what should', 'recommend', 'suggestion'
    ];
    
    const needsData = dataKeywords.some(kw => lastUserMessage.includes(kw) || recentMessages.includes(kw));
    
    // For short follow-up questions, check if recent context was about data
    const isShortFollowUp = lastUserMessage.length < 20;
    const contextNeedsData = isShortFollowUp && dataKeywords.some(kw => recentMessages.includes(kw));
    
    // Determine tool_choice - use "required" if we detect data needs
    const shouldForceTools = needsData || contextNeedsData;
    console.log(`[ChatAgent] needsData: ${needsData}, contextNeedsData: ${contextNeedsData}, shouldForceTools: ${shouldForceTools}`);

    // First call - may include tool calls
    const requestBody = {
      model: 'gpt-4o-mini',
      messages: apiMessages,
      tools: toolDefinitions,
      // Force tool usage for data-related questions
      tool_choice: shouldForceTools ? 'required' : 'auto',
      max_tokens: 1000,
      temperature: 0.7
    };

    const response = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[ChatAgent] AI Gateway error:', response.status, error);
      throw new Error(`AI request failed: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: {
              name: string;
              arguments: string;
            };
          }>;
        };
        finish_reason: string;
      }>;
    };

    const choice = data.choices[0];
    console.log(`[ChatAgent] AI response - finish_reason: ${choice.finish_reason}, has_tool_calls: ${!!choice.message.tool_calls}, tool_count: ${choice.message.tool_calls?.length || 0}`);
    
    // If no tool calls, return content directly
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      console.log('[ChatAgent] No tool calls requested by AI, returning direct response');
      return { content: choice.message.content || 'I apologize, I had trouble responding. Can you try again?' };
    }

    // Execute tool calls
    console.log(`[ChatAgent] Executing ${choice.message.tool_calls.length} tool calls`);
    const toolResults: ToolCall[] = [];
    
    for (const toolCall of choice.message.tool_calls) {
      const name = toolCall.function.name;
      const args = JSON.parse(toolCall.function.arguments);
      console.log(`[ChatAgent] Executing tool: ${name} with args:`, JSON.stringify(args));
      
      let result: unknown;
      try {
        result = await this.executeTool(name, args);
        console.log(`[ChatAgent] Tool ${name} succeeded, result keys:`, Object.keys(result as object));
      } catch (error) {
        console.error(`[ChatAgent] Tool ${name} failed:`, error);
        result = { error: 'Tool execution failed', details: String(error) };
      }

      toolResults.push({
        id: toolCall.id,
        name,
        arguments: args,
        result
      });
    }

    // Second call with tool results
    console.log('[ChatAgent] Making follow-up request with tool results');
    const messagesWithToolResults = [
      ...apiMessages,
      choice.message,
      ...toolResults.map(t => ({
        role: 'tool' as const,
        tool_call_id: t.id,
        content: JSON.stringify(t.result)
      }))
    ];

    const followUpResponse = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: messagesWithToolResults,
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!followUpResponse.ok) {
      const error = await followUpResponse.text();
      console.error('[ChatAgent] Follow-up AI request failed:', followUpResponse.status, error);
      throw new Error('Follow-up AI request failed');
    }

    const followUpData = await followUpResponse.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    console.log('[ChatAgent] Follow-up response received successfully');
    return {
      content: followUpData.choices[0].message.content,
      toolCalls: toolResults
    };
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (!this.tools) {
      throw new Error('Tools not initialized');
    }

    switch (name) {
      case 'getTodaysSummary':
        return this.tools.getTodaysSummary();
      case 'getMeals':
        return this.tools.getMeals(args.startDate as string, args.endDate as string);
      case 'getWorkouts':
        return this.tools.getWorkouts(args.startDate as string, args.endDate as string);
      case 'getRecoveryData':
        return this.tools.getRecoveryData(args.days as number);
      case 'getHabits':
        return this.tools.getHabits(args.date as string);
      case 'getGoals':
        return this.tools.getGoals();
      case 'getWeightTrend':
        return this.tools.getWeightTrend(args.days as number);
      case 'getRemainingMacros':
        return this.tools.getRemainingMacros();
      case 'getDrinkingRecoveryCorrelation':
        return this.tools.getDrinkingRecoveryCorrelation();
      case 'getWeeklySummary':
        return this.tools.getWeeklySummary();
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  private async clearHistory(connection: Connection) {
    this.sql`DELETE FROM chat_messages`;
    this.setState({
      ...this.state,
      messages: []
    });
    connection.send(JSON.stringify({
      type: 'cleared'
    }));
  }
}
