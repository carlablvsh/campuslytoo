import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { initDB } from './db.js';

// Route imports
import authRoutes from './routes/auth.js';
import dashboardRoutes from './routes/dashboard.js';
import academicRoutes from './routes/academic.js';
import notesRoutes from './routes/notes.js';
import aiRoutes from './routes/ai.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Setup database tables
await initDB();

// Middleware
app.use(cors({
  origin: '*', // Allow all client connections for simple local running
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());

// Serve uploads folder statically (for attachments access if needed)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Register API Routes
app.use('/api/auth', authRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/academic', academicRoutes);
app.use('/api/notes', notesRoutes);
app.use('/api/ai', aiRoutes);

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
