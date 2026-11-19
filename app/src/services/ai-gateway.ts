/// <reference types="@cloudflare/workers-types" />

import { Env } from '../types/env';
import { simpleHash, normalizeFoodDescription, fetchWithTimeout } from '../utils/error-handling';

/**
 * AI Gateway Service - Premium AI for nutrition & fitness
 * 
 * Uses Cloudflare AI Gateway with Unified Billing.
 * 
 * Per docs (https://developers.cloudflare.com/ai-gateway/features/unified-billing/):
 * - Endpoint: /compat/chat/completions (unified OpenAI-compatible endpoint)
 * - Model format: provider/model (e.g., openai/gpt-5-mini)
 * - Auth: cf-aig-authorization: Bearer {CF_API_TOKEN}
 * - REQUIRES: Credits loaded + Authenticated Gateway enabled
 * 
 * Models used:
 * - openai/gpt-5-mini: Fast, cost-effective text analysis
 * - openai/gpt-5: High-quality vision/photo analysis
 */

const ACCOUNT_ID = 'ede31cad5fa379850e090febbeaba602';
const GATEWAY_ID = 'ai-playground';
const AI_GATEWAY_URL = `https://gateway.ai.cloudflare.com/v1/${ACCOUNT_ID}/${GATEWAY_ID}/compat/chat/completions`;

// Models WITH provider prefix for /compat endpoint
const TEXT_MODEL = 'openai/gpt-5-mini';
// Use GPT-4o for vision (GPT-5 vision may not be available yet)
const VISION_MODEL = 'openai/gpt-4o';

// Types
export interface FoodItem {
  name: string;
  portion_size: string;
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
  confidence: number;
}

export interface FoodAnalysisResult {
  foods: FoodItem[];
  total_calories: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
  meal_name: string;
  meal_description: string;
  health_notes?: string[];
}

export interface MacroTargets {
  calories: number;
  protein: number;
  carbs: number;
  fat: number;
  fiber?: number;
}

export interface DailyMacroCalculation {
  base_tdee: number;
  activity_adjustment: number;
  goal_adjustment: number;
  final_calories: number;
  macros: MacroTargets;
  reasoning: string;
}

export interface ProgressPhotoAnalysis {
  observations: string[];
  visible_changes: string[];
  muscle_development: string[];
  areas_of_progress: string[];
  recommendations: string[];
  encouragement: string;
  comparison_to_previous?: string;
}

export interface WorkoutImpact {
  estimated_calories_burned: number;
  macro_adjustment: MacroTargets;
  post_workout_recommendation: string;
}

// Barry's schedule
const BARRYS_SCHEDULE: Record<number, string> = {
  0: 'Total Body',      // Sunday
  1: 'Arms & Abs',      // Monday
  2: 'Lower Focus',     // Tuesday
  3: 'Chest/Back',      // Wednesday
  4: 'Abs & Ass',       // Thursday
  5: 'Total Body',      // Friday
  6: 'Upper Focus',     // Saturday
};

// System prompts
const FOOD_ANALYSIS_PROMPT = `You are an expert nutritionist with extensive knowledge of food composition and portion sizes.
Your task is to analyze food descriptions and provide accurate nutritional estimates.

CRITICAL - BREAK DOWN INTO INDIVIDUAL INGREDIENTS:
- ALWAYS list each ingredient SEPARATELY in the foods array
- For "2 tacos with steak, cheese, and avocado" return 4+ items: tortillas, steak, cheese, avocado, salsa, etc.
- For "chicken salad" return: chicken breast, lettuce, tomatoes, dressing, etc.
- Each ingredient should have its OWN calories/protein/carbs/fat
- Keep ingredient names SHORT (e.g., "ribeye steak" not "Two steak tacos with ribeye...")
- Keep portion_size SIMPLE (e.g., "4 oz" not a long description)

OTHER GUIDELINES:
1. Be precise with portion sizes - if not specified, use standard serving sizes
2. Account for cooking methods (fried adds fat, grilled is leaner)
3. Consider brand names if mentioned (e.g., "Chipotle burrito bowl" has specific nutrition)
4. Provide a confidence score (0-1) based on how certain you are

Always respond with valid JSON only, no markdown, no explanation, just the JSON object.`;

