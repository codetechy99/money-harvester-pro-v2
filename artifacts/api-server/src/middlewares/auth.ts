import type { Request, Response, NextFunction } from "express";
import { findProfile, getConfig, hasSupabaseConfig } from "../lib/supabase";

export interface AuthenticatedRequest extends Request {
  authProfileId?: string;
  user?: { id: string; email?: string };
}

export async function requireAuth(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const apiKeyHeader = req.headers["x-api-key"];

    let profileId: string | undefined;

    if (authHeader && authHeader.startsWith("Bearer ")) {
      const token = authHeader.substring(7).trim();
      if (token) {
        if (hasSupabaseConfig()) {
          try {
            const { url, key } = getConfig();
            const authRes = await fetch(`${url}/auth/v1/user`, {
              headers: {
                apikey: key,
                Authorization: `Bearer ${token}`,
              },
            });
            if (authRes.ok) {
              const userData = (await authRes.json()) as { id?: string; email?: string };
              if (userData.id) {
                profileId = userData.id;
                req.user = { id: userData.id, email: userData.email };
              }
            }
          } catch {
            // Fallthrough to token validation
          }
        }
        if (!profileId) {
          if (hasSupabaseConfig()) {
            const profile = await findProfile(token);
            if (profile && profile.id) {
              profileId = String(profile.id);
            }
          } else {
            profileId = token;
          }
        }
      }
    } else if (typeof apiKeyHeader === "string" && apiKeyHeader.trim()) {
      const apiKey = apiKeyHeader.trim();
      if (process.env.API_SECRET_KEY && apiKey === process.env.API_SECRET_KEY) {
        const queryAcc = typeof req.query.accountId === "string" ? req.query.accountId.trim() : "";
        const bodyAcc = typeof req.body?.accountId === "string" ? req.body.accountId.trim() : "";
        const paramAcc = typeof req.params?.accountId === "string" ? req.params.accountId.trim() : "";
        profileId = queryAcc || bodyAcc || paramAcc || "system";
      } else if (hasSupabaseConfig()) {
        const profile = await findProfile(apiKey);
        if (profile && profile.id) {
          profileId = String(profile.id);
        }
      }
    }

    if (!profileId) {
      res.status(401).json({ error: "Authentication required: missing or invalid authorization token" });
      return;
    }

    req.authProfileId = profileId;
    next();
  } catch (error) {
    res.status(401).json({
      error: error instanceof Error ? error.message : "Authentication failed",
    });
  }
}

export async function requireAccountOwnership(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const targetAccountId =
    (typeof req.params.accountId === "string" && req.params.accountId.trim()) ||
    (typeof req.query.accountId === "string" && req.query.accountId.trim()) ||
    (typeof req.body?.accountId === "string" && req.body.accountId.trim());

  if (!targetAccountId) {
    res.status(400).json({ error: "Target account ID is required" });
    return;
  }

  if (!req.authProfileId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  if (req.authProfileId !== targetAccountId && req.authProfileId !== "system") {
    if (hasSupabaseConfig()) {
      const profile = await findProfile(req.authProfileId);
      if (!profile || (profile.id !== targetAccountId && profile.metaapi_account_id !== targetAccountId)) {
        res.status(403).json({ error: "Access denied: unauthorized account access" });
        return;
      }
    } else {
      res.status(403).json({ error: "Access denied: account ID mismatch" });
      return;
    }
  }

  next();
}
