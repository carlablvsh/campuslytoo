import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB, dbGet } from './db.js';
import { authenticateToken } from './middleware/auth.js';
import fs from 'fs';
import jwt from 'jsonwebtoken';

// Route imports
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import academicRoutes from './routes/academic.js';
import notesRoutes from './routes/notes.js';
import aiRoutes from './routes/ai.js';
import notificationsRoutes from './routes/notifications.js';
import spotifyRoutes from './routes/spotify.js';
import gamificationRoutes from './routes/gamification.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Setup database tables
await initDB();

// Middleware
const clientUrl = process.env.CLIENT_URL || '*';
app.use(cors({
  origin: clientUrl,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve uploads folder with strict user-ownership checks and path-traversal protection
app.get('/uploads/:filename', async (req, res) => {
  try {
    const { filename } = req.params;
    const safeFilename = path.basename(filename);
    
    const uploadsDir = process.env.VERCEL ? '/tmp/uploads' : path.join(__dirname, 'uploads');
    const filePath = path.join(uploadsDir, safeFilename);
    
    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found.' });
    }

    // Public / general access for user avatars
    if (safeFilename.startsWith('avatar-')) {
      return res.sendFile(filePath);
    }
    
    // Authenticated access check for notes: manually check JWT token
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
      return res.status(401).json({ error: 'Access denied: Session required for documents.' });
    }
    
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fallback_secret_key');
      
      const note = await dbGet('SELECT user_id FROM notes WHERE file_name = ?', [safeFilename]);
      if (!note) {
        return res.status(403).json({ error: 'Access denied: File metadata mismatch.' });
      }
      
      if (note.user_id !== decoded.userId) {
        return res.status(403).json({ error: 'Access denied: You do not own this document.' });
      }
      
      res.sendFile(filePath);
    } catch (err) {
      return res.status(403).json({ error: 'Access denied: Invalid session token.' });
    }
  } catch (err) {
    console.error('File serving error:', err);
    res.status(500).json({ error: 'Error fetching requested resource.' });
  }
});

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/academic', academicRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/spotify', spotifyRoutes);
app.use('/api/gamification', gamificationRoutes);

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', message: 'Campusly API Server is running.', timestamp: new Date() });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Express global error handler:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`================================================`);
  console.log(` Campusly server is online!`);
  console.log(` Port: ${PORT}`);
  console.log(` API Endpoint: http://localhost:${PORT}/api`);
  console.log(`================================================`);
});

export default app;
