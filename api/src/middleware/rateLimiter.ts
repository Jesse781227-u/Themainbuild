import rateLimit from 'express-rate-limit';
import {config} from '../config';

// Webhooks are exempt: Meta and the payment provider deliver from a small pool of shared IPs, so a
// per-IP limit would reject legitimate bursts. Those routes are protected by signature checks instead.
export const isWebhookPath = (path: string) => path.startsWith('/api/v1/webhooks/');
export const generalLimiter = rateLimit({windowMs: config.RATE_LIMIT_WINDOW_MS, max: config.RATE_LIMIT_MAX, standardHeaders: true, legacyHeaders: false, skip: req => isWebhookPath(req.path)});
