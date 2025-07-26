// mediguid-nyc-backend/server.js
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config(); // Load environment variables from .env file

const app = express();
const port = process.env.PORT || 5000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json()); // Enable parsing of JSON request bodies

// --- Data Loading ---
let symptomsData = [];
let conditionsData = [];
let recommendationsData = [];
let resourcesData = [];

// Function to load data from JSON files
const loadData = () => {
  try {
    symptomsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'symptoms.json'), 'utf8'));
    conditionsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'conditions.json'), 'utf8'));
    recommendationsData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'recommendations.json'), 'utf8'));
    resourcesData = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'resources.json'), 'utf8'));
    console.log('Local data loaded successfully from JSON files.');
  } catch (error) {
    console.error('Error loading data from JSON files:', error);
    process.exit(1); // Exit if essential data can't be loaded
  }
};

// Load data when the server starts
loadData();

// --- API Endpoints ---

// 1. Get all symptoms
app.get('/api/symptoms', (req, res) => {
  res.json(symptomsData);
});

// 2. Diagnose using Open Router AI based on selected symptoms OR chat input
app.post('/api/diagnose', async (req, res) => {
  const { selectedSymptomIds, chatInput } = req.body;

  let prompt = '';

  // PRIORITIZE CHAT INPUT: If chatInput is provided, use it for a direct AI prompt
  if (chatInput && chatInput.trim() !== '') {
    prompt = `
      You are an AI medical assistant. A user from New York City says: "${chatInput}".
      Please provide the following information:
      1.  **Condition:** The most likely common non-emergency medical condition that fits this description. Be concise.
      2.  **Description:** A brief, easy-to-understand description of this condition.
      3.  **Self-Care:** General self-care advice and home remedies for this condition.
      4.  **When to See a Doctor:** Clear guidance on specific situations or worsening symptoms that necessitate consulting a professional healthcare provider or seeking emergency care.
      5.  **Important Disclaimer:** A prominent statement clarifying that this information is for general guidance only, **is not a medical diagnosis**, and does not replace professional medical advice.

      Format your response with these exact bolded headings. Maintain a supportive, informative, and cautious tone.
    `;
    console.log("Generating AI guidance for chat input:", chatInput);

  } else if (selectedSymptomIds && Array.isArray(selectedSymptomIds) && selectedSymptomIds.length > 0) {
    // If selectedSymptomIds are provided (from the SymptomSelectionPage) AND chatInput is not
    const symptomNames = selectedSymptomIds
      .map(id => {
        const symptom = symptomsData.find(s => s.id === id);
        return symptom ? symptom.name : null;
      })
      .filter(name => name !== null);

    if (symptomNames.length === 0) {
      return res.status(400).json({ error: 'No valid symptom names found for provided IDs. Please check the symptom IDs.' });
    }

    prompt = `
      You are an AI medical assistant. A user from New York City reports the following symptoms: ${symptomNames.join(', ')}.
      Please provide the following information:
      1.  **Condition:** The most likely common non-emergency medical condition that fits these symptoms. Be concise.
      2.  **Description:** A brief, easy-to-understand description of this condition.
      3.  **Self-Care:** General self-care advice and home remedies for this condition.
      4.  **When to See a Doctor:** Clear guidance on specific situations or worsening symptoms that necessitate consulting a professional healthcare provider or seeking emergency care.
      5.  **Important Disclaimer:** A prominent statement clarifying that this information is for general guidance only, **is not a medical diagnosis**, and does not replace professional medical advice.

      Format your response with these exact bolded headings. Maintain a supportive, informative, and cautious tone.
    `;
    console.log("Generating AI guidance for selected symptoms:", symptomNames);

  } else {
    // Neither chatInput nor valid selectedSymptomIds provided, which means an invalid request
    return res.status(400).json({ error: 'Please provide either selected symptom IDs or text input for diagnosis.' });
  }

  try {
    const aiResponse = await axios.post(
      'https://openrouter.ai/api/v1/chat/completions',
      {
        model: process.env.OPENROUTER_MODEL || 'mistralai/mistral-7b-instruct', // Use model from .env or default
        messages: [{ role: 'user', content: prompt }],
        stream: false,
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`,
          // It's good practice to set Referer and X-Title if required by OpenRouter policy
          'HTTP-Referer': process.env.OPENROUTER_HTTP_REFERER || 'https://mediguidnyc.netlify.app',
          'X-Title': process.env.OPENROUTER_X_TITLE || 'MediGuid NYC AI Assistant',
          'Content-Type': 'application/json',
        },
      }
    );

    const aiContent = aiResponse.data.choices[0].message.content;

    // --- Enhance AI response with structured local data ---
    // This part attempts to link the AI's general suggestion to your pre-defined structured data.
    // It's currently designed to find matches based on the AI's 'Condition' output.
    // For chat-based input, the AI's response might be less structured, making this matching harder.
    // You might need to refine this for robust chat integration.
    let structuredRecommendations = [];
    let generalResourceGuidance = resourcesData.filter(r => r.type === 'general_clinic' || r.type === 'telehealth');

    const aiConditionNameMatch = aiContent.match(/\*\*Condition:\*\* (.+?)\n/i);
    if (aiConditionNameMatch && aiConditionNameMatch[1]) {
      const suggestedCondition = aiConditionNameMatch[1].trim();
      const predefinedCondition = conditionsData.find(c =>
        suggestedCondition.toLowerCase().includes(c.name.toLowerCase()) ||
        c.name.toLowerCase().includes(suggestedCondition.toLowerCase())
      );

      if (predefinedCondition) {
        structuredRecommendations = recommendationsData.filter(
          rec => rec.condition_id === predefinedCondition.id
        );
      }
    }

    res.json({
      aiResponse: aiContent,
      structuredData: {
        recommendations: structuredRecommendations,
        resources: generalResourceGuidance,
      },
      message: 'AI guidance generated. Remember this is not a medical diagnosis.'
    });

  } catch (error) {
    console.error('Error calling Open Router AI:', error.response ? error.response.data : error.message);
    res.status(500).json({
      error: 'Failed to generate AI guidance. This might be due to an issue with the AI service or your request. Please try again later or refine your symptom selection.',
      details: error.response ? error.response.data : error.message
    });
  }
});

// 3. Get all resources
app.get('/api/resources', (req, res) => {
  res.json(resourcesData);
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});