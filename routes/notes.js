import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { dbAll, dbGet, dbRun } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = express.Router();

// Ensure uploads folder exists
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Multer Config
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 } // 5MB limit
});

// Helper: Extract text from various files
function extractTextFromFile(filePath, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  
  if (['.txt', '.md', '.markdown', '.html', '.css', '.js', '.csv', '.json'].includes(ext)) {
    return fs.readFileSync(filePath, 'utf8');
  }

  if (ext === '.pdf') {
    try {
      const buffer = fs.readFileSync(filePath);
      const dataString = buffer.toString('binary');
      
      // Resilient simple PDF text extractor
      // PDFs store text in streams inside elements like (Text Here) Tj or (Text) Tj
      // We can use a regex to capture text inside parentheses
      const regex = /\(([^)]+)\)\s*(?:Tj|TJ)/g;
      let match;
      const textPieces = [];
      
      while ((match = regex.exec(dataString)) !== null) {
        // Unescape backslashes if present
        let cleanText = match[1].replace(/\\([0-3][0-7][0-7])/g, (m, octal) => {
          return String.fromCharCode(parseInt(octal, 8));
        }).replace(/\\/g, '');
        
        // Remove structural formatting
        if (cleanText.trim().length > 1) {
          textPieces.push(cleanText.trim());
        }
      }
      
      if (textPieces.length > 0) {
        return textPieces.join(' ');
      }
      
      // Fallback: extract any printable ascii strings from the raw binary
      const asciiRegex = /[\x20-\x7E\s]{4,}/g;
      const asciiPieces = dataString.match(asciiRegex) || [];
      return asciiPieces
        .map(s => s.trim())
        .filter(s => !s.startsWith('/') && !s.includes('%') && s.length > 5)
        .join(' ')
        .substring(0, 100000); // Caps it to avoid database bloating
        
    } catch (err) {
      console.error('PDF extraction failed, returning metadata fallback:', err);
      return `Uploaded PDF document: ${originalName}`;
    }
  }

  return `Uploaded file resource: ${originalName}`;
}

// 1. Get all notes for user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const notes = await dbAll(`
      SELECT n.id, n.subject_id, n.title, n.file_name, n.created_at,
             s.name as subject_name, s.code as subject_code, s.color as subject_color,
             LENGTH(n.content_extracted) as text_length
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      WHERE n.user_id = ?
      ORDER BY n.created_at DESC
    `, [req.userId]);

    res.json(notes);
  } catch (err) {
    console.error('Get notes error:', err);
    res.status(500).json({ error: 'Server error retrieving notes.' });
  }
});

// 2. Get single note content
router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const note = await dbGet(`
      SELECT n.*, s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      WHERE n.id = ? AND n.user_id = ?
    `, [req.params.id, req.userId]);

    if (!note) {
      return res.status(404).json({ error: 'Note not found.' });
    }

    res.json(note);
  } catch (err) {
    console.error('Get note details error:', err);
    res.status(500).json({ error: 'Server error retrieving note details.' });
  }
});

// 3. Create a raw text note manually
router.post('/', authenticateToken, async (req, res) => {
  const { subject_id, title, content } = req.body;

  if (!subject_id || !title || !content) {
    return res.status(400).json({ error: 'subject_id, title, and content are required.' });
  }

  try {
    // Verify subject ownership
    const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    const noteId = crypto.randomUUID();
    const fileName = `note-${noteId}.txt`;
    
    // Save to files folder
    const filePath = path.join(uploadDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');

    await dbRun(
      'INSERT INTO notes (id, user_id, subject_id, title, file_name, content_extracted) VALUES (?, ?, ?, ?, ?, ?)',
      [noteId, req.userId, subject_id, title, fileName, content]
    );

    const newNote = await dbGet(`
      SELECT n.id, n.subject_id, n.title, n.file_name, n.created_at,
             s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      WHERE n.id = ?
    `, [noteId]);

    res.status(201).json(newNote);
  } catch (err) {
    console.error('Create note error:', err);
    res.status(500).json({ error: 'Server error saving note.' });
  }
});

// 4. Upload file attachment note
router.post('/upload', authenticateToken, upload.single('file'), async (req, res) => {
  const { subject_id, title } = req.body;
  const file = req.file;

  if (!subject_id || !title || !file) {
    // Delete file if uploaded but validation failed
    if (file) {
      fs.unlinkSync(file.path);
    }
    return res.status(400).json({ error: 'subject_id, title, and file upload are required.' });
  }

  try {
    // Verify subject ownership
    const subject = await dbGet('SELECT id FROM subjects WHERE id = ? AND user_id = ?', [subject_id, req.userId]);
    if (!subject) {
      fs.unlinkSync(file.path);
      return res.status(404).json({ error: 'Subject not found or unauthorized.' });
    }

    // Extract content
    const extractedText = extractTextFromFile(file.path, file.originalname);

    const noteId = crypto.randomUUID();
    await dbRun(
      'INSERT INTO notes (id, user_id, subject_id, title, file_name, content_extracted) VALUES (?, ?, ?, ?, ?, ?)',
      [noteId, req.userId, subject_id, title, file.filename, extractedText]
    );

    const newNote = await dbGet(`
      SELECT n.id, n.subject_id, n.title, n.file_name, n.created_at,
             s.name as subject_name, s.code as subject_code, s.color as subject_color
      FROM notes n
      JOIN subjects s ON n.subject_id = s.id
      WHERE n.id = ?
    `, [noteId]);

    res.status(201).json(newNote);
  } catch (err) {
    console.error('Upload note error:', err);
    if (file && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    res.status(500).json({ error: 'Server error saving uploaded file.' });
  }
});

// 5. Delete note
router.delete('/:id', authenticateToken, async (req, res) => {
  try {
    const note = await dbGet('SELECT * FROM notes WHERE id = ? AND user_id = ?', [req.params.id, req.userId]);
    if (!note) {
      return res.status(404).json({ error: 'Note not found or unauthorized.' });
    }

    // Delete DB record
    await dbRun('DELETE FROM notes WHERE id = ?', [req.params.id]);

    // Delete file
    const filePath = path.join(uploadDir, note.file_name);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    res.json({ message: 'Note deleted successfully.' });
  } catch (err) {
    console.error('Delete note error:', err);
    res.status(500).json({ error: 'Server error deleting note.' });
  }
});

export default router;
