import express from 'express';
import { dbGet, dbRun } from '../db.js';
import { authenticateToken } from '../middleware/auth.js';

const router = express.Router();

// GET /spotify/config - get client id
router.get('/config', authenticateToken, (req, res) => {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    return res.status(500).json({ error: 'Spotify Client ID is not configured on the server.' });
  }
  res.json({ clientId });
});

// POST /spotify/exchange - exchange code for tokens using PKCE
router.post('/exchange', authenticateToken, async (req, res) => {
  const { code, code_verifier, redirect_uri } = req.body;
  const clientId = process.env.SPOTIFY_CLIENT_ID;

  if (!code || !code_verifier || !redirect_uri) {
    return res.status(400).json({ error: 'code, code_verifier, and redirect_uri are required.' });
  }

  if (!clientId) {
    return res.status(500).json({ error: 'Spotify Client ID is not configured on the server.' });
  }

  try {
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('grant_type', 'authorization_code');
    params.append('code', code);
    params.append('redirect_uri', redirect_uri);
    params.append('code_verifier', code_verifier);

    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!tokenResponse.ok) {
      const errText = await tokenResponse.text();
      console.error('Spotify token exchange failed:', errText);
      return res.status(tokenResponse.status).json({ error: `Spotify token exchange failed: ${errText}` });
    }

    const tokenData = await tokenResponse.json();
    const { access_token, refresh_token, expires_in } = tokenData;

    // Calculate expiry timestamp (in seconds)
    const expiresAt = Math.floor(Date.now() / 1000) + expires_in;

    // Save tokens in users table
    await dbRun(
      'UPDATE users SET spotify_access_token = ?, spotify_refresh_token = ?, spotify_token_expires_at = ? WHERE id = ?',
      [access_token, refresh_token, expiresAt, req.userId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('Spotify token exchange error:', err);
    res.status(500).json({ error: 'Internal server error during Spotify token exchange.' });
  }
});

// GET /spotify/token - get a valid, active access token for the user
router.get('/token', authenticateToken, async (req, res) => {
  try {
    const user = await dbGet(
      'SELECT spotify_access_token, spotify_refresh_token, spotify_token_expires_at FROM users WHERE id = ?',
      [req.userId]
    );

    if (!user || !user.spotify_refresh_token) {
      return res.json({ connected: false });
    }

    const now = Math.floor(Date.now() / 1000);
    
    // If the token is not expired (we check if it expires in more than 60 seconds), return it
    if (user.spotify_access_token && user.spotify_token_expires_at && user.spotify_token_expires_at > now + 60) {
      return res.json({ connected: true, accessToken: user.spotify_access_token });
    }

    // Otherwise, we perform the refresh token flow
    const clientId = process.env.SPOTIFY_CLIENT_ID;
    if (!clientId) {
      return res.status(500).json({ error: 'Spotify Client ID is not configured on the server.' });
    }

    console.log('Refreshing Spotify token for user:', req.userId);
    const params = new URLSearchParams();
    params.append('client_id', clientId);
    params.append('grant_type', 'refresh_token');
    params.append('refresh_token', user.spotify_refresh_token);

    const refreshResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });

    if (!refreshResponse.ok) {
      const errText = await refreshResponse.text();
      console.error('Spotify token refresh failed:', errText);
      
      // If refresh token is rejected, we assume it's revoked or invalid, so clear authorization
      if (refreshResponse.status === 400 || refreshResponse.status === 401) {
        await dbRun(
          'UPDATE users SET spotify_access_token = NULL, spotify_refresh_token = NULL, spotify_token_expires_at = NULL WHERE id = ?',
          [req.userId]
        );
        return res.json({ connected: false });
      }

      return res.status(refreshResponse.status).json({ error: `Spotify token refresh failed: ${errText}` });
    }

    const refreshData = await refreshResponse.json();
    const newAccessToken = refreshData.access_token;
    
    // Some responses include a new refresh token, fallback to the old one if not present
    const newRefreshToken = refreshData.refresh_token || user.spotify_refresh_token;
    const newExpiresIn = refreshData.expires_in;
    const newExpiresAt = Math.floor(Date.now() / 1000) + newExpiresIn;

    // Update database
    await dbRun(
      'UPDATE users SET spotify_access_token = ?, spotify_refresh_token = ?, spotify_token_expires_at = ? WHERE id = ?',
      [newAccessToken, newRefreshToken, newExpiresAt, req.userId]
    );

    res.json({ connected: true, accessToken: newAccessToken });
  } catch (err) {
    console.error('Spotify get token error:', err);
    res.status(500).json({ error: 'Internal server error retrieving Spotify token.' });
  }
});

// POST /spotify/disconnect - clear authorization
router.post('/disconnect', authenticateToken, async (req, res) => {
  try {
    await dbRun(
      'UPDATE users SET spotify_access_token = NULL, spotify_refresh_token = NULL, spotify_token_expires_at = NULL WHERE id = ?',
      [req.userId]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Spotify disconnect error:', err);
    res.status(500).json({ error: 'Internal server error disconnecting Spotify.' });
  }
});

export default router;