const FOOD_JSON_FORMAT = `Return JSON in this exact format:
{
  "foods": [
    {
      "name": "short ingredient name",
      "portion_size": "simple amount (e.g. 4 oz, 1 cup, 2 tbsp)",
      "calories": number,
      "protein": number,
      "carbs": number,
      "fat": number,
      "fiber": number,
      "confidence": number (0-1)
    }
  ],
  "meal_name": "short 2-4 word name for this meal",
  "meal_description": "brief description",
  "health_notes": ["optional tips or observations"]
}

EXAMPLE for "steak tacos with cheese and guac":
{
  "foods": [
    {"name": "corn tortillas", "portion_size": "2 small", "calories": 90, "protein": 2, "carbs": 19, "fat": 1, "fiber": 2, "confidence": 0.9},
    {"name": "ribeye steak", "portion_size": "4 oz", "calories": 280, "protein": 28, "carbs": 0, "fat": 18, "fiber": 0, "confidence": 0.8},
    {"name": "queso fresco", "portion_size": "1 oz", "calories": 80, "protein": 5, "carbs": 1, "fat": 6, "fiber": 0, "confidence": 0.8},
    {"name": "guacamole", "portion_size": "2 tbsp", "calories": 50, "protein": 1, "carbs": 3, "fat": 4, "fiber": 2, "confidence": 0.8}
  ],
  "meal_name": "Steak Tacos",
  "meal_description": "Two corn tortilla tacos with grilled ribeye, cheese, and guacamole",
  "health_notes": ["Good protein source", "Healthy fats from avocado"]
}`;

type MessageContent = string | Array<{ type: string; text?: string; image_url?: { url: string } }>;

