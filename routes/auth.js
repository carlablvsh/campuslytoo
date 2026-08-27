import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { dbRun, dbGet, dbAll } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';
import { loginLimiter } from '../middleware/rateLimit.js';
import { sendVerificationOTPEmail, sendResetPasswordEmail } from '../utils/email.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadDir = process.env.VERCEL 
  ? '/tmp/uploads' 
  : path.join(__dirname, '..', 'uploads');

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

    // Generate 6-digit numeric OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = Date.now() + 10 * 60 * 1000; // 10 minutes
    const now = Date.now();

    // Insert user into database (unverified by default)
    await dbRun(
      'INSERT INTO users (id, username, email, password_hash, is_verified, otp_code, otp_expires_at, otp_last_sent_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)',
      [userId, username, email, passwordHash, otpCode, otpExpires, now]
    );

    // Send verification email with 6-digit OTP
    await sendVerificationOTPEmail(email, otpCode);

    res.status(201).json({
      message: 'Account created successfully! Please enter the 6-digit verification code sent to your email.',
      requiresVerification: true,
      email
    });
  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).json({ error: 'Server error during registration.' });
  }
});

// Verify 6-digit OTP Route
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    return res.status(400).json({ error: 'Email and 6-digit verification code are required.' });
  }

  try {
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    // If user is already verified, allow login immediately
    if (user.is_verified === 1) {
      const token = jwt.sign({ userId: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
      return res.json({
        message: 'Account is already verified.',
        token,
        user: {
          id: user.id,
          username: user.username,
          email: user.email,
          avatar_url: user.avatar_url,
          hasGeminiKey: !!user.gemini_api_key
        }
      });
    }

    // Validate OTP Code
    const cleanOtp = String(otp).trim();
    if (!user.otp_code || user.otp_code !== cleanOtp) {
      return res.status(400).json({ error: 'Invalid 6-digit verification code. Please check your email and try again.' });
    }

    // Check expiration
    if (!user.otp_expires_at || Date.now() > user.otp_expires_at) {
      return res.status(400).json({ error: 'Verification code has expired. Please click "Resend Code" to receive a new code.' });
    }

    // Update user as verified and clear OTP
    await dbRun(
      'UPDATE users SET is_verified = 1, otp_code = NULL, otp_expires_at = NULL WHERE id = ?',
      [user.id]
    );

    // Generate JWT token
    const token = jwt.sign({ userId: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      message: 'Email verified successfully! Welcome to Campusly.',
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        hasGeminiKey: !!user.gemini_api_key
      }
    });
  } catch (err) {
    console.error('Verify OTP error:', err);
    res.status(500).json({ error: 'Server error verifying code.' });
  }
});

// Resend OTP Route with Rate Limiting (60 Seconds)
router.post('/resend-otp', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    const user = await dbGet('SELECT * FROM users WHERE email = ?', [email]);
    if (!user) {
      return res.status(404).json({ error: 'User account not found.' });
    }

    if (user.is_verified === 1) {
      return res.status(400).json({ error: 'Account is already verified. You can sign in directly.' });
    }

    // Enforce 60-second rate limit
    const now = Date.now();
    if (user.otp_last_sent_at && (now - user.otp_last_sent_at) < 60000) {
      const waitSeconds = Math.ceil((60000 - (now - user.otp_last_sent_at)) / 1000);
      return res.status(429).json({ 
        error: `Please wait ${waitSeconds} seconds before requesting a new code.`,
        retryAfterSeconds: waitSeconds
      });
    }

    // Generate fresh 6-digit OTP
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const otpExpires = now + 10 * 60 * 1000; // 10 minutes

    await dbRun(
      'UPDATE users SET otp_code = ?, otp_expires_at = ?, otp_last_sent_at = ? WHERE id = ?',
      [otpCode, otpExpires, now, user.id]
    );

    // Send email
    await sendVerificationOTPEmail(email, otpCode);

    res.json({ message: 'A new 6-digit verification code has been sent to your email.' });
  } catch (err) {
    console.error('Resend OTP error:', err);
    res.status(500).json({ error: 'Server error sending verification code.' });
  }
});

