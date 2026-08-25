import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'campusly_fallback_jwt_secret_key_13579';

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  // Token could be "Bearer <token>"
  const token = authHeader && authHeader.split(' ')[1];

  if (!token) {
    return res.status(401).json({ error: 'Access token missing or invalid.' });
  }

  jwt.verify(token, JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Token is expired or invalid.' });
    }
    
    req.userId = decoded.userId;
    next();
  });
};
