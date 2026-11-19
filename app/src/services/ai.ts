/// <reference types="@cloudflare/workers-types" />

import { Env, ProgressAnalysis } from '../types/env';

interface FoodAnalysisResult {
  foods: {
    name: string;
    portion_size: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    confidence: number;
  }[];
  total_calories: number;
  total_protein: number;
  total_carbs: number;
  total_fat: number;
  meal_description: string;
  health_notes?: string[];
}

interface RecipeNutrition {
  name: string;
  servings: number;
  calories_per_serving: number;
  protein_per_serving: number;
  carbs_per_serving: number;
  fat_per_serving: number;
  ingredients: {
    name: string;
    amount: string;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
  }[];
}

/**
 * AI Service - Powered by Cloudflare Workers AI
 * 
 * Uses:
 * - LLaMA 3.2 Vision for food photo analysis
 * - LLaMA 3.1 for text processing and nutrition estimation
 * - BGE embeddings for semantic food search
 */
export class AIService {
  private ai: Ai;
  private vectorize: VectorizeIndex;

  constructor(env: Env) {
    this.ai = env.AI;
    this.vectorize = env.FOOD_INDEX;
  }

  /**
   * Analyze a food photo and estimate nutritional content
   */
  async analyzeFoodPhoto(imageData: ArrayBuffer): Promise<FoodAnalysisResult> {
    const imageArray = [...new Uint8Array(imageData)];
    
    // Use LLaMA 3.2 Vision for food recognition
    const visionResponse = await this.ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this food image and provide detailed nutritional estimates. 
              
              Return a JSON object with this exact structure:
              {
                "foods": [
                  {
                    "name": "food item name",
                    "portion_size": "estimated portion (e.g., '1 cup', '6 oz')",
                    "calories": number,
                    "protein": number (grams),
                    "carbs": number (grams),
                    "fat": number (grams),
                    "confidence": number (0-1)
                  }
                ],
                "meal_description": "brief description of the meal",
                "health_notes": ["optional health tips or observations"]
              }
              
              Be accurate with portions based on visual cues like plate size, utensils, or other items for scale.
              Only return valid JSON, no other text.`
            },
            {
              type: 'image',
              image: imageArray
            }
          ]
        }
      ],
      max_tokens: 1024
    });

    // Parse the AI response
    try {
      const responseText = typeof visionResponse === 'string' 
        ? visionResponse 
        : (visionResponse as { response?: string }).response || JSON.stringify(visionResponse);
      
      // Extract JSON from response
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in response');
      }
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      // Calculate totals
      const totals = parsed.foods.reduce((acc: { calories: number; protein: number; carbs: number; fat: number }, food: { calories: number; protein: number; carbs: number; fat: number }) => ({
        calories: acc.calories + food.calories,
        protein: acc.protein + food.protein,
        carbs: acc.carbs + food.carbs,
        fat: acc.fat + food.fat
      }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

      return {
        ...parsed,
        total_calories: totals.calories,
        total_protein: totals.protein,
        total_carbs: totals.carbs,
        total_fat: totals.fat
      };
    } catch (error) {
      console.error('Failed to parse food analysis:', error);
      // Return a default response if parsing fails
      return {
        foods: [{
          name: 'Unknown meal',
          portion_size: '1 serving',
          calories: 400,
          protein: 20,
          carbs: 40,
          fat: 15,
          confidence: 0.3
        }],
        total_calories: 400,
        total_protein: 20,
        total_carbs: 40,
        total_fat: 15,
        meal_description: 'Unable to accurately identify meal. Please adjust values.',
        health_notes: ['Consider logging this meal manually for more accurate tracking.']
      };
    }
  }

  /**
   * Analyze text description of food and estimate nutrition
   */
  async analyzeTextFood(description: string): Promise<FoodAnalysisResult> {
    const response = await this.ai.run('@cf/meta/llama-3.1-8b-instruct' as keyof AiModels, {
      messages: [
        {
          role: 'system',
          content: `You are a nutrition expert. When given a food description, estimate the nutritional content accurately.
          Always return valid JSON with this structure:
          {
            "foods": [{"name": string, "portion_size": string, "calories": number, "protein": number, "carbs": number, "fat": number, "confidence": number}],
            "meal_description": string,
            "health_notes": [string]
          }`
        },
        {
          role: 'user',
          content: `Estimate the nutritional content for: "${description}". Consider typical portion sizes if not specified.`
        }
      ],
      max_tokens: 1024
    });

    try {
      const responseText = typeof response === 'string' 
        ? response 
        : (response as { response?: string }).response || JSON.stringify(response);
      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      const parsed = JSON.parse(jsonMatch[0]);
      
      const totals = parsed.foods.reduce((acc: { calories: number; protein: number; carbs: number; fat: number }, food: { calories: number; protein: number; carbs: number; fat: number }) => ({
        calories: acc.calories + food.calories,
        protein: acc.protein + food.protein,
        carbs: acc.carbs + food.carbs,
        fat: acc.fat + food.fat
      }), { calories: 0, protein: 0, carbs: 0, fat: 0 });

      return {
        ...parsed,
        total_calories: totals.calories,
        total_protein: totals.protein,
        total_carbs: totals.carbs,
        total_fat: totals.fat
      };
    } catch (error) {
      console.error('Failed to parse text food analysis:', error);
      throw new Error('Could not analyze food description');
    }
  }

  /**
   * Analyze a progress photo and provide feedback
   */
  async analyzeProgressPhoto(
    currentPhoto: ArrayBuffer, 
    previousPhotos?: { date: string; analysis: ProgressAnalysis }[]
  ): Promise<ProgressAnalysis> {
    const imageArray = [...new Uint8Array(currentPhoto)];
    
    let previousContext = '';
    if (previousPhotos && previousPhotos.length > 0) {
      previousContext = `
      Previous progress observations:
      ${previousPhotos.map(p => `- ${p.date}: ${p.analysis.observations.join(', ')}`).join('\n')}
      `;
    }

    const response = await this.ai.run('@cf/meta/llama-3.2-11b-vision-instruct', {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Analyze this fitness progress photo. Provide constructive, encouraging feedback.
              ${previousContext}
              
              Return JSON with this structure:
              {
                "observations": ["list of current observations about physique"],
                "comparison_to_previous": "how this compares to previous photos if available",
                "visible_changes": ["specific visible improvements or changes"],
                "recommendations": ["helpful tips or areas to focus on"]
              }
              
              Be encouraging and specific. Focus on positive changes while being honest.
              Only return valid JSON.`
            },
            {
              type: 'image',
              image: imageArray
            }
          ]
        }
      ],
      max_tokens: 1024
    });

    try {
      const responseText = typeof response === 'string' 
        ? response 
        : (response as { response?: string }).response || JSON.stringify(response);
      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Failed to parse progress analysis:', error);
      return {
        observations: ['Photo received and stored for progress tracking.'],
        visible_changes: [],
        recommendations: ['Keep up the consistent work!']
      };
    }
  }

  /**
   * Generate embeddings for a food item for semantic search
   */
  async generateFoodEmbedding(foodDescription: string): Promise<number[]> {
    const response = await this.ai.run('@cf/baai/bge-base-en-v1.5', {
      text: foodDescription
    });

    return (response as { data: number[][] }).data[0];
  }

  /**
   * Search for similar foods using semantic search
   */
  async searchSimilarFoods(query: string, limit: number = 10): Promise<{ id: string; score: number }[]> {
    const embedding = await this.generateFoodEmbedding(query);
    
    const results = await this.vectorize.query(embedding, {
      topK: limit,
      returnMetadata: 'all'
    });

    return results.matches.map(match => ({
      id: match.id,
      score: match.score
    }));
  }

  /**
   * Analyze a recipe URL and extract nutrition info
   * This would be combined with Browser Rendering to fetch the page first
   */
  async analyzeRecipeText(recipeContent: string): Promise<RecipeNutrition> {
    const response = await this.ai.run('@cf/meta/llama-3.1-8b-instruct' as keyof AiModels, {
      messages: [
        {
          role: 'system',
          content: `You are a nutrition expert. Analyze recipes and calculate per-serving nutrition.
          Return JSON with: name, servings, calories_per_serving, protein_per_serving, carbs_per_serving, fat_per_serving, ingredients array.`
        },
        {
          role: 'user',
          content: `Analyze this recipe and calculate nutrition per serving:\n\n${recipeContent}`
        }
      ],
      max_tokens: 2048
    });

    try {
      const responseText = typeof response === 'string' 
        ? response 
        : (response as { response?: string }).response || JSON.stringify(response);
      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      console.error('Failed to parse recipe analysis:', error);
      throw new Error('Could not analyze recipe');
    }
  }

  /**
   * Get personalized meal suggestions based on remaining macros
   */
  async getMealSuggestions(
    remainingCalories: number,
    remainingProtein: number,
    remainingCarbs: number,
    remainingFat: number,
    mealType: 'breakfast' | 'lunch' | 'dinner' | 'snack',
    preferences?: string[]
  ): Promise<{ suggestions: string[]; reasoning: string }> {
    const prefsText = preferences?.length ? `Preferences: ${preferences.join(', ')}` : '';
    
    const response = await this.ai.run('@cf/meta/llama-3.1-8b-instruct' as keyof AiModels, {
      messages: [
        {
          role: 'system',
          content: 'You are a helpful nutrition coach. Suggest meals that fit macro targets.'
        },
        {
          role: 'user',
          content: `I need ${mealType} suggestions. 
          Remaining macros for today: ${remainingCalories} cal, ${remainingProtein}g protein, ${remainingCarbs}g carbs, ${remainingFat}g fat.
          ${prefsText}
          
          Suggest 3-5 meal options that would help hit these targets. Return JSON:
          {"suggestions": ["meal 1", "meal 2", ...], "reasoning": "why these meals work"}`
        }
      ],
      max_tokens: 512
    });

    try {
      const responseText = typeof response === 'string' 
        ? response 
        : (response as { response?: string }).response || JSON.stringify(response);
      
      const jsonMatch = responseText.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON found');
      
      return JSON.parse(jsonMatch[0]);
    } catch (error) {
      return {
        suggestions: [
          'Grilled chicken with vegetables',
          'Greek yogurt with berries',
          'Salmon with quinoa'
        ],
        reasoning: 'High-protein options to help reach your daily goals.'
      };
    }
  }
}
