import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dbRun, dbGet } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'avatar-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB limit
  fileFilter: (req, file, cb) => {
    const filetypes = /jpeg|jpg|png|webp|gif/;
    const extname = filetypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = filetypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Only images (jpg, png, webp, gif) are allowed.'));
    }
  }
});

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'campusly_fallback_jwt_secret_key_13579';

// Register Route
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Username, email, and password are required.' });
  }

  try {
    // Check if user already exists
    const existingUser = await dbGet('SELECT * FROM users WHERE email = ? OR username = ?', [email, username]);
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists.' });
    }

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(password, salt);
    
    // Generate UUID
    const userId = crypto.randomUUID();

    // Insert user into database
    await dbRun(
      'INSERT INTO users (id, username, email, password_hash) VALUES (?, ?, ?, ?)',
      [userId, username, email, passwordHash]
    );

    // Generate JWT
    const token = jwt.sign({ userId }, JWT_SECRET, { expiresIn: '7d' });

    res.status(201).json({
      token,
      user: {
        id: userId,
        username,
        email,
        avatar_url: null
      }
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// Login Route
router.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    // Find user
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Compare passwords
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Invalid email or password.' });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user.id }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Server error during login.' });
  }
});

// Update Profile Username (Authenticated)
router.put('/profile', authenticateToken, async (req, res) => {
  const { username } = req.body;

  if (!username) {
    return res.status(400).json({ error: 'Username is required.' });
  }

  try {
    // Check if username is already taken by another user
    const existing = await dbGet('SELECT id FROM users WHERE username = ? AND id != ?', [username, req.userId]);
    if (existing) {
      return res.status(400).json({ error: 'Username is already taken.' });
    }

    await dbRun('UPDATE users SET username = ? WHERE id = ?', [username, req.userId]);

    const updatedUser = await dbGet('SELECT id, username, email, avatar_url FROM users WHERE id = ?', [req.userId]);
    res.json({ user: updatedUser });
  } catch (err) {
    console.error('Update profile error:', err);
    res.status(500).json({ error: 'Server error updating profile username.' });
  }
});

// Update Password (Authenticated)
router.put('/password', authenticateToken, async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: 'Current password and new password are required.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  }

  try {
    // Fetch current user hash
    const user = await dbGet('SELECT password_hash FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }

    // Match current password
    const isMatch = await bcrypt.compare(currentPassword, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ error: 'Incorrect current password.' });
    }

    // Hash and store new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    await dbRun('UPDATE users SET password_hash = ? WHERE id = ?', [passwordHash, req.userId]);

    res.json({ message: 'Password updated successfully.' });
  } catch (err) {
    console.error('Update password error:', err);
    res.status(500).json({ error: 'Server error updating password.' });
  }
});

// Get Current User Profile (Authenticated)
router.get('/me', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet('SELECT id, username, email, avatar_url FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ user });
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).json({ error: 'Server error fetching user profile.' });
  }
});

// Upload Profile Picture (Authenticated)
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Please upload an image file.' });
  }

  try {
    // Optionally delete previous avatar file from server disk to save space
    const oldUser = await dbGet('SELECT avatar_url FROM users WHERE id = ?', [req.userId]);
    if (oldUser && oldUser.avatar_url) {
      const oldFileName = oldUser.avatar_url.split('/uploads/')[1];
      if (oldFileName) {
        const oldFilePath = path.join(uploadDir, oldFileName);
        if (fs.existsSync(oldFilePath)) {
          fs.unlinkSync(oldFilePath);
        }
      }
    }

    const avatarUrl = `http://localhost:5000/uploads/${file.filename}`;
    await dbRun('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.userId]);

    const updatedUser = await dbGet('SELECT id, username, email, avatar_url FROM users WHERE id = ?', [req.userId]);
    res.json({ user: updatedUser });
  } catch (err) {
    console.error('Upload avatar error:', err);
    if (file && fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }
    res.status(500).json({ error: err.message || 'Server error uploading profile picture.' });
  }
});

export default router;
