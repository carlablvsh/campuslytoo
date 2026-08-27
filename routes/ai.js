import express from 'express';
import multer from 'multer';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

async function extractTimetableWithGemini(fileBuffer, mimeType, branch, semester, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;

  const prompt = `You are a timetable extraction assistant. Analyze this college timetable document (image or PDF) and extract the schedule for the branch "${branch}" and semester "${semester}".
  
  Understand the visual grid, days of the week, time slots, subject names, abbreviations, subject codes, labs, and any key table included at the bottom mapping abbreviations to full subject names.
  
  CRITICAL RULES:
  1. Only extract classes/labs relevant to the branch "${branch}" and semester "${semester}". Ignore classes for other branches.
  2. Map abbreviations (e.g. "BDA", "MC") to their full subject names using the key/table in the document if present.
  3. Format all times in HH:MM 24-hour format (e.g. "09:30"). If a class spans multiple slots, combine it into one block or split it, but make sure the start and end times are correct.
  4. Day must be one of: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday.
  5. Class type must be: 'lecture' or 'lab'.
  6. DO NOT include lunch breaks, tea breaks, intervals, or empty/free slots.
  7. Do not guess or invent data. If a field is missing, omit it or leave it blank.
  
  Return the output as a JSON array of objects with the following schema:
  [
    {
      "day": "Monday",
      "start_time": "09:00",
      "end_time": "10:00",
      "subject_name": "Full Subject Name",
      "subject_code": "CS601",
      "class_type": "lecture",
      "room": "LH-201",
      "faculty": "Dr. Smith"
    }
  ]`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt },
          {
            inlineData: {
              mimeType: mimeType,
              data: fileBuffer.toString('base64')
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature: 0.1
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
    const jsonText = data.candidates[0].content.parts[0].text;
    return JSON.parse(jsonText);
  }
  
  throw new Error('Unexpected response schema from Gemini API');
}

// Helper: Tokenize text into alphanumeric words
function getWords(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

// REST Client fetch fallback for Gemini API
async function askGemini(question, contexts, history, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  
  let systemPrompt = `You are Campusly, a warm, friendly student AI study buddy and academic companion.
You speak like a supportive, cozy friend who helps the user study, explains concepts, keeps them motivated, and chats about student life. Use a warm tone, supportive emojis (e.g. 🌸, 📚, ✨, 💖, ✦), and clean markdown. Keep responses concise but friendly and helpful.`;

  if (contexts && contexts.length > 0) {
    const formattedContexts = contexts.map((c, i) => 
      `[Source Note ${i + 1}]: "${c.noteTitle}" (Subject: ${c.subjectName})\nContent:\n${c.chunkText}`
    ).join('\n\n---\n\n');
    systemPrompt += `\n\nHere is context from the user's study materials. Refer to this context if relevant, but answer general chat naturally:\n${formattedContexts}`;
  }

  const contents = [];
  
  if (history && history.length > 0) {
    history.forEach(msg => {
      if (msg.text && msg.text.trim()) {
        contents.push({
          role: msg.sender === 'user' ? 'user' : 'model',
          parts: [{ text: msg.text }]
        });
      }
    });
  }

  contents.push({
    role: 'user',
    parts: [{ text: question }]
  });

  const payload = {
    contents,
    systemInstruction: {
      parts: [{ text: systemPrompt }]
    },
    generationConfig: {
      temperature: 0.5,
      maxOutputTokens: 1000
    }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0]) {
    return data.candidates[0].content.parts[0].text;
  }
  
  throw new Error('Unexpected response schema from Gemini API');
}

// REST Client fetch fallback for DeepSeek API (OpenAI-compatible)
async function askDeepSeek(question, contexts, history, apiKey) {
  const url = 'https://api.deepseek.com/chat/completions';
  
  const messages = [];
  
  let systemPrompt = `You are Campusly, a warm, friendly student AI study buddy and academic companion.
You speak like a supportive, cozy friend who helps the user study, explains concepts, keeps them motivated, and chats about student life. Use a warm tone, supportive emojis (e.g. 🌸, 📚, ✨, 💖, ✦), and clean markdown. Keep responses concise but friendly and helpful.`;

  if (contexts && contexts.length > 0) {
    const formattedContexts = contexts.map((c, i) => 
      `[Source Note ${i + 1}]: "${c.noteTitle}" (Subject: ${c.subjectName})\nContent:\n${c.chunkText}`
    ).join('\n\n---\n\n');
    systemPrompt += `\n\nHere is context from the user's study materials. Refer to this context if relevant, but answer general chat naturally:\n${formattedContexts}`;
  }

  messages.push({
    role: "system",
    content: systemPrompt
  });

  if (history && history.length > 0) {
    history.forEach(msg => {
      if (msg.text && msg.text.trim()) {
        messages.push({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        });
      }
    });
  }

  messages.push({
    role: 'user',
    content: question
  });

  const payload = {
    model: "deepseek-chat",
    messages,
    temperature: 0.5,
    max_tokens: 1000
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`DeepSeek API error: ${response.status} - ${errorText}`);
  }

  const data = await response.json();
  if (data.choices && data.choices[0] && data.choices[0].message) {
    return data.choices[0].message.content;
  }
  
  throw new Error('Unexpected response schema from DeepSeek API');
}

