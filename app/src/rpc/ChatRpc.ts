/**
 * Cap'n Web RPC implementation for Chat
 * 
 * This demonstrates the dramatic reduction in boilerplate compared to
 * the manual WebSocket implementation in ChatAgent.ts
 * 
 * Benefits:
 * - No manual JSON.parse/JSON.stringify
 * - No manual message type handling
 * - Automatic reconnection (client-side)
 * - Promise pipelining for multiple calls
 * - Type-safe bidirectional RPC
 * - Server can call client callbacks (via passed functions)
 */

import { RpcTarget } from 'capnweb';
import { Env } from '../types/env';
import { FitnessTools, toolDefinitions } from '../tools/fitness-tools';

// AI Gateway URL
const AI_GATEWAY_URL = 'https://gateway.ai.cloudflare.com/v1/ede31cad5fa379850e090febbeaba602/ai-playground/openai/chat/completions';

const SYSTEM_PROMPT = `You are a world-class fitness coach and sports nutritionist named Coach. Think of yourself as a combination of a supportive friend and an elite performance coach.

PERSONALITY:
- Supportive but honest - celebrate wins but also call out when things could be better
- Knowledgeable - understand nutrition science, recovery, and training principles
- Direct - no fluff, get to the point with actionable advice
- Motivating - believe in the person and remind them of their potential

COMMUNICATION STYLE:
- Keep responses concise (2-4 sentences usually)
- Use their name occasionally to make it personal
- Reference their actual data when relevant
- Be real - if they're slacking, kindly point it out

You have access to tools to fetch the user's fitness data. ALWAYS use them before answering questions about their data.`;

// Message types
export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
}

/**
 * ChatRpcServer - The Cap'n Web RPC target
 * 
 * Compare this to ChatAgent.ts:
 * - ChatAgent: ~490 lines with manual WebSocket handling
 * - ChatRpcServer: ~200 lines with clean RPC methods
 * 
 * NOTE: This is a simpler implementation without bidirectional callbacks.
 * For bidirectional RPC, the client would pass functions to the server.
 */
export class ChatRpcServer extends RpcTarget {
  private messages: ChatMessage[] = [];
  private tools: FitnessTools;
  private env: Env;

  constructor(env: Env, userId: string, timezone: string = 'America/Los_Angeles') {
    super();
    this.env = env;
    this.tools = new FitnessTools(env, userId, timezone);
  }

  /**
   * Get chat history
   * No manual JSON serialization needed!
   */
  getHistory(): ChatMessage[] {
    return this.messages;
  }

  /**
   * Send a message and get AI response
   * Returns both the user message and assistant response
   */
  async send(content: string): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }> {
    // Create user message
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content,
      timestamp: Date.now()
    };
    this.messages.push(userMessage);

    try {
      // Generate AI response
      const response = await this.generateResponse();
      
      const assistantMessage: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'assistant',
        content: response,
        timestamp: Date.now()
      };
      this.messages.push(assistantMessage);

      return { userMessage, assistantMessage };
    } catch (error) {
      console.error('[ChatRpc] Error generating response:', error);
      throw new Error('Failed to generate response');
    }
  }

  /**
   * Clear chat history
   */
  clear(): void {
    this.messages = [];
  }

  /**
   * Generate AI response using tools
   */
  private async generateResponse(): Promise<string> {
    const cfToken = this.env.CF_API_TOKEN;
    if (!cfToken) throw new Error('CF_API_TOKEN not configured');

    const apiMessages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...this.messages.map(m => ({ role: m.role, content: m.content }))
    ];

    // First call - may include tool calls
    const response = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: apiMessages,
        tools: toolDefinitions,
        tool_choice: 'auto',
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!response.ok) {
      throw new Error(`AI request failed: ${response.status}`);
    }

    const data = await response.json() as {
      choices: Array<{
        message: {
          content: string | null;
          tool_calls?: Array<{
            id: string;
            function: { name: string; arguments: string };
          }>;
        };
      }>;
    };

    const choice = data.choices[0];
    
    // If no tool calls, return content directly
    if (!choice.message.tool_calls || choice.message.tool_calls.length === 0) {
      return choice.message.content || 'I had trouble responding. Can you try again?';
    }

    // Execute tool calls
    const toolResults = await Promise.all(
      choice.message.tool_calls.map(async (toolCall) => {
        const args = JSON.parse(toolCall.function.arguments);
        const result = await this.executeTool(toolCall.function.name, args);
        return {
          role: 'tool' as const,
          tool_call_id: toolCall.id,
          content: JSON.stringify(result)
        };
      })
    );

    // Second call with tool results
    const followUpResponse = await fetch(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${cfToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [...apiMessages, choice.message, ...toolResults],
        max_tokens: 1000,
        temperature: 0.7
      })
    });

    if (!followUpResponse.ok) {
      throw new Error('Follow-up AI request failed');
    }

    const followUpData = await followUpResponse.json() as {
      choices: Array<{ message: { content: string } }>;
    };

    return followUpData.choices[0].message.content;
  }

  private async executeTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case 'getTodaysSummary': return this.tools.getTodaysSummary();
      case 'getMeals': return this.tools.getMeals(args.startDate as string, args.endDate as string);
      case 'getWorkouts': return this.tools.getWorkouts(args.startDate as string, args.endDate as string);
      case 'getRecoveryData': return this.tools.getRecoveryData(args.days as number);
      case 'getHabits': return this.tools.getHabits(args.date as string);
      case 'getGoals': return this.tools.getGoals();
      case 'getWeightTrend': return this.tools.getWeightTrend(args.days as number);
      case 'getRemainingMacros': return this.tools.getRemainingMacros();
      case 'getDrinkingRecoveryCorrelation': return this.tools.getDrinkingRecoveryCorrelation();
      case 'getWeeklySummary': return this.tools.getWeeklySummary();
      default: throw new Error(`Unknown tool: ${name}`);
    }
  }
}

/**
 * TypeScript interface for the RPC API
 * This can be shared between client and server for full type safety
 */
export interface ChatRpcApi {
  getHistory(): ChatMessage[];
  send(content: string): Promise<{ userMessage: ChatMessage; assistantMessage: ChatMessage }>;
  clear(): void;
}
