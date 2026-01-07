/// <reference types="@cloudflare/workers-types" />

import puppeteer from '@cloudflare/puppeteer';

/**
 * Browser Rendering Service
 * 
 * Uses Cloudflare Browser Rendering Workers Binding with Puppeteer.
 * The binding provides direct access to a headless browser without needing API tokens.
 * 
 * Docs: https://developers.cloudflare.com/browser-rendering/workers-bindings/
 */

export interface RecipeData {
  name: string;
  description?: string;
  servings?: number;
  prep_time_minutes?: number;
  cook_time_minutes?: number;
  ingredients: string[];
  instructions: string[];
  calories_per_serving?: number;
  protein_per_serving?: number;
  carbs_per_serving?: number;
  fat_per_serving?: number;
  image_url?: string;
  source_url: string;
}

// Script to extract recipe data - runs in browser context
const EXTRACT_RECIPE_SCRIPT = `
(() => {
  const getText = (sel) => document.querySelector(sel)?.textContent?.trim() || null;
  const getAllText = (sel) => Array.from(document.querySelectorAll(sel)).map(el => el.textContent?.trim()).filter(Boolean);
  
  // Try JSON-LD structured data first (most reliable)
  const jsonLdEl = document.querySelector('script[type="application/ld+json"]');
  if (jsonLdEl) {
    try {
      const data = JSON.parse(jsonLdEl.textContent || '');
      const findRecipe = (obj) => {
        if (obj['@type'] === 'Recipe') return obj;
        if (Array.isArray(obj)) return obj.find(i => i['@type'] === 'Recipe');
        if (obj['@graph']) return obj['@graph'].find(i => i['@type'] === 'Recipe');
        return null;
      };
      const recipe = findRecipe(data);
      if (recipe) {
        const parseTime = (t) => {
          if (!t) return null;
          const match = t.match(/PT(\\d+)M/);
          return match ? parseInt(match[1]) : null;
        };
        return {
          name: recipe.name || '',
          description: recipe.description || '',
          servings: parseInt(recipe.recipeYield) || null,
          prep_time_minutes: parseTime(recipe.prepTime),
          cook_time_minutes: parseTime(recipe.cookTime),
          ingredients: Array.isArray(recipe.recipeIngredient) ? recipe.recipeIngredient : [],
          instructions: Array.isArray(recipe.recipeInstructions) 
            ? recipe.recipeInstructions.map(i => typeof i === 'string' ? i : i.text || i.name || '').filter(Boolean)
            : [],
          image_url: Array.isArray(recipe.image) ? recipe.image[0] : (typeof recipe.image === 'string' ? recipe.image : recipe.image?.url),
          has_structured_data: true
        };
      }
    } catch (e) { console.log('JSON-LD parse failed:', e); }
  }
  
  // Fallback to common selectors
  const title = getText('h1') || getText('.recipe-title') || getText('[itemprop="name"]') || document.title;
  
  let ingredients = [];
  for (const sel of ['[itemprop="recipeIngredient"]', '.wprm-recipe-ingredient', '.recipe-ingredients li', '.ingredients li', '.ingredient']) {
    ingredients = getAllText(sel);
    if (ingredients.length > 0) break;
  }
  
  let instructions = [];
  for (const sel of ['[itemprop="recipeInstructions"] li', '.wprm-recipe-instruction', '.recipe-instructions li', '.instructions li', '.direction', '.step']) {
    instructions = getAllText(sel);
    if (instructions.length > 0) break;
  }
  
  // If still no instructions, try getting instruction containers
  if (instructions.length === 0) {
    const instructionEl = document.querySelector('[itemprop="recipeInstructions"]');
    if (instructionEl) {
      instructions = [instructionEl.textContent?.trim()].filter(Boolean);
    }
  }
  
  const imageEl = document.querySelector('.recipe-image img, [itemprop="image"], .post-thumbnail img, .entry-content img');
  const servingsText = getText('[itemprop="recipeYield"]') || getText('.recipe-servings') || getText('.servings');
  
  return {
    name: title || 'Imported Recipe',
    description: getText('.recipe-summary') || getText('[itemprop="description"]') || '',
    servings: servingsText ? parseInt(servingsText.replace(/[^0-9]/g, '')) : null,
    prep_time_minutes: null,
    cook_time_minutes: null,
    ingredients,
    instructions,
    image_url: imageEl?.src || null,
    has_structured_data: false
  };
})()
`;

/**
 * Scrape a recipe from a URL using Browser Rendering Workers Binding
 */
export async function scrapeRecipe(browserBinding: Fetcher, url: string): Promise<RecipeData> {
  console.log(`[Browser Rendering] Scraping recipe from: ${url}`);
  
  const browser = await puppeteer.launch(browserBinding);
  
  try {
    const page = await browser.newPage();
    
    // Set viewport and user agent
    await page.setViewport({ width: 1280, height: 800 });
    
    console.log(`[Browser Rendering] Navigating to URL...`);
    
    // Navigate with extended timeout for slow recipe sites
    await page.goto(url, { 
      waitUntil: 'networkidle0',
      timeout: 45000 
    });
    
    console.log(`[Browser Rendering] Page loaded, extracting recipe data...`);
    
    // Extract recipe data
    const recipeData = await page.evaluate(EXTRACT_RECIPE_SCRIPT) as {
      name: string;
      description: string;
      servings: number | null;
      prep_time_minutes: number | null;
      cook_time_minutes: number | null;
      ingredients: string[];
      instructions: string[];
      image_url: string | null;
      has_structured_data: boolean;
    };
    
    console.log(`[Browser Rendering] Extracted: ${recipeData.name}, ${recipeData.ingredients.length} ingredients, ${recipeData.instructions.length} steps`);
    
    await browser.close();
    
    return {
      name: recipeData.name,
      description: recipeData.description || undefined,
      servings: recipeData.servings || undefined,
      prep_time_minutes: recipeData.prep_time_minutes || undefined,
      cook_time_minutes: recipeData.cook_time_minutes || undefined,
      ingredients: recipeData.ingredients,
      instructions: recipeData.instructions,
      image_url: recipeData.image_url || undefined,
      source_url: url
    };
    
  } catch (error) {
    console.error('[Browser Rendering] Error:', error);
    await browser.close();
    throw error;
  }
}
