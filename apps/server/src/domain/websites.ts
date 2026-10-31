import { z } from 'zod';

/** Most websites one organization or project keeps. */
export const MAX_WEBSITES = 20;

/**
 * One labelled URL. Only http: and https:, because the web app renders it as a link:
 * a javascript: or data: URL must never reach an href. Internal hosts (http://intranet) are fine.
 */
export const website = z.object({
  label: z.string().trim().max(40, 'Keep the label to 40 characters, e.g. "Staging"').default(''),
  url: z
    .url({
      protocol: /^https?$/,
      error: 'Use a URL that starts with https:// or http://',
    })
    .trim()
    .max(2000, 'Use a URL of at most 2000 characters'),
});

export const websites = z
  .array(website)
  .max(MAX_WEBSITES, `Add at most ${MAX_WEBSITES} websites`);