// Login Route
router.post('/login', loginLimiter, async (req, res) => {
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

    // Check email verification status
    if (user.is_verified === 0) {
      const now = Date.now();

      // Auto resend OTP if expired or last sent over 60s ago
      if (!user.otp_last_sent_at || (now - user.otp_last_sent_at) >= 60000) {
        const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
        const otpExpires = now + 10 * 60 * 1000;
        await dbRun(
          'UPDATE users SET otp_code = ?, otp_expires_at = ?, otp_last_sent_at = ? WHERE id = ?',
          [otpCode, otpExpires, now, user.id]
        );
        await sendVerificationOTPEmail(user.email, otpCode);
      }

      return res.status(403).json({
        error: 'Your email address is not verified yet. A verification code has been sent to your email.',
        requiresVerification: true,
        email: user.email
      });
    }

    // Generate JWT
    const token = jwt.sign({ userId: user.id, username: user.username, email: user.email }, JWT_SECRET, { expiresIn: '7d' });

    res.json({
      token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        hasGeminiKey: !!user.gemini_api_key
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
    const user = await dbGet('SELECT id, username, email, avatar_url, gemini_api_key FROM users WHERE id = ?', [req.userId]);
    if (!user) {
      return res.status(404).json({ error: 'User not found.' });
    }
    res.json({ 
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        avatar_url: user.avatar_url,
        hasGeminiKey: !!user.gemini_api_key
      }
    });
  } catch (err) {
    console.error('Fetch profile error:', err);
    res.status(500).json({ error: 'Server error fetching user profile.' });
  }
});

// Save or Update Gemini API Key (Authenticated)
router.post('/gemini-key', authenticateToken, async (req, res) => {
  const { gemini_api_key } = req.body;

  if (gemini_api_key === undefined) {
    return res.status(400).json({ error: 'gemini_api_key is required.' });
  }

  try {
    const keyToSave = gemini_api_key ? gemini_api_key.trim() : null;
    await dbRun('UPDATE users SET gemini_api_key = ? WHERE id = ?', [keyToSave, req.userId]);
    res.json({ message: 'Gemini API key updated successfully.', hasGeminiKey: !!keyToSave });
  } catch (err) {
    console.error('Update Gemini key error:', err);
    res.status(500).json({ error: 'Server error updating Gemini key.' });
  }
});

// Remove Gemini API Key (Authenticated)
router.delete('/gemini-key', authenticateToken, async (req, res) => {
  try {
    await dbRun('UPDATE users SET gemini_api_key = NULL WHERE id = ?', [req.userId]);
    res.json({ message: 'Gemini API key removed successfully.', hasGeminiKey: false });
  } catch (err) {
    console.error('Delete Gemini key error:', err);
    res.status(500).json({ error: 'Server error removing Gemini key.' });
  }
});

// Upload Profile Picture (Authenticated)
router.post('/avatar', authenticateToken, (req, res, next) => {
  upload.single('avatar')(req, res, (err) => {
    if (err) {
      return res.status(400).json({ error: err.message || 'Image upload failed.' });
    }
    next();
  });
}, async (req, res) => {
  const file = req.file;
  if (!file) {
    return res.status(400).json({ error: 'Please upload an image file.' });
  }

  try {
    // Read the file data and convert to base64
    const fileData = fs.readFileSync(file.path);
    const base64Image = fileData.toString('base64');
    const avatarUrl = `data:${file.mimetype};base64,${base64Image}`;

    // Update avatar_url in the database
    await dbRun('UPDATE users SET avatar_url = ? WHERE id = ?', [avatarUrl, req.userId]);

    // Delete the temp file from disk
    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    const updatedUser = await dbGet('SELECT id, username, email, avatar_url FROM users WHERE id = ?', [req.userId]);
    res.json({ user: updatedUser });
  } catch (err) {
    console.error('Upload avatar error:', err);
    if (file && fs.existsSync(file.path)) {
      try {
        fs.unlinkSync(file.path);
      } catch (unlinkErr) {
        // ignore
      }
    }
    res.status(500).json({ error: err.message || 'Server error uploading profile picture.' });
  }
});