// Ask AI endpoint
router.post('/ask', authenticateToken, async (req, res) => {
  const { question, subject_id, history = [] } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  try {
    // 1. Fetch user notes (completely optional and non-blocking)
    let notes = [];
    try {
      if (subject_id) {
        notes = await dbAll(`
          SELECT n.*, s.name as subject_name, s.color as subject_color 
          FROM notes n
          JOIN subjects s ON n.subject_id = s.id
          WHERE n.user_id = ? AND n.subject_id = ?
        `, [req.userId, subject_id]);
      } else {
        notes = await dbAll(`
          SELECT n.*, s.name as subject_name, s.color as subject_color
          FROM notes n
          JOIN subjects s ON n.subject_id = s.id
          WHERE n.user_id = ?
        `, [req.userId]);
      }
    } catch (dbErr) {
      console.error('DB fetch notes failed, continuing without notes context:', dbErr);
    }

    // 2. Chunk documents and build search index (if notes exist)
    const chunks = [];
    if (notes && notes.length > 0) {
      notes.forEach(note => {
        const paragraphs = note.content_extracted.split(/\n\s*\n/);
        paragraphs.forEach((p, idx) => {
          const text = p.trim();
          if (text.length > 20) {
            chunks.push({
              noteId: note.id,
              noteTitle: note.title,
              subjectName: note.subject_name,
              color: note.subject_color,
              chunkText: text,
              index: idx
            });
          }
        });
      });
    }

    // 3. Score chunks against the query keywords using TF-IDF weighting (optional)
    let topChunks = [];
    const queryWords = getWords(question);
    
    if (chunks.length > 0 && queryWords.length > 0) {
      const N = chunks.length;
      const docFrequencies = {};
      queryWords.forEach(qw => {
        let df = 0;
        chunks.forEach(chunk => {
          const words = getWords(chunk.chunkText);
          if (words.includes(qw)) {
            df++;
          }
        });
        docFrequencies[qw] = df;
      });

      const scoredChunks = chunks.map(chunk => {
        const chunkWords = getWords(chunk.chunkText);
        const totalWords = chunkWords.length || 1;
        let score = 0;
        
        queryWords.forEach(qw => {
          const tf = chunkWords.filter(cw => cw === qw).length / totalWords;
          const df = docFrequencies[qw] || 0;
          const idf = Math.log(1 + N / (df + 1));
          score += tf * idf;
        });

        return { ...chunk, score };
      }).filter(c => c.score > 0);

      scoredChunks.sort((a, b) => b.score - a.score);
      topChunks = scoredChunks.slice(0, 8);
    }

    const sources = Array.from(new Set(topChunks.map(c => JSON.stringify({
      id: c.noteId,
      title: c.noteTitle,
      subjectName: c.subjectName,
      color: c.color
    })))).map(s => JSON.parse(s));

    // 4. Synthesize response using user's custom key
    try {
      const userRow = await dbGet('SELECT gemini_api_key FROM users WHERE id = ?', [req.userId]);
      const userGeminiKey = (userRow && userRow.gemini_api_key) ? userRow.gemini_api_key.trim() : null;
      const systemKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
      const apiKey = userGeminiKey || systemKey;

      if (!apiKey) {
        return res.status(400).json({ error: 'GEMINI_KEY_MISSING', message: 'Power your Campusly AI: Connect your own Gemini API key to use AI features.' });
      }

      const geminiAnswer = await askGemini(question, topChunks, history, apiKey);
      return res.json({
        answer: geminiAnswer,
        sources
      });
    } catch (geminiErr) {
      console.error('Gemini API call failed:', geminiErr);
      return res.status(500).json({ error: `AI call failed: ${geminiErr.message}` });
    }
  } catch (err) {
    console.error('AI assistant error:', err);
    res.status(500).json({ error: 'Server error processing academic question.' });
  }
});

// Timetable AI importer endpoint
router.post('/import-timetable', authenticateToken, upload.single('timetable'), async (req, res) => {
  const { branch, semester } = req.body;
  const file = req.file;

  if (!branch || !semester) {
    return res.status(400).json({ error: 'Branch and semester are required.' });
  }

  if (!file) {
    return res.status(400).json({ error: 'Timetable file (image or PDF) is required.' });
  }

  try {
    const userRow = await dbGet('SELECT gemini_api_key FROM users WHERE id = ?', [req.userId]);
    const userGeminiKey = (userRow && userRow.gemini_api_key) ? userRow.gemini_api_key.trim() : null;
    const systemKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    const apiKey = userGeminiKey || systemKey;

    if (!apiKey) {
      return res.status(400).json({ error: 'GEMINI_KEY_MISSING', message: 'Power your Campusly AI: Connect your own Gemini API key to use AI features.' });
    }

    const extractedData = await extractTimetableWithGemini(
      file.buffer,
      file.mimetype,
      branch,
      semester,
      apiKey
    );
    res.json({ classes: extractedData });
  } catch (err) {
    console.error('AI Timetable extraction error:', err);
    res.status(500).json({ error: `Failed to parse timetable: ${err.message}` });
  }
});

export default router;
