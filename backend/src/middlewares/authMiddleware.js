// src/middlewares/authMiddleware.js
const jwt = require("jsonwebtoken");

// Verifies the Custom Backend JWT (issued by /api/auth/refresh)
exports.verifyBackendToken = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    return res
      .status(401)
      .json({ message: "No token provided", code: "NO_TOKEN" });
  }

  const token = authHeader.split(" ")[1];

  jwt.verify(
    token,
    process.env.BACKEND_JWT_SECRET,
    {
      issuer: "ypn-backend",
      audience: "ypn-app",
    },
    (err, decoded) => {
      if (err) {
        if (err.name === "TokenExpiredError") {
          return res
            .status(401)
            .json({ message: "Token expired", code: "TOKEN_EXPIRED" });
        }
        return res
          .status(403)
          .json({ message: "Invalid token", code: "INVALID_TOKEN" });
      }
      req.user = decoded; // Contains { sub, id, email, role, etc. }
      next();
    },
  );
};
