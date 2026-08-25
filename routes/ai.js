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
async function askGemini(question, contexts, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  
  const formattedContexts = contexts.map((c, i) => 
    `[Source Note ${i + 1}]: "${c.noteTitle}" (Subject: ${c.subjectName})\nContent:\n${c.chunkText}`
  ).join('\n\n---\n\n');

  const prompt = `You are Campusly, a helpful student AI academic companion.
Your goal is to answer the user's question using the provided context notes extracted from their study materials.

Guidelines:
1. Try to answer the question as accurately as possible using only the provided notes.
2. If the notes don't contain the answer, answer using general academic knowledge, but clearly state that this information was not in their uploaded notes.
3. Keep your response concise, well-structured, and use Markdown for readability (bullet points, bold text).
4. Explicitly cite which notes you used at the very bottom of your response (e.g. "Sources: [Note Name]").

Context study materials:
${formattedContexts}

User Question: "${question}"`;

  const payload = {
    contents: [
      {
        parts: [
          { text: prompt }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.3,
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

// Ask AI endpoint
router.post('/ask', authenticateToken, async (req, res) => {
  const { question, subject_id } = req.body;

  if (!question) {
    return res.status(400).json({ error: 'Question is required.' });
  }

  try {
    // 1. Fetch user notes
    let notes;
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

    if (notes.length === 0) {
      return res.json({
        answer: `I couldn't find any uploaded notes. Please upload text, markdown, or PDF files in the **Notes** page first so I can assist you with your academic work!`,
        sources: []
      });
    }

    // 2. Chunk documents and build search index
    const chunks = [];
    notes.forEach(note => {
      // Split note into paragraphs
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

    // 3. Score chunks against the query keywords
    const queryWords = getWords(question);
    if (queryWords.length === 0) {
      return res.status(400).json({ error: 'Please enter a more descriptive question.' });
    }

    const scoredChunks = chunks.map(chunk => {
      const chunkWords = getWords(chunk.chunkText);
      let score = 0;
      
      // Count frequency of query words inside chunk
      queryWords.forEach(qw => {
        const count = chunkWords.filter(cw => cw === qw).length;
        score += count;
      });

      return { ...chunk, score };
    }).filter(c => c.score > 0);

    // Sort by descending score
    scoredChunks.sort((a, b) => b.score - a.score);
    const topChunks = scoredChunks.slice(0, 3);

    // 4. Synthesize response
    const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
    const sources = Array.from(new Set(topChunks.map(c => JSON.stringify({
      id: c.noteId,
      title: c.noteTitle,
      subjectName: c.subjectName,
      color: c.color
    })))).map(s => JSON.parse(s));

    if (topChunks.length === 0) {
      return res.json({
        answer: `I scanned all your study materials for "${question}" but couldn't find any matching topics.\n\nTry rephrasing your question or uploading additional lecture notes/materials related to this topic.`,
        sources: []
      });
    }

    if (GEMINI_API_KEY) {
      try {
        const geminiAnswer = await askGemini(question, topChunks, GEMINI_API_KEY);
        return res.json({
          answer: geminiAnswer,
          sources
        });
      } catch (geminiErr) {
        console.error('Gemini API call failed, falling back to local indexing:', geminiErr);
        // Fallback to local response below
      }
    }

    // Local Synthesis (Offline Fallback Mode)
    let localAnswer = `### Search Results from Study Notes\n\nI found the following matching information in your notes:\n\n`;
    
    topChunks.forEach((chunk, index) => {
      // Highlight query words in the text for premium UX
      let textHighlighted = chunk.chunkText;
      queryWords.forEach(qw => {
        // Safe regex escape
        const escapedWord = qw.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const r = new RegExp(`\\b(${escapedWord})\\b`, 'gi');
        textHighlighted = textHighlighted.replace(r, '**$1**');
      });

      localAnswer += `**From "${chunk.noteTitle}" (${chunk.subjectName})**:\n> ${textHighlighted}\n\n`;
    });

    localAnswer += `\n*Note: Set the \`GEMINI_API_KEY\` environment variable in the backend to enable full AI conversational summaries.*`;

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