// Forgot Password Route
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({ error: 'Email is required.' });
  }

  try {
    const user = await dbGet('SELECT id FROM users WHERE email = ?', [email]);
    
    // Always return a success message to prevent user enumeration
    const successMsg = 'If this email exists in our system, we have sent a password reset code to it.';
    if (!user) {
      return res.json({ message: successMsg });
    }

    // Generate secure random token AND 6-digit OTP
    const token = crypto.randomBytes(20).toString('hex');
    const otpCode = Math.floor(100000 + Math.random() * 900000).toString();
    const expires = Date.now() + 3600000; // 1 hour validity

    await dbRun('UPDATE users SET reset_token = ?, reset_token_expires = ?, otp_code = ? WHERE id = ?', [token, expires, otpCode, user.id]);

    // Send the email using the SMTP service
    await sendResetPasswordEmail(email, token, otpCode);

    res.json({ message: successMsg });
  } catch (err) {
    console.error('Forgot password error:', err);
    res.status(500).json({ error: 'Server error handling password reset request.' });
  }
});

// Reset Password Route
router.post('/reset-password', async (req, res) => {
  const { email, token, newPassword } = req.body;

  if (!token || !newPassword) {
    return res.status(400).json({ error: 'Reset token/code and new password are required.' });
  }

  if (newPassword.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters long.' });
  }

  try {
    const cleanToken = String(token).trim();
    
    // Search user by reset_token OR otp_code
    let user = await dbGet(
      'SELECT id, reset_token_expires FROM users WHERE reset_token = ? OR otp_code = ?',
      [cleanToken, cleanToken]
    );

    if (!user && email) {
      user = await dbGet(
        'SELECT id, reset_token_expires FROM users WHERE email = ? AND (reset_token = ? OR otp_code = ?)',
        [email, cleanToken, cleanToken]
      );
    }

    if (!user) {
      return res.status(400).json({ error: 'Password reset code or token is invalid.' });
    }

    const now = Date.now();
    if (!user.reset_token_expires || user.reset_token_expires < now) {
      return res.status(400).json({ error: 'Password reset code has expired. Please request a new one.' });
    }

    // Hash and store the new password
    const salt = await bcrypt.genSalt(10);
    const passwordHash = await bcrypt.hash(newPassword, salt);

    // Update password and clear single-use reset fields
    await dbRun(
      'UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL, otp_code = NULL WHERE id = ?',
      [passwordHash, user.id]
    );

    res.json({ message: 'Password has been reset successfully. You can now log in.' });
  } catch (err) {
    console.error('Reset password error:', err);
    res.status(500).json({ error: 'Server error resetting password.' });
  }
});

// Delete Account (Authenticated)
router.delete('/account', authenticateToken, async (req, res) => {
  try {
    await dbRun('PRAGMA foreign_keys = ON;');
    
    // First, let's select and delete note files from the disk
    const userNotes = await dbAll('SELECT file_name FROM notes WHERE user_id = ?', [req.userId]);
    for (const note of userNotes) {
      const filePath = path.join(uploadDir, note.file_name);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    }
    
    // Delete the user from the database. Cascade will clean up everything else!
    await dbRun('DELETE FROM users WHERE id = ?', [req.userId]);

    res.json({ message: 'Account and all associated data deleted successfully.' });
  } catch (err) {
    console.error('Delete account error:', err);
    res.status(500).json({ error: 'Server error deleting account.' });
  }
});

export default router;
