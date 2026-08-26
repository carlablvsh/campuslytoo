import express from 'express';
import { dbAll } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// Helper: Tokenize text into alphanumeric words
function getWords(text) {
  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2);
}

// REST Client fetch fallback for Gemini API
async function askGemini(question, contexts, history, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
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

    // 4. Synthesize response
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
    const sources = Array.from(new Set(topChunks.map(c => JSON.stringify({
      id: c.noteId,
      title: c.noteTitle,
      subjectName: c.subjectName,
      color: c.color
    })))).map(s => JSON.parse(s));

    const deepSeekKey = DEEPSEEK_API_KEY || (GEMINI_API_KEY && GEMINI_API_KEY.startsWith('sk-') ? GEMINI_API_KEY : null);

    if (deepSeekKey) {
      try {
        const deepseekAnswer = await askDeepSeek(question, topChunks, history, deepSeekKey);
        return res.json({
          answer: deepseekAnswer,
          sources
        });
      } catch (deepseekErr) {
        console.error('DeepSeek API call failed, falling back to local indexing:', deepseekErr);
      }
    } else if (GEMINI_API_KEY) {
      try {
        const geminiAnswer = await askGemini(question, topChunks, history, GEMINI_API_KEY);
        return res.json({
          answer: geminiAnswer,
          sources
        });
      } catch (geminiErr) {
        console.error('Gemini API call failed, falling back to local indexing:', geminiErr);
      }
    }

    // Local Synthesis (Offline Fallback Mode)
    if (topChunks.length === 0) {
      return res.json({
        answer: `Hi there! I'm Campusly, your friendly AI study buddy! 🌸\n\nI'm currently running in **offline fallback mode** and couldn't find any relevant lecture notes to answer you locally.\n\nTo unlock my full conversational intelligence (like chatting like a real friend or helping you with detailed topics), ask your administrator to configure a \`DEEPSEEK_API_KEY\` or \`GEMINI_API_KEY\`!`,
        sources: []
      });
    }

    let localAnswer = `### Search Results from Study Notes\n\nI found the following matching information in your notes:\n\n`;
    topChunks.forEach((chunk, index) => {
      let textHighlighted = chunk.chunkText;
      queryWords.forEach(qw => {
        const escapedWord = qw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const r = new RegExp(`\\b(${escapedWord})\\b`, 'gi');
        textHighlighted = textHighlighted.replace(r, '**$1**');
      });
      localAnswer += `**From "${chunk.noteTitle}" (${chunk.subjectName})**:\n> ${textHighlighted}\n\n`;
    });

    localAnswer += `\n*Note: Set the \`DEEPSEEK_API_KEY\` or \`GEMINI_API_KEY\` environment variable in the backend to enable full AI conversational summaries.*`;

    res.json({
      answer: localAnswer,
      sources
    });

  } catch (err) {
    console.error('AI assistant error:', err);
    res.status(500).json({ error: 'Server error processing academic question.' });
  }
});

export default router;