interface Message {
  role: 'system' | 'user' | 'assistant';
  content: MessageContent;
}

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export class AIGatewayService {
  private cfApiToken: string;
  private ai?: Ai;
  private cache?: KVNamespace;

  constructor(env: Env) {
    this.cfApiToken = env.CF_API_TOKEN || '';
    this.ai = env.AI; // Workers AI binding for fallback
    this.cache = env.CACHE; // KV for caching food analysis
    
    if (!this.cfApiToken) {
      console.warn('AIGatewayService: CF_API_TOKEN is missing, will use Workers AI fallback');
    } else {
      console.log(`AIGatewayService: Initialized with token (${this.cfApiToken.substring(0, 8)}...)`);
    }
  }

  /**
   * Call AI Gateway using the /compat/chat/completions endpoint with Unified Billing
   * 
   * Per Cloudflare docs:
   * - Use cf-aig-authorization: Bearer {CF_API_TOKEN}
   * - Model format: provider/model (e.g., openai/gpt-4o-mini)
   */
  private async callAI(
    model: string,
    messages: Message[],
    options: { max_tokens?: number; temperature?: number; timeout?: number } = {}
  ): Promise<string> {
    console.log(`AI Gateway: Calling model="${model}" at URL="${AI_GATEWAY_URL}"`);
    console.log(`AI Gateway: Using token starting with "${this.cfApiToken.substring(0, 10)}..."`);
    
    // Use fetchWithTimeout for 60 second timeout (AI can be slow)
    const response = await fetchWithTimeout(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        // For Unified Billing: use cf-aig-authorization header
        'cf-aig-authorization': `Bearer ${this.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        max_completion_tokens: options.max_tokens || 2048,
        // Note: GPT-5 only supports temperature=1 (default), so we omit it
      }),
      timeout: options.timeout || 60000 // 60 second default
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`AI Gateway error (${response.status}):`, errorText);
      throw new Error(`AI Gateway request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ChatCompletionResponse;
    const content = data.choices[0]?.message?.content;
    
    if (!content) {
      throw new Error('AI Gateway returned empty response');
    }
    
    console.log(`AI Gateway: SUCCESS via model="${data.model || model}", received ${content.length} chars`);
    return content;
  }

  /**
   * Analyze food from text description
   * Falls back to Workers AI if AI Gateway fails
   * Cached for 24 hours to save AI costs on repeated meals
   */
  async analyzeFoodText(description: string): Promise<FoodAnalysisResult> {
    console.log(`Analyzing food text: "${description.substring(0, 50)}..."`);
    
    // Check cache first (users often log the same meals)
    const normalizedDesc = normalizeFoodDescription(description);
    const cacheKey = `food:text:${simpleHash(normalizedDesc)}`;
    
    if (this.cache) {
      try {
        const cached = await this.cache.get(cacheKey);
        if (cached) {
          console.log(`Food analysis CACHE HIT for: "${description.substring(0, 30)}..."`);
          return JSON.parse(cached);
        }
      } catch (cacheError) {
        console.warn('Cache read error:', cacheError);
      }
    }
    
    try {
      const response = await this.callAI(
        TEXT_MODEL,
        [
          { role: 'system', content: FOOD_ANALYSIS_PROMPT },
          { 
            role: 'user', 
            content: `Analyze this food and provide detailed nutritional breakdown:\n"${description}"\n\n${FOOD_JSON_FORMAT}` 
          }
        ],
        { temperature: 0.2 }
      );

      const result = this.parseFoodResponse(response);
      
      // Cache the result for 24 hours
      if (this.cache) {
        try {
          await this.cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 86400 });
          console.log(`Food analysis cached for 24hrs: "${description.substring(0, 30)}..."`);
        } catch (cacheError) {
          console.warn('Cache write error:', cacheError);
        }
      }
      
      return result;
    } catch (error) {
      console.warn('AI Gateway FAILED, falling back to Workers AI. Error:', error);
      return this.analyzeFoodTextWithWorkersAI(description);
    }
  }
  
  /**
   * Fallback: Analyze food using Workers AI (LLaMA)
   */
  private async analyzeFoodTextWithWorkersAI(description: string): Promise<FoodAnalysisResult> {
    if (!this.ai) {
      throw new Error('Workers AI not available for fallback');
    }
    
    console.log('>>> USING WORKERS AI FALLBACK (LLaMA) for food analysis <<<');
    
    // Use type assertion for the model name
    const response = await (this.ai as Ai).run('@cf/meta/llama-3.1-8b-instruct' as keyof AiModels, {
      messages: [
        { role: 'system', content: FOOD_ANALYSIS_PROMPT },
        { 
          role: 'user', 
          content: `Analyze this food and provide detailed nutritional breakdown:\n"${description}"\n\n${FOOD_JSON_FORMAT}` 
        }
      ],
      max_tokens: 2048,
      temperature: 0.2
    } as AiTextGenerationInput);
    
    const content = typeof response === 'string' ? response : (response as { response?: string }).response;
    if (!content) {
      throw new Error('Workers AI returned empty response');
    }
    
    return this.parseFoodResponse(content);
  }

  /**
   * Analyze food from photo using GPT-4o vision
   * Optionally include a user description for additional context (ingredients, portion info, etc.)
   */
  async analyzeFoodPhoto(imageBase64: string, mimeType: string = 'image/jpeg', userDescription?: string): Promise<FoodAnalysisResult> {
    console.log('Analyzing food photo with GPT-4o vision' + (userDescription ? ' + user description' : ''));
    console.log('Photo base64 length:', imageBase64.length, 'mimeType:', mimeType);
    
    // Build the prompt with optional user description
    let promptText = 'Analyze this food photo and provide nutritional breakdown.';
    if (userDescription) {
      promptText += `\n\nAdditional context from user: "${userDescription}"\n\nUse this information to help identify ingredients, portion sizes, and cooking methods that may not be visible in the photo.`;
    }
    promptText += `\n\n${FOOD_JSON_FORMAT}`;
    
    try {
      const response = await this.callAIVision(imageBase64, mimeType, promptText);
      return this.parseFoodResponse(response);
    } catch (error) {
      console.error('Photo analysis failed:', error);
      
      // If we have a user description, fall back to text analysis
      if (userDescription) {
        console.log('Falling back to text analysis with user description');
        return this.analyzeFoodText(userDescription);
      }
      throw error;
    }
  }
  
  /**
   * Call AI Gateway with vision (image) input
   * Uses a separate method because vision requires different request format
   */
  private async callAIVision(imageBase64: string, mimeType: string, promptText: string): Promise<string> {
    console.log(`AI Gateway Vision: Calling model="${VISION_MODEL}"`);
    
    const requestBody = {
      model: VISION_MODEL,
      messages: [
        { role: 'system', content: FOOD_ANALYSIS_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { 
              type: 'image_url', 
              image_url: { 
                url: `data:${mimeType};base64,${imageBase64}`,
                detail: 'auto'
              } 
            }
          ]
        }
      ],
      max_tokens: 2048
    };
    
    console.log('Vision request - messages count:', requestBody.messages.length);
    
    // Use 90 second timeout for vision (images take longer to process)
    const response = await fetchWithTimeout(AI_GATEWAY_URL, {
      method: 'POST',
      headers: {
        'cf-aig-authorization': `Bearer ${this.cfApiToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      timeout: 90000 // 90 seconds for vision
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`AI Gateway Vision error (${response.status}):`, errorText);
      throw new Error(`AI Gateway vision request failed: ${response.status} - ${errorText}`);
    }

    const data = await response.json() as ChatCompletionResponse;
    console.log('Vision response - choices:', data.choices?.length, 'model:', data.model);
    
    const content = data.choices[0]?.message?.content;
    
    if (!content) {
      console.error('Empty vision response. Full response:', JSON.stringify(data).substring(0, 500));
      throw new Error('AI Gateway returned empty response');
    }
    
    console.log(`AI Gateway Vision: SUCCESS, received ${content.length} chars`);
    return content;
  }

  /**
   * Calculate dynamic macro targets based on user profile and activity
   */
  async calculateDailyMacros(
    weightKg: number,
    heightCm: number,
    age: number,
    isFemale: boolean,
    activityToday: {
      hasBarrys: boolean;
      isDoubleFloor: boolean;
      whoopCaloriesBurned?: number;
      steps?: number;
    },
    goal: 'recomp' | 'cut' | 'maintain' = 'recomp'
  ): Promise<DailyMacroCalculation> {
    const systemPrompt = `You are an expert sports nutritionist specializing in body recomposition.
Calculate optimal daily macros based on the provided stats and activity.
Use evidence-based formulas (Mifflin-St Jeor for BMR) and adjust for activity.
Always respond with valid JSON only.`;

    const weightLbs = weightKg * 2.205;
    const heightInches = heightCm / 2.54;
    
    const userPrompt = `Calculate optimal daily macros for:
- Weight: ${weightKg.toFixed(1)} kg (${weightLbs.toFixed(0)} lbs)
- Height: ${heightCm.toFixed(0)} cm (${heightInches.toFixed(0)} inches)  
- Age: ${age} years
- Sex: ${isFemale ? 'Female' : 'Male'}
- Goal: ${goal === 'recomp' ? 'Body recomposition (lose fat, gain muscle)' : goal === 'cut' ? 'Fat loss' : 'Maintain'}

Today's activity:
- Barry's Bootcamp: ${activityToday.hasBarrys ? 'Yes' : 'No'}${activityToday.hasBarrys && activityToday.isDoubleFloor ? ' (Double Floor - all strength)' : activityToday.hasBarrys ? ' (Regular - cardio + strength)' : ''}
- Whoop tracked calories burned: ${activityToday.whoopCaloriesBurned || 'Not available'}
- Steps: ${activityToday.steps || 'Not available'}

Return JSON:
{
  "base_tdee": number,
  "activity_adjustment": number,
  "goal_adjustment": number,
  "final_calories": number,
  "macros": {
    "calories": number,
    "protein": number,
    "carbs": number,
    "fat": number,
    "fiber": number
  },
  "reasoning": "brief explanation"
}`;

    try {
      const response = await this.callAI(
        TEXT_MODEL,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        { temperature: 0.2 }
      );

      return this.extractJSON<DailyMacroCalculation>(response);
    } catch (error) {
      console.error('Macro calculation failed:', error);
      return this.calculateDefaultMacros(weightKg, heightCm, age, isFemale, activityToday);
    }
  }

  /**
   * Analyze progress photo using GPT-4o vision
   */
  async analyzeProgressPhoto(
    currentPhotoBase64: string,
    previousAnalyses?: Array<{ date: string; summary: string }>,
    mimeType: string = 'image/jpeg'
  ): Promise<ProgressPhotoAnalysis> {
    const previousContext = previousAnalyses?.length
      ? `\n\nPrevious progress notes:\n${previousAnalyses.map(p => `- ${p.date}: ${p.summary}`).join('\n')}`
      : '';

    const systemPrompt = `You are a supportive fitness coach analyzing progress photos.
Be encouraging but honest. Focus on visible changes and muscle development.
Never estimate body fat percentages - just describe what you observe.
Be specific about muscle groups showing development.
Always respond with valid JSON only.`;

    const userPrompt = `Analyze this fitness progress photo.${previousContext}

Return JSON:
{
  "observations": ["current observations about physique"],
  "visible_changes": ["specific changes you can see"],
  "muscle_development": ["which muscle groups show development"],
  "areas_of_progress": ["areas showing improvement"],
  "recommendations": ["helpful suggestions"],
  "encouragement": "motivational message",
  "comparison_to_previous": "how this compares (if previous data available)"
}`;

    try {
      const response = await this.callAI(
        VISION_MODEL,
        [
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              { type: 'text', text: userPrompt },
              { type: 'image_url', image_url: { url: `data:${mimeType};base64,${currentPhotoBase64}` } }
            ]
          }
        ],
        { max_tokens: 1500, temperature: 0.3 }
      );

      return this.extractJSON<ProgressPhotoAnalysis>(response);
    } catch (error) {
      console.error('Progress photo analysis failed:', error);
      return {
        observations: ['Photo received for progress tracking'],
        visible_changes: [],
        muscle_development: [],
        areas_of_progress: [],
        recommendations: ['Keep up the consistent work!'],
        encouragement: 'Every workout counts. Stay consistent and trust the process!'
      };
    }
  }

  /**
   * Get today's Barry's class focus based on day of week
   */
  getBarrysClassFocus(date: Date = new Date()): string {
    return BARRYS_SCHEDULE[date.getDay()];
  }

  /**
   * Calculate workout impact on daily macros
   */
  calculateWorkoutImpact(
    workoutType: 'barrys_regular' | 'barrys_double_floor' | 'other',
    whoopCaloriesBurned?: number,
    durationMinutes: number = 50
  ): WorkoutImpact {
    let estimatedBurn: number;
    let carbAdjustment: number;
    let proteinAdjustment: number;

    switch (workoutType) {
      case 'barrys_regular':
        estimatedBurn = whoopCaloriesBurned || 650;
        carbAdjustment = 30;
        proteinAdjustment = 10;
        break;
      case 'barrys_double_floor':
        estimatedBurn = whoopCaloriesBurned || 450;
        carbAdjustment = 15;
        proteinAdjustment = 15;
        break;
      default:
        estimatedBurn = whoopCaloriesBurned || 300;
        carbAdjustment = 15;
        proteinAdjustment = 10;
    }

    return {
      estimated_calories_burned: estimatedBurn,
      macro_adjustment: {
        calories: Math.round(estimatedBurn * 0.5),
        protein: proteinAdjustment,
        carbs: carbAdjustment,
        fat: 0
      },
      post_workout_recommendation: workoutType === 'barrys_double_floor'
        ? 'Focus on protein intake within 2 hours for muscle recovery'
        : 'Replenish with protein and carbs for optimal recovery'
    };
  }

  /**
   * Analyze recipe nutrition from ingredients list
   * Used by Browser Rendering recipe import
   */
  async analyzeRecipeNutrition(
    recipeName: string,
    ingredients: string[],
    servings: number = 4
  ): Promise<{
    calories_per_serving: number;
    protein_per_serving: number;
    carbs_per_serving: number;
    fat_per_serving: number;
    ingredient_breakdown?: Array<{ name: string; calories: number; protein: number; carbs: number; fat: number }>;
  }> {
    const systemPrompt = `You are an expert nutritionist. Analyze recipe ingredients and calculate accurate per-serving nutrition.
Be precise with portions and cooking methods. Account for oils, sauces, and all ingredients.
Always respond with valid JSON only.`;

    const userPrompt = `Calculate nutrition per serving for this recipe:

Recipe: ${recipeName}
Servings: ${servings}

Ingredients:
${ingredients.map((ing, i) => `${i + 1}. ${ing}`).join('\n')}

Return JSON:
{
  "calories_per_serving": number,
  "protein_per_serving": number,
  "carbs_per_serving": number,
  "fat_per_serving": number,
  "ingredient_breakdown": [
    { "name": "ingredient name", "calories": number, "protein": number, "carbs": number, "fat": number }
  ],
  "notes": "any relevant notes about the calculation"
}`;

    try {
      const response = await this.callAI(
        TEXT_MODEL,
        [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt }
        ],
        { temperature: 0.2 }
      );

      interface RecipeNutritionResponse {
        calories_per_serving: number;
        protein_per_serving: number;
        carbs_per_serving: number;
        fat_per_serving: number;
        ingredient_breakdown?: Array<{ name: string; calories: number; protein: number; carbs: number; fat: number }>;
      }

      const parsed = this.extractJSON<RecipeNutritionResponse>(response);
      
      return {
        calories_per_serving: Math.round(parsed.calories_per_serving || 0),
        protein_per_serving: Math.round(parsed.protein_per_serving || 0),
        carbs_per_serving: Math.round(parsed.carbs_per_serving || 0),
        fat_per_serving: Math.round(parsed.fat_per_serving || 0),
        ingredient_breakdown: parsed.ingredient_breakdown
      };
    } catch (error) {
      console.error('Recipe nutrition analysis failed:', error);
      // Return zeros if analysis fails - user can edit manually
      return {
        calories_per_serving: 0,
        protein_per_serving: 0,
        carbs_per_serving: 0,
        fat_per_serving: 0
      };
    }
  }

  // ============ HELPER METHODS ============

  private parseFoodResponse(response: string): FoodAnalysisResult {
    interface ParsedFood {
      foods?: FoodItem[];
      meal_name?: string;
      meal_description?: string;
      health_notes?: string[];
    }
    
    const parsed = this.extractJSON<ParsedFood>(response);
    const foods = parsed.foods || [];
    
    // Calculate totals
    const totals = foods.reduce(
      (acc, food) => ({
        calories: acc.calories + (food.calories || 0),
        protein: acc.protein + (food.protein || 0),
        carbs: acc.carbs + (food.carbs || 0),
        fat: acc.fat + (food.fat || 0)
      }),
      { calories: 0, protein: 0, carbs: 0, fat: 0 }
    );

    // Generate a meal name from foods if not provided
    const generatedMealName = foods.length > 0 
      ? foods.map(f => f.name).slice(0, 3).join(', ') + (foods.length > 3 ? '...' : '')
      : 'Meal';
    
    return {
      foods,
      total_calories: Math.round(totals.calories),
      total_protein: Math.round(totals.protein),
      total_carbs: Math.round(totals.carbs),
      total_fat: Math.round(totals.fat),
      meal_name: parsed.meal_name || generatedMealName,
      meal_description: parsed.meal_description || '',
      health_notes: parsed.health_notes
    };
  }

  private extractJSON<T>(text: string): T {
    // Try to find JSON in the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.error('No JSON found in response:', text.substring(0, 200));
      throw new Error('No JSON found in response');
    }
    
    let jsonStr = jsonMatch[0];
    
    // Clean up common JSON issues from AI responses
    jsonStr = jsonStr.replace(/,(\s*[}\]])/g, '$1'); // Remove trailing commas
    jsonStr = jsonStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''); // Remove control chars
    
    try {
      return JSON.parse(jsonStr) as T;
    } catch (parseError) {
      console.error('JSON parse error:', parseError);
      console.error('Attempted to parse:', jsonStr.substring(0, 500));
      throw parseError;
    }
  }

  private calculateDefaultMacros(
    weightKg: number,
    heightCm: number,
    age: number,
    isFemale: boolean,
    activity: { hasBarrys: boolean; isDoubleFloor: boolean; whoopCaloriesBurned?: number; steps?: number }
  ): DailyMacroCalculation {
    // Mifflin-St Jeor formula
    const bmr = isFemale
      ? 10 * weightKg + 6.25 * heightCm - 5 * age - 161
      : 10 * weightKg + 6.25 * heightCm - 5 * age + 5;

    // Activity multiplier
    let activityMultiplier = 1.2;
    if (activity.hasBarrys) {
      activityMultiplier = activity.isDoubleFloor ? 1.5 : 1.6;
    } else if (activity.steps && activity.steps > 10000) {
      activityMultiplier = 1.4;
    } else if (activity.steps && activity.steps > 7500) {
      activityMultiplier = 1.3;
    }

    const tdee = Math.round(bmr * activityMultiplier);
    const activityAdjustment = Math.round(tdee - bmr * 1.2);
    const goalAdjustment = activity.hasBarrys ? 0 : -200;
    const finalCalories = tdee + goalAdjustment;

    const weightLbs = weightKg * 2.205;
    const protein = Math.round(weightLbs * 1);
    const fat = Math.round(weightLbs * 0.35);
    const proteinCals = protein * 4;
    const fatCals = fat * 9;
    const carbCals = finalCalories - proteinCals - fatCals;
    const carbs = Math.round(carbCals / 4);

    return {
      base_tdee: Math.round(bmr * 1.2),
      activity_adjustment: activityAdjustment,
      goal_adjustment: goalAdjustment,
      final_calories: finalCalories,
      macros: {
        calories: finalCalories,
        protein,
        carbs: Math.max(carbs, 100),
        fat,
        fiber: 28
      },
      reasoning: `Based on ${isFemale ? 'female' : 'male'} stats with ${activity.hasBarrys ? "Barry's workout" : 'regular activity'}. High protein for body recomp.`
    };
  }
}
